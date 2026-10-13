# 流式 mirror 批次刷新延迟优化

## 背景

`packages/desktop/src/main/taskRealtimeBus.ts` 的流式 mirror 批处理此前使用
`STREAM_MIRROR_FLUSH_INTERVAL_MS = 1000`：非终态/非权限 op 一律累积到 1 秒定时器才
`flushBatch` 下发。LLM 流式 token 因此以 ≤1Hz 突发呈现，是桌面端「打字一顿一顿」的直接原因。

## 行为

- flush 间隔降为 **32ms**（≈30fps）：常规速度下打字流畅，同时保持每批内
  `coalesceOps` 对相邻 text_delta 的合并能力，IPC 频率可控。
- 新增积压阈值 **`STREAM_MIRROR_MAX_PENDING_OPS = 128`**：单批 `pendingOps` 达到上限立即
  flush（force），防止高速输出（大量 text_delta/tool_input_delta）时 UI 滞后超过一个
  定时周期。
- 终态/权限 op 仍为 immediate flush（不变）。

## 所有权与不变量

- Owner 不变：`taskRealtimeBus` 仍是 mirror 批次、seq、replay 的唯一所有者。
- `batchSeq`/`opSeq` 单调递增语义不变；coalesce 合并规则不变；
  `STREAM_MIRROR_MAX_BATCH_BYTES` 超限分片路径不变。
- owner 侧（desktop-continuous）**内容与顺序逐项不变**，只是到达时刻提前。
- **对 observer 恢复链路（web-remote-replayable）的已知影响**：内存 replay 的保留窗口按
  **批次数**封顶（`STREAM_MIRROR_MAX_REPLAY_BATCHES = 60`，另有 512KiB 字节上限）。flush 间隔
  从 1000ms 降到 32ms 后，60 批覆盖的**墙钟时长从约 60s 缩短到约 1.9s**（在批次数上限先于
  字节上限触发时）。晚于该窗口加入/激活的 host 在 `replayVisibleRunsToHost` 里
  `replay[0]?.fromSeq !== 1` 不再成立，会改走 `stream_mirror_gap` + 快照失效补齐。
  这是**恢复路径语义的变化**（更频繁地回落到快照），不是数据丢失：内容仍可由快照完整覆盖。
  两条链路的正确性语义未被破坏，但「只变下发时序」的说法仅对 owner 侧成立。

## 失败语义

- 定时器早 flush 不产生额外失败路径：`flushBatch(batchKey, force)` 的 force 分支已存在，
  与终态/权限 op 复用同一入口。

## 验收

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
- 人工验证：长回复流式输出打字连续，无明显 1Hz 顿挫。
- 恢复链路：晚于 ~2s 加入的 observer 走 `stream_mirror_gap` + 快照补齐，水位线正确、无内容缺口
  （需运行时验证）。

## 后续

- 若需保留原先量级的 observer replay 窗口，应将 replay 保留窗口与 flush 节奏解耦（按时间或
  「内容字节 + 每批固定开销」重新标定双阈值），而不是随 flush 频率线性缩小。
