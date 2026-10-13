# 流式 mirror replay 字节增量记账

## 背景

`packages/desktop/src/main/taskRealtimeBus.ts` 的 `rememberReplayBatch` 在每次 flush 后调用
`replayBytes(batch.replay)`——对 replay 数组里**每个**历史事件重新 `JSON.stringify` 求和。
流式期间每次 flush 都全量重算，长任务下 replay 数组最多 60 个批次 × 每批次可达 512KiB，
累计是 O(批次²) 的重复序列化，主进程 CPU 在流式期间被白白占满。

另外 `flushBatch` 对同一 event 已有一次 `JSON.stringify(event).length`（单批超限判断），
`replayBytes` 又对同一对象再 stringify 一次——同对象同时刻重复序列化。

## 行为

- `PendingStreamBatch` 新增平行记账字段：`replayEventBytes: number[]`（与 `replay` 同索引
  同 shift）与 `replayBytesTotal: number`（当前总和）。
- `flushBatch` 把已测量的 `eventBytes` 传入 `rememberReplayBatch` 复用（消除第二次
  stringify）；push 时累加，shift 时同步扣减。
- 删除 `replayBytes()` 全量求和方法。
- `deliverOversizedStreamBatchFallback` 清空 replay 时同步清零记账。

## 不变量

- `replay` 数组本身的内容、顺序、淘汰语义（批次数 60 上限 + 512KiB 字节上限双阈值）不变。
- 字节数值与旧实现的 `replayBytes(replay)` 逐次相等（同一 JSON.stringify 的缓存复用）。
- `replayVisibleRunsToHost` / `getReplaySnapshotWatermark` 等读取路径不变。

## 失败语义

- 无新增失败路径；记账为纯内存算术。

## 验收

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
- 流式期间 main 进程不再每次 flush 重复序列化全部 replay 批次。
