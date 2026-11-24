import {
  averageTtftMs,
  calculateRequestLogAverageTps,
  sessionPerformanceParamsSchema,
  type SessionPerformanceSnapshot,
} from "@zcode/shared";
import type { SessionId, SessionPerformanceQueryResult, UsageStorePort } from "@zcode/contracts";
import { requireSession, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/** 会话性能聚合的原始计量 → wire 快照。平均与速率只在这里换算，两个入口共用同一份口径。 */
function toSessionPerformanceSnapshot(
  sessionId: string,
  aggregate: Omit<SessionPerformanceQueryResult, "sessionID">,
): SessionPerformanceSnapshot {
  return {
    sessionId,
    summary: {
      modelMs: aggregate.modelMs,
      toolMs: aggregate.toolMs,
      averageTtftMs: averageTtftMs(aggregate.ttftSumMs, aggregate.ttftCount),
      tokensPerSecond: calculateRequestLogAverageTps(
        aggregate.tpsOutputTokens,
        aggregate.tpsDurationMs,
      ),
      modelRequestCount: aggregate.modelRequestCount,
      toolCallCount: aggregate.toolCallCount,
    },
  };
}

/** 读不到计量时的空统计：`0` 只用于时长与计数，两处平均值保持 `null`（"算不出来"，不是"零延迟"）。 */
function emptySessionPerformanceSnapshot(sessionId: string): SessionPerformanceSnapshot {
  return toSessionPerformanceSnapshot(sessionId, {
    modelMs: 0,
    toolMs: 0,
    ttftSumMs: 0,
    ttftCount: 0,
    tpsOutputTokens: 0,
    tpsDurationMs: 0,
    modelRequestCount: 0,
    toolCallCount: 0,
  });
}

/** 旧 store 没有聚合方法的降级读数；也供批量版复用。 */
export function readSessionPerformanceAggregate(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  querySources: readonly ("main_turn" | "subagent")[],
): Promise<SessionPerformanceSnapshot> {
  const usageStore = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!usageStore?.querySessionPerformance) {
    return Promise.resolve(emptySessionPerformanceSnapshot(sessionId));
  }
  return usageStore
    .querySessionPerformance({ sessionID: sessionId as SessionId, querySources })
    .then((aggregate) => toSessionPerformanceSnapshot(sessionId, aggregate));
}

/**
 * 会话统计：只读聚合持久层已有的 usage 列。
 * 平均与速率在这里换算，聚合层只负责求和，避免"平均口径"出现第二份实现。
 * 原首字后尾段口径会放大隐藏推理或缓冲请求的速度；改用 `calculateRequestLogAverageTps`
 * 与请求日志统一按成功请求的总耗时换算，合格累计耗时为 0 时返回 null。
 *
 * 单会话入口只服务主会话（面板与工具条入口），口径固定为主链 `main_turn`；
 * 子智能体的子会话走批量入口（`session-performance-batch.ts`）。
 */
export async function querySessionPerformance(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<SessionPerformanceSnapshot> {
  const params = sessionPerformanceParamsSchema.parse(rawParams);
  requireSession(context, params.sessionId);
  return readSessionPerformanceAggregate(context, params.sessionId, ["main_turn"]);
}
