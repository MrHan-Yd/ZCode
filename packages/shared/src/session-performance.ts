/* eslint-disable max-lines -- 会话性能口径（RPC 契约 + 字符估算）需要跨 CLI、服务与 renderer 共用同一份定义。 */
import { z } from "zod";
import { ESTIMATED_TOKEN_CHAR_DIVISOR } from "./usage-stats.js";

export const sessionPerformanceParamsSchema = z.object({ sessionId: z.string().min(1) }).strict();

const measure = z.number().finite().nonnegative();
const count = z.number().int().nonnegative();

/**
 * 会话性能累计。全部字段都是主链模型请求（`query_source = 'main_turn'`）与
 * 该会话工具调用的累计值：`modelMs` 含首 token 等待，`tokensPerSecond` 的生成时长
 * 只算首输出到请求结束，两者分母不同，不能互相换算。
 * 缺计量的请求不能进 TPS 的分子或分母，因此 TPS 为 null 时只表示"算不出来"。
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
