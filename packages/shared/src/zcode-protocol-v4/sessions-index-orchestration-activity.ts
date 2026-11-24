// ============================================================
// sessions-index 的编排活动摘要
// ============================================================
// 编排 run 不属于 conversation projection（配置与 run 投影都在 session runtime），
// 所以 phase 无法表达“主代理轮已收口、但编排子代理仍在跑”。这里把同一时刻的
// OrchestrationService 活动投影成一份有界摘要，随 sessions-index 下发，供运行态
// （侧栏指示、标题栏角标、后台徽标）与完成通知共用同一事实。

import { z } from "zod";
import { timestampSchema } from "./core.js";

export const sessionOrchestrationActivitySchema = z.object({
  /** 仍有 scheduler 在驱动的 run 数（active）。 */
  activeRunCount: z.number().int().positive(),
  runningStepCount: z.number().int().nonnegative(),
  completedStepCount: z.number().int().nonnegative(),
  totalStepCount: z.number().int().nonnegative(),
  /** 最早一个活动 run 的启动时刻；状态条的耗时从这里算。 */
  startedAt: timestampSchema,
});
export type SessionOrchestrationActivity = z.infer<typeof sessionOrchestrationActivitySchema>;

/** 会话是否仍有编排工作在跑；缺席的摘要 = 经典会话或旧 CLI。 */
export function isSessionOrchestrationActive(
  activity: SessionOrchestrationActivity | undefined,
): boolean {
  return (activity?.activeRunCount ?? 0) > 0;
}
