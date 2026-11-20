/**
 * 编排运行中的默认投递语义。
 *
 * 旧的 UI 三态菜单移除后，Core 对缺失的 `orchestrationInput` 按 guide 处理：
 * 活动 run 期间主会话空闲时，普通发送会被立即接纳成新 turn，看起来就像“发送即
 * 打断”。这里恢复运行期的默认排队：发送先进入既有队列列表，等 run 收口后由
 * Core 的提升路径消费。显式打断仍由用户在队列项上点「立即发送」（sendQueuedNow）
 * 触发；Ctrl/Cmd+Enter 是显式 startNow，映射成核心的 interrupt（取消活动 run 后
 * 立即开始），不会留下继续运行的旧 run。
 */
export function resolveOrchestrationInputForSend(input: {
  activeRunCount: number;
  requestedDelivery?: "startNow" | "queue" | "guide";
}): "queue" | "interrupt" | undefined {
  if (input.activeRunCount <= 0) return undefined;
  if (input.requestedDelivery === "startNow") return "interrupt";
  return "queue";
}
