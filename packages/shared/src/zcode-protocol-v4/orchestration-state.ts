import { z } from "zod";
import { ORCHESTRATION_MAX_CONCURRENCY, ORCHESTRATION_MAX_TEAM_SIZE } from "../orchestration.js";

/**
 * 编排模式的只读状态查询（v4/conversation/orchestrationState）。
 *
 * 设计边界：run / step 的写入权威仍是 CLI 的 `OrchestrationRunStore`；这里的 schema
 * 只是只读投影。配置属于 session runtime，不是 snapshot 的可写状态，因此不进入
 * conversation projection，也不参与增量帧。旧 CLI 不认识这个方法时由 capability
 * `orchestrationState` 让 UI fail-closed 隐藏入口。
 */

export const orchestrationRunStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestrationRunStatusProjection = z.infer<typeof orchestrationRunStatusSchema>;

export const orchestrationStepStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "interrupted",
]);
export type OrchestrationStepStatusProjection = z.infer<typeof orchestrationStepStatusSchema>;

export const orchestrationStepProjectionSchema = z
  .object({
    stepId: z.string().min(1),
    title: z.string(),
    role: z.string(),
    status: orchestrationStepStatusSchema,
    dependsOn: z.array(z.string()),
    attempts: z.number().int().nonnegative(),
    startedAt: z.number().int().nonnegative().optional(),
    endedAt: z.number().int().nonnegative().optional(),
    error: z.string().max(4_096).optional(),
    /** 最近一次 attempt 绑定的子会话；时间线“查看子会话”用。 */
    childSessionId: z.string().min(1).optional(),
    artifactUri: z.string().min(1).optional(),
  })
  .strict();
export type OrchestrationStepProjection = z.infer<typeof orchestrationStepProjectionSchema>;

export const orchestrationRunProjectionSchema = z
  .object({
    runId: z.string().min(1),
    planId: z.string().min(1),
    revision: z.number().int().nonnegative(),
    generation: z.number().int().nonnegative(),
    status: orchestrationRunStatusSchema,
    team: z.array(z.string()).max(ORCHESTRATION_MAX_TEAM_SIZE),
    maxConcurrency: z.number().int().min(1).max(ORCHESTRATION_MAX_CONCURRENCY),
    startedAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    /** 仍在驱动的 run；终态 run 只作为“最近一次结果”保留。 */
    active: z.boolean(),
    steps: z.array(orchestrationStepProjectionSchema),
  })
  .strict();
export type OrchestrationRunProjection = z.infer<typeof orchestrationRunProjectionSchema>;

export const orchestrationConfigStateSchema = z
  .object({
    enabled: z.boolean(),
    team: z.array(z.string()).max(ORCHESTRATION_MAX_TEAM_SIZE),
    maxConcurrency: z.number().int().min(1).max(ORCHESTRATION_MAX_CONCURRENCY),
  })
  .strict();
export type OrchestrationConfigState = z.infer<typeof orchestrationConfigStateSchema>;

export const v4ConversationOrchestrationStateParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    /** 返回的 run 条数上限；缺省与钳制在 CLI 侧。 */
    limit: z.number().int().positive().max(16).optional(),
  })
  .strict();
export type V4ConversationOrchestrationStateParams = z.infer<
  typeof v4ConversationOrchestrationStateParamsSchema
>;

export const v4ConversationOrchestrationStateResultSchema = z
  .object({
    config: orchestrationConfigStateSchema,
    /** 活动 run 在前，其余按 updatedAt 倒序；最多 8 条。 */
    runs: z.array(orchestrationRunProjectionSchema).max(8),
  })
  .strict();
export type V4ConversationOrchestrationStateResult = z.infer<
  typeof v4ConversationOrchestrationStateResultSchema
>;
