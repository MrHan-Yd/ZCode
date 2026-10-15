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
- 真实 `diff` 库的超时返回 `undefined` 行为已单独验证（见上）。
- `pnpm typecheck`、`apps/zcode-cli/packages/bootstrap` 的 `tsc --noEmit`、
  `pnpm lint`、`pnpm architecture:check --changed`、bootstrap 全部测试均通过。
