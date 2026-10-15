/* eslint-disable max-lines -- 会话性能口径（RPC 契约 + 字符估算）需要跨 CLI、服务与 renderer 共用同一份定义。 */
import { z } from "zod";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "./usage-stats.js";

export const sessionPerformanceParamsSchema = z.object({ sessionId: z.string().min(1) }).strict();

/**
 * 批量读取的上限：一笔请求最多覆盖这么多个会话。
 * 子智能体速度用它（见 specs/session-performance-stats.md 规则 7）：面板按 1 秒轮询一次覆盖
 * 全部运行中的子智能体，请求数因此与并发子代理数无关；超上限由 schema 拒绝，UI 侧先截断。
 */
export const SESSION_PERFORMANCE_MAX_SESSIONS = 32;

export const sessionPerformanceBatchParamsSchema = z
  .object({
    sessionIds: z.array(z.string().min(1)).min(1).max(SESSION_PERFORMANCE_MAX_SESSIONS),
  })
  .strict();
export type SessionPerformanceBatchParams = z.infer<typeof sessionPerformanceBatchParamsSchema>;


const measure = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();

/**
 * 会话性能累计。全部字段都是**该会话自己**的模型请求与工具调用的累计值：
 * `modelMs` 含首 token 等待，`tokensPerSecond` 的生成时长只算首输出到请求结束，
 * 两者分母不同，不能互相换算。缺计量的请求不能进 TPS 的分子或分母，因此 TPS 为
 * null 时只表示"算不出来"。
 *
 * 「自己的模型请求」按会话种类取不同的 `query_source`：主会话是 `main_turn`，
 * 子智能体的子会话是 `subagent`（子代理请求记在子会话 id 上）。裁决在 CLI 侧，
 * 见 `SessionPerformanceQueryInput.querySources`。
 */
export const sessionPerformanceSummarySchema = z
  .object({
    modelMs: measure,
    toolMs: measure,
    averageTtftMs: measure.nullable(),
    tokensPerSecond: measure.nullable(),
    modelRequestCount: count,
    toolCallCount: count,
  })
  .strict();
export type SessionPerformanceSummary = z.infer<typeof sessionPerformanceSummarySchema>;

export const sessionPerformanceSnapshotSchema = z
  .object({
    sessionId: z.string(),
    summary: sessionPerformanceSummarySchema,
  })
  .strict();
export type SessionPerformanceSnapshot = z.infer<typeof sessionPerformanceSnapshotSchema>;

export const sessionPerformanceBatchResultSchema = z
  .object({
    /**
     * 只回读得到数的会话，顺序同请求参数。查不到的 id（子智能体刚结束、保留期外、
     * 不在本进程的会话）整体缺席而不是报错——批量轮询里一个刚结束的子会话不该让
     * 整批读数失败。
     */
    entries: z.array(sessionPerformanceSnapshotSchema),
  })
  .strict();
export type SessionPerformanceBatchResult = z.infer<typeof sessionPerformanceBatchResultSchema>;

/**
 * 流式期间用字符数估算输出 token，与 CLI 侧 `estimateTokens`
 * （`apps/zcode-cli/packages/core/src/context/utils.ts`）保持同一口径：CJK 表意文字按两倍权重。
 * 计数入参而不是字符串：流式期间只累加长度，不必为估算把正文重新拼成一个大字符串。
 * 只服务流式实时显示，权威 token 数仍来自 provider usage。
 */
export function estimateOutputTokensFromCharCounts(
  charCount: number,
  wideCharCount: number,
): number {
  const otherChars = charCount - wideCharCount;
  return Math.ceil((wideCharCount * 2 + otherChars) / ESTIMATED_TOKEN_CHAR_DIVISOR);
}

export function countWideChars(text: string): number {
  return (text.match(/[\u4e00-\u9fff]/gu) || []).length;
}

/**
 * TTFT 平均：样本数为 0 时必须返回 null 而不是 0——0 会被读成「没有延迟」，
 * 而实际含义是「还没有可用的首 token 计量」。
 */
export function averageTtftMs(sumMs: number, sampleCount: number): number | null {
  return sampleCount > 0 ? sumMs / sampleCount : null;
}
