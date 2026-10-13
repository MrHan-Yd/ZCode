# Publisher ingest 的行级增量字节记账

## 背景

`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/conversation-topic-publisher.ts`
的 `ingest` 里此前只有两条免序列化快路径：流式 append（`establishedStreamingAppend`）与纯 dwf
键级增量（`workflowRunDeltaGrowthUpperBound`）。两条都不命中时，回退到
`measureWireSnapshotBytes(getWireSnapshot(snapshot))` ——对整份 tail window 做 `JSON.stringify`。
每轮对话的行创建与工具状态推进都会落到这条回退路径，长会话下是 MB 级重复序列化。

## 行为

新增模块级函数 `conversationRowDeltaGrowthUpperBound(deltas, previousSnapshot)`，作为
judge 里的第二条快路径（在 dwf 键级判据之后、精确测量之前）：

| delta op | 增长上界 | 论证 |
| --- | --- | --- |
| `row.appended` | `utf8JsonByteLength(delta.row)` | 新内容全在载荷；wire 窗口挤头只会让增长更小；行被 profile 过滤则 wire 不变 |
| `row.upserted` | `max(0, newRow − 折叠后旧行)`（旧行按 `rowId` 在**批内折叠态**里查：批前快照 + 批内已 append/upsert 的行字节） | 替换语义；每次 upsert 折叠为「正向增量」，其和 ≥ 终态净增长（总变差 ≥ 净变化）；旧行不存在 = no-op，增长 0 |
| `row.delta` | `utf8JsonByteLength(delta.append)` | append 拼接的转义字节 ≤ 单独序列化（JSON 转义逐字符决定，无边界效应） |
| `row.removed` / `workflowRun.removed` | 0 | 只会让快照变小；刻意不下调 upsert 基线，只会高估（安全） |
| `workflowRun.updated` | `utf8JsonByteLength(delta)` | 键级整体替换，载荷即上界（与 dwf 快路径同一论证） |
| 仅含 `revision` 的 `state.updated` | 新/旧 revision 的十进制位数差（≤1） | `attachRevision` 注入的正是这条 op；它只替换一个标量 |
| 其它（空 patch，或含 `revision` 之外键的 `state.updated` 等） | `null` | 整键替换的旧值字节不在载荷里，必须精确测量 |

总余量每批一份 64B（`CONVERSATION_ROW_DELTA_ENVELOPE_SLACK_BYTES`），覆盖 JSON 外壳、
`seq` 与 `revision` 的十进制位数增长，与流式追加快路径（`+64`）同值同论证。

> 为何单列「仅含 revision 的 state.updated」：`product-projection.ts` 的 `attachRevision` 对
> **任何**抬 revision 的批次（含 `row.appended`/`row.upserted`/`row.removed`）都会在尾部追加
> 一条仅含 `revision` 的 `state.updated`。若它一律返回 null，则行创建/工具状态推进批次永远
> 落回精确测量——正是本改造声称要消除的部分。故按标量位数差计入（余量吸收）。

## 不变量与安全论证

- **发布内容不变**：upperBound 只影响 judge 选择哪条路径与记账值；deltas、事件顺序、
  下发内容与改动前逐项一致。
- **上界恒 ≥ 真实 wire 增长**：逐 op 论证见上表；`row.upserted` 的批内折算是「正向增量之和」，
  恒 ≥ 终态净增长；低估不会发生。judge 预算不足时自然落回精确测量并自校正
  `wireSnapshotBytesUpperBound`（原兜底路径原样保留）。
- **previousSnapshot 引用安全**：`applyEventAtomically` 在独立候选投影上归约
  （`cloneProjection` + `applyConversationDeltas` 不可变语义），应用前快照不被修改。
- **整键 `state.updated` 仍走精确测量**：不放宽既有 16MiB 闸门的正确性边界；只有 `revision`
  这一个标量自增享受上界。

## 所有权

- 记账函数是 publisher 的模块级实现（`conversationRowDeltaGrowthUpperBound`，包内导出仅供
  bootstrap 差分测试引用），不属于协议公共面，不进入 `@zcode/shared`。
- 差分护栏：`apps/zcode-cli/packages/bootstrap/test/conversationDeltaByteAccounting.test.ts`
  以「上界恒 ≥ 快照全量字节增长」为不变量做随机混合批次差分（200 轮，含挤头、no-op
  upsert、变小批次），并固定覆盖：批内 append→upsert / append→removed 同一行、仅 `revision`
  的 `state.updated`（给上界）、含其它键或空 patch 的 `state.updated`（返回 null）。
- wire 窗口选择逻辑（`getWireSnapshotForProfile`）不动：行级上界天然覆盖窗口语义
  （新行内容全在载荷、窗口最多挤掉旧行使增长更小），无需复刻过滤/截断逻辑。

## 验收

- 差分护栏用例全绿（含 200 轮随机混合批次）。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
- 长会话流式期间行创建/工具状态推进批次走快路径、不再触发整窗口 `JSON.stringify`
  （debug 日志/性能剖析核对）。
