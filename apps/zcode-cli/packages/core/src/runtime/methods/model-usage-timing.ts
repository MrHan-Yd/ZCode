import { SessionEventType, type SessionEvent } from "@zcode/contracts";

/**
 * 首个文本/思考增量的事件时刻。工具参数增量不在这里统计：core 会把工具参数
 * 缓冲到换行、4096 字符或结束时才落事件，用它当首字会退化到接近总耗时。
 */
export function firstModelTokenAt(
  events: readonly SessionEvent[],
  startIndex: number,
): number | undefined {
  for (const event of events.slice(startIndex)) {
    if (event.type !== SessionEventType.ModelStreaming) continue;
    const payload = event.payload as { delta?: string; kind?: string };
    if (
      (payload.kind === "text_delta" || payload.kind === "reasoning_delta") &&
      payload.delta &&
      payload.delta.length > 0
    ) {
      return event.timestamp.getTime();
    }
  }
  return undefined;
}

/**
 * 纯工具调用没有文本/思考增量时，用 provider 的首内容里程碑回填首字。
 * `model_request_completed` 自带本次尝试的 durationMs 与 timeToFirstContentMs
 * （后者包含工具参数增量），反推 attempt 起点即可得到首个内容的绝对时间。
 * 里程碑缺失、非法或超过本次尝试耗时（非流式旧配置）时保持未知。
 */
export function firstProviderContentAt(
  events: readonly SessionEvent[],
  startIndex: number,
): number | undefined {
  for (const event of events.slice(startIndex)) {
    if (event.type !== SessionEventType.ModelNetworkStatus) continue;
    const payload = event.payload as {
      durationMs?: unknown;
      timeToFirstContentMs?: unknown;
      type?: string;
    };
    if (payload?.type !== "model_request_completed") continue;
    const durationMs = nonNegativeMeasurement(payload.durationMs);
    const contentMs = nonNegativeMeasurement(payload.timeToFirstContentMs);
    if (durationMs === undefined || contentMs === undefined || contentMs > durationMs) {
      return undefined;
    }
    return event.timestamp.getTime() - durationMs + contentMs;
  }
  return undefined;
}

function nonNegativeMeasurement(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
