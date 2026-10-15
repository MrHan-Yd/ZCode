# 会话每轮文件变更摘要（冷恢复与按需读取）

## 背景

「这一轮改了哪些文件、加了几行删了几行」在冷恢复时没有现成事实：`ModelComplete.fileChanges`
只存在于内存事件，而冷 merge 以持久 transcript 为正文权威时会压掉该事件。因此
`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/cold-file-change-summaries.ts` 依据
workspace checkpoint + artifact 重建摘要（`buildColdFileChangeSummaries`），再由
`transcript-hydration.ts` 合成同构 `ModelComplete`，最终落到投影的 `turnHeader.fileChanges`。

同一份证据另有一条按需路径：`readConversationFileChangesFromEvents` 供
`V4_METHODS.conversationFileChanges` 使用，按 `(rowId, entityId)` 拉某一轮的明细
（文件变更面板、assistant 预览卡片）。

## 归属与键

- **归属**：摘要按 **该轮的用户消息 id** 键控。写入侧 `emitFileMutationCheckpoint` 落的是
  `messageId: state.userMessageId`、`targetMessageId: 同一值`（`turn-tools.ts`）；读取侧
  `transcript-hydration.ts` 用 `summaries.get(String(message.info.id))`（用户消息）取值。
  两侧必须一致，改动任一侧都要同步另一侧。
- **状态所有者**：摘要由 host 在冷恢复时计算并写进投影；客户端只读。按需 RPC 是同一份证据的
  第二读取面，不是第二个真值来源。

## 产品规则

1. 摘要必须反映真实改动。**「算不出来」绝不允许被表示为「没有改动」。**
2. 单点失败只降级该文件/该轮，不得让整次 hydrate 失败——冷路径的失败会导致整个会话渲染为空。
3. 降级必须可观测（warn + 事件名），否则口径变化永远看不见。

## 失败语义

| 情况 | 行为 |
| --- | --- |
| artifact 读不到 / 解不开 | 跳过该轮摘要，`onArtifactError` 记 `zcode_protocol.v4.hydrate_file_changes_failed` |
| checkpoint 的 `targetMessageId ?? messageId` 不在本次 transcript 里 | 该轮无摘要（旧幽灵引用，按设计跳过） |
| 合并 before→after 差分不可得 | **退回逐次写入的 `structuredPatch` 与行数**，记 `zcode_protocol.v4.hydrate_file_changes_diff_unavailable` |

### 合并差分不可得：`diff` 的 timeout 语义

`diff@9` 的 `TimeoutOption` / `MaxEditLengthOption` 明确规定：命中预算时
`structuredPatch` **返回 `undefined`**（不是返回空 hunks）。已对真实构造验证：4000 行整段重写
+ `timeout: 100` 在 ~107ms 中止并返回 `undefined`；而「确实没改动」返回 `hunks: []`。

因此 `?.hunks ?? []` 会把两种语义完全不同的情况归并成同一个值，`countPatchLines` 得到
`{additions: 0, deletions: 0}`，且该 item 照常发出——消费方无法区分「没改」与「算不出」，UI 上
表现为一个确实被大改的文件显示 **+0 −0**、diff 面板为空。这是静默错值，不是缺失。

正确处置：`createFinalPatch` 原样透出 `undefined`，`aggregateWorkspaceCheckpoints` 在
`afterContent` 存在但合并差分为 `undefined` 时，改用逐次写入累计的
`fallbackAdditions` / `fallbackDeletions` 与 `entry.patches`——与 `afterContent` 缺失时同一口径。
代价是多次写入同一文件时行数为逐次相加（可能不等于净 before→after），这是该兜底路径既有的
既有口径，优于宣称 0。

## 缺口清单与按需回填

摘要算不出来时，那一轮**看不到也回退不了**文件变更——预览卡片只管 md/html 文件链接，救不了这条
路径。所以要让它可恢复。但客户端**无法自行判断该不该恢复**：

投影刻意在 `files === 0` 时不给 turnHeader 挂 `fileChanges`（`product-projection.ts` 的
`payload.fileChanges.files > 0` 门），于是「没有 fileChanges」既可能是真的没改文件，也可能是摘要
没算出来。所有看似可用的替代信号都是从这个缺失字段派生的（`canRewindFiles` ← `fileChanges.state
=== "active"`），按 `toolName` 猜「这轮写过文件」又是本协议明确要消灭的嗅探。因此若不做显式信号，
UI 只能对**每一个**没有 fileChanges 的轮发一次 RPC——那是个风暴，且绝大多数是白发的。

**信号**：`snapshot.fileChangeSummaryUnavailableTurnIds`（additive、optional，客户端拿到的 turnId
列表）。与 `sharedContextImport` 同类：静态只读派生元数据，**不进 delta/revision**，hydrate 时幂等
补种，因此它随首帧快照到达，不需要 delta 投递。

**链路**：

```text
bridge: onArtifactError(messageId) ──► fileChangeSummaryUnavailableMessageIds
   └─ loadPersistedEvents 返回值 ──► gateway.seedFileChangeSummaryUnavailable
        └─ publisher.seedFileChangeSummaryUnavailable ──► projection 解析 messageId → turnId
             └─ snapshot.fileChangeSummaryUnavailableTurnIds ──► 首帧快照 ──► UI
```

**投影的解析**（`seedFileChangeSummaryUnavailable`）留两条路径：`rowIdForMessageId`（普通轮有可见
user 行），以及直接按 turnId 命中（有持久消息的轮 productTurnId 就是该 messageId；model-only 轮没有
可见 user 行，只能这样兜）。解析不出来的 messageId 静默跳过——它本来就没有对应可见轮。

**客户端规则**（`useTurnFileChangeSummaryBackfill` + `turnFileChangeSummaryBackfillModel`）：仅当
「在缺口清单里 **且** header 没有 fileChanges **且** 轮已终态 **且** 具备 rowId/entityId **且** 宿主
提供取数能力」才发一次请求，复用既有 `conversationFileChanges` RPC 与 SessionPane 的
`fileChangesRequestCache`（终态结果按 logEpoch/rowId/entityId 缓存，虚拟行复挂载不重复取数）。

**不变量**：回填出来的轮必须与正常 hydrate 的轮不可区分——`files > 0` 时补 `state: "active"`（与投影
同口径），`files === 0` 不补 state（不把没改文件的轮说成可回退）。回填失败只记 warn，UI 保持「没有该
胶囊」，不抛。

## 接口

```ts
type CreateConsolidatedPatch = (
  path: string,
  beforeContent: string,
  afterContent: string,
) => DiffHunk[] | undefined;
```

`aggregateWorkspaceCheckpoints(checkpoints, readArtifact, createConsolidatedPatch?, onConsolidatedPatchUnavailable?)`
的 `createConsolidatedPatch` 默认值为真实的 `createFinalPatch`（带 `CONSOLIDATED_PATCH_TIMEOUT_MS`）。
两个导出入口 `buildColdFileChangeSummaries` / `readConversationFileChangesFromEvents` 各透传一对
可选注入点：`createConsolidatedPatch`（测试/闸门注入，与同签名的 `readArtifact` 端口同一风格）与
`onConsolidatedPatchUnavailable`（降级留痕，cold 侧接 `context.logger.warn`）。

## 验收

- 单测 `apps/zcode-cli/packages/bootstrap/test/coldFileChangeSummaryFallback.test.ts`：
  差分注入 `undefined` 时行数退回 stored patch（+2 −1，非 0/0）且留痕一次；差分可得时用合并结果
  且不留痕。
- 单测 `packages/ui/test/turnFileChangeSummaryBackfill.test.ts`：只有缺口清单里的终态轮才回填，
  不在清单里的轮/已有 hydration 摘要的轮/运行中的轮/缺定位或缺取数能力的轮一律不回填；结果映射
  在 `files > 0` 时补 `active`、`reverted` 原样保留、`files === 0` 不补 state。
- 真实 `diff` 库的超时返回 `undefined` 行为已单独验证（见上）。
- `pnpm typecheck`、`apps/zcode-cli/packages/bootstrap` 的 `tsc --noEmit`、
  `pnpm lint`、`pnpm architecture:check --changed`、UI 与 bootstrap 全部测试均通过。
