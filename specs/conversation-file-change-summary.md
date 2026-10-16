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
  第二读取面，不是第二个真值来源——它在**成功且 `files > 0`** 时把结果补种回投影（见下节），
  使该轮收敛到与 hydrate 轮不可区分。`row.fileChanges` 与派生出的 `actions.canRewindFiles`
  的唯一所有者始终是 `ProductProjection`；gateway 只转交权威读取结果，不自算、不缓存第二份。

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

**注意区分两件事**：缺口清单本身依旧**不进 delta/revision**（静态只读索引）；按需读取补种出的
`fileChanges` 则是**真实投影变更，进 delta 投递**（见下节）。两者语义不同，不得混为一谈。

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

## 服务端补种（按需读取成功后回写投影）

客户端回填只解决**渲染**；「回退」按钮还要过服务端守卫。`resolveRowActionTarget` 里
`applyFileRewind` 与 `fileRewindPreview` 共用同一道守卫
（`!row.fileChanges || row.actions?.canRewindFiles !== true` → `guard.actionUnavailable`），
而 `canRewindFiles` 由 `materializeCommandRowActions` 从 `row.fileChanges?.state === "active"`
派生。缺口轮的投影 row 没有 `fileChanges`，所以前端就算点亮按钮、预览 RPC 也必被拒。**修复必须
落在服务端。**

**链路**：

```text
gateway.fileChanges ──► host.getConversationFileChanges（权威读取）
   └─ 成功且 files > 0 ──► publisher.seedAuthoritativeFileChanges(rowId, result)
        └─ projection.seedAuthoritativeFileChanges（候选投影原子归约）
             ├─ row.upserted（与 ModelComplete 归约同形状，含 state）
             ├─ materializeCommandRowActions（派生 canRewindFiles，同一次 materialization）
             └─ publisher.commitDeltas（与 ingest 同一条尾段：记账 + 扇出）
```

**为什么必须走 delta 广播**（不能像 `seedFileChangeSummaryUnavailable` 那样只改快照）：客户端
按钮门控读的是**它自己快照**里的 `header.actions.canRewindFiles`。只改服务端快照不推 delta，客户端
永远看不到，症状不会消失。而且本仓库原则是「UI action 可见性必须与服务端 target 可解析性属于同一次
materialization」，不能让前端自己猜能不能回退。

**seq 语义**：补种会把投影 seq 推进一格（`publisher` 分配并把新 seq 返回给 gateway，gateway 同步
自己的 transport 水位）。必须推进——客户端对 delta 帧有「`frame.toSeq <= 本地 seq` 即视为迟到/重复
帧静默丢弃」的规则（`conversationProjectionStore` 规则 2a），不推进的话补种帧会被客户端直接丢掉。
下一条 raw 事件的 transport seq 由 gateway 的偏移自校正顺延，不会与补种 seq 撞车。

**revision 语义（刻意 revision-neutral，不抬 revision）**：`row.upserted` 按常规则抬 revision，
但补种**不抬**，因为 revision 同时是客户端 query/command 的 `baseRevision` CAS 令牌
（`resolveQueryRowTarget` 里 `params.baseRevision !== snapshot.revision → proto.staleRevision`），
而补种是由**读** RPC（`v4/conversation/fileChanges`）触发的：

- CLI 严格串行派发请求（`zcode-protocol/transport.ts`，只有 session/stop 越队），同一客户端在同一
  批里为**多个**缺口轮发出的读，第一条补种后第二条的 `baseRevision` 必然陈旧 → 被 `proto.staleRevision`
  拒绝。客户端的回填 hook 只记 warn、不重试（effect 依赖不含 revision），于是那些轮**连胶囊都拿不到**
  ——比修复前更差。所以补种必须 revision-neutral，才能让同批所有缺口轮都成功。
- 投递可靠性不依赖 revision：靠 seq 推进 + 保留窗日志（resume/recovery 按 `entry.seq > base.seq`
  重放，补种 entry 的 seq 严格更大），客户端**不会**静默漏掉补种。
- 不抬 revision 不会放宽任何命令守卫：`resolveRowActionTarget` 的 guard 每次都在**当前**投影上重新
  派生，revision 只是「你的视图是否足够新」的活性信号。
- 订阅机制（`subscribe` / `reserveFlush` / `resyncReserved`）**完全不读 revision**，因此 delta 不带
  revision 一样被接受。

**幂等边界**：同一轮已有 `fileChanges`（hydrate 已写或已补种过）时直接返回 no-op（不占 seq、不抬
revision、不推 delta）。`conversationFileChanges` RPC 会被重复调用，重复补种必须无副作用。

**`files === 0` 或读取失败**：不补种，行为与现在完全一致。只有 `files > 0` 才补——与投影既有门
（`payload.fileChanges.files > 0`）一致，避免把「没改文件」说成可回退。

**字节记账**：与 `ingest` 同一条判据（`conversationRowDeltaGrowthUpperBound`，无法给上界时落回
精确测量），增长并入 `wireSnapshotBytesUpperBound`；超限则 fail-closed 不补种（这轮保持现状，
绝不会把快照推过 `logicalFrameAssemblyMaxBytes`）。

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
- 单测 `apps/zcode-cli/packages/bootstrap/test/fileChangeSummarySeed.test.ts`（服务端补种）：
  ① 补种后该轮 `actions.canRewindFiles === true`，且 `resolveRowActionTarget(rowId, "fileRewindPreview")`
  与 `applyFileRewind` 都返回 ok（补种前必须是 `guard.actionUnavailable`）；
  ② 补种走 delta 广播：订阅者 flush 出的帧带得到该 row，且 `frame.toSeq` 严格大于客户端水位；
  ③ 二次补种同一轮是 no-op（seq/revision 不变、摘要不被覆盖）；
  ④ 补种 revision-neutral：两个缺口轮在同一 `baseRevision` 下都能补种，且补种不抬 revision；
  ⑤ `files === 0` 不补种、`canRewindFiles` 保持缺席；
  ⑥ 已有 `fileChanges` 的轮不被补种覆盖；
  ⑦ 补种 delta 的 `conversationRowDeltaGrowthUpperBound` 存在且 ≥ 真实快照字节增长（16MiB 闸门
  不被算松）。
- 真实 `diff` 库的超时返回 `undefined` 行为已单独验证（见上）。
- `pnpm typecheck`、`apps/zcode-cli/packages/bootstrap` 的 `tsc --noEmit`、
  `pnpm lint`、`pnpm architecture:check --changed`、UI 与 bootstrap 全部测试均通过。
