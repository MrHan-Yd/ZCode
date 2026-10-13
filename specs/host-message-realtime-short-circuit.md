# Host 消息入口的 realtime 类型短路

## 背景

`packages/desktop/src/main/desktopHostProcess.ts` 的 `child.on("message")` 入口对每条 host
消息做 `hostResponseMessageSchema.safeParse`（全量 discriminated union 校验）。其中
realtime 类消息（`TaskStreamOpPublish`/`TaskRealtimePublish` 等 9 种类型）在该入口**解析
后无任何分支消费**——真正消费方是 `taskRealtimeBus.handleHostMessage`（独立注册的监听器），
它对同一条消息再做一次 `safeParse`。流式热路径（每个 stream chunk 一条
`TaskStreamOpPublish`）因此为同一条消息付两次全量 Zod 校验。

`packages/desktop/src/host/taskRealtimeBridge.ts` 的 `hostIncomingMessageSchema.safeParse`
在 host 进程、校验的是 main → host 下行消息（不同方向、不同 schema、进程边界），不在本
改动范围。

## 行为

desktopHostProcess 的 message handler 在 `safeParse` 之前先做 `message.type` 字符串短路：
type 属于 realtime 集合（`HostResponseTypes.TaskRealtimePublish` / `TaskRunLeaseAcquire` /
`TaskRunLeaseRelease` / `TaskStreamOpPublish` / `TaskOwnerCommandRequest` /
`TaskOwnerCommandResult` / `SessionMessageSendRequested` / `SessionRouteAnnounce` /
`SessionMessageDeliverResult`）时直接 return，交给 bus 侧监听器解析处理。

## 不变量

- **无消费重叠**：desktopHostProcess 的 if 链不含上述任何 realtime 类型（已逐一核对），
  realtime 消息在该入口原本就是解析后静默结束——短路是行为等价的。
- 非 realtime 消息的校验与分发路径完全不变。
- bus 侧 `handleHostMessage` 仍是 realtime 消息的**唯一业务处理者**（校验失败仍 warn 并
  丢弃）。注意：`broadcastHub` 在存在远端会话时也会对同一条消息做一次
  `hostResponseMessageSchema.safeParse`，所以本改动是「热路径全量校验从 3 次降到 2 次」，
  而非「唯一次解析」。
- 集合用 `HostResponseTypes` 常量成员构建（`Set<string>`，O(1) 判断），不硬编码字符串。

## 失败语义

- `message.type` 非 string（畸形消息）时不短路，照旧走 safeParse 拒绝路径。

## 验收

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
- 流式输出期间 main 进程 CPU 占用下降（每条 chunk 少一次全量 schema 校验）。
