/**
 * 编排运行中的用户输入语义（Phase 4）。
 *
 * 运行中的发送框只有三种语义，默认必须是 guide：
 * - guide：消息照常进入主会话本轮，模型根据 run 状态决定是否 `AmendOrchestrationPlan`；
 * - queue：不打断当前 run，等 run 收口后复用既有 queue 提升为下一条输入；
 * - interrupt：先显式取消当前 run（已完成产物留在旧 journal），再用新消息重新规划。
 *
 * 这里只做纯决策，不读写 runtime 或 service，便于把「什么时候允许开始新 turn」固定成
 * 一张可测试的表。真正的取消与排队由 runtime admission 执行。
 */

export type OrchestrationInputMode = "guide" | "queue" | "interrupt";

/** 未知/缺失值一律回到默认语义，不能让模型或旧客户端猜成「取消」。 */
export function resolveOrchestrationInputMode(value: unknown): OrchestrationInputMode {
  return value === "queue" || value === "interrupt" ? value : "guide";
}

export type OrchestrationInputDecision =
  /** 按现有 admission 路径执行（guide、或根本没有活动 run）。 */
  | { action: "admit" }
  /** 先取消这些 run，再做普通 admission。 */
  | { action: "cancel_then_admit"; runIds: readonly string[] }
  /** 把输入排进既有 queue，run 全部收口后再提升。 */
  | { action: "defer_until_idle"; runIds: readonly string[] };

export function decideOrchestrationInput(input: {
  mode: OrchestrationInputMode;
  activeRunIds: readonly string[];
  sessionBusy: boolean;
}): OrchestrationInputDecision {
  if (input.activeRunIds.length === 0) return { action: "admit" };
  // 主会话自己还有在飞 turn 时，最大的用户可见差异是「这一轮怎么投递」，
  // 交给既有 steer/queue 路径；这里不取消 run，也不额外排队。
  if (input.sessionBusy) return { action: "admit" };
  const runIds = [...input.activeRunIds];
  if (input.mode === "interrupt") return { action: "cancel_then_admit", runIds };
  if (input.mode === "queue") return { action: "defer_until_idle", runIds };
  return { action: "admit" };
}

/**
 * 被 defer 的输入在 run 收口后是否仍可提升。
 *
 * run 在等待期间被取消、或目标 session 正在关闭时，输入不能静默丢弃：取消只关闭
 * run，用户消息仍应作为下一条输入处理。唯一放弃提升的情况是 session 已 teardown。
 */
export function shouldPromoteDeferredOrchestrationInput(input: { shuttingDown: boolean }): boolean {
  return !input.shuttingDown;
}
