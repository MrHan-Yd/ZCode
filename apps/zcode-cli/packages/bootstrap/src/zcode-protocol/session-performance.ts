import {
  averageTtftMs,
  calculateOutputTps,
  sessionPerformanceParamsSchema,
  type SessionPerformanceSnapshot,
} from "@zcode/shared";
import type { SessionId, UsageStorePort } from "@zcode/contracts";
import { requireSession, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 会话统计：只读聚合持久层已有的 usage 列。
 * 平均与速率在这里换算，聚合层只负责求和，避免"平均口径"出现第二份实现。
 * TPS 复用 `calculateOutputTps`：生成时长为 0 或缺失时返回 null，不能用请求总时长替代。
 */
export async function querySessionPerformance(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<SessionPerformanceSnapshot> {
  const params = sessionPerformanceParamsSchema.parse(rawParams);
  requireSession(context, params.sessionId);
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!usageStore?.querySessionPerformance) {
    return emptySnapshot(params.sessionId);
  }
  const aggregate = await usageStore.querySessionPerformance({
    sessionID: params.sessionId as SessionId,
  });
  return {
    sessionId: params.sessionId,
    summary: {
      modelMs: aggregate.modelMs,
      toolMs: aggregate.toolMs,
      averageTtftMs: averageTtftMs(aggregate.ttftSumMs, aggregate.ttftCount),
      tokensPerSecond: calculateOutputTps(aggregate.tpsOutputTokens, aggregate.generationMs),
      modelRequestCount: aggregate.modelRequestCount,
      toolCallCount: aggregate.toolCallCount,
    },
  };
}

function emptySnapshot(sessionId: string): SessionPerformanceSnapshot {
  return {
    sessionId,
    summary: {
      modelMs: 0,
      toolMs: 0,
      averageTtftMs: null,
      tokensPerSecond: null,
      modelRequestCount: 0,
      toolCallCount: 0,
    },
  };
}
