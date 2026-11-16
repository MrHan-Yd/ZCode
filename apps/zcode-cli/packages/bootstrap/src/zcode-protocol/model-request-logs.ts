import type { UsageStorePort } from "@zcode/contracts";
import {
  modelRequestLogsRequestSchema,
  modelRequestLogsSnapshotSchema,
  type ModelRequestLogRange,
} from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

export async function getModelRequestLogs(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(modelRequestLogsRequestSchema, rawParams);
  const store = context.deps.sessionStore as Partial<UsageStorePort> | undefined;
  if (!store?.queryModelRequestLogs) throw new Error("model_request_logs_unavailable");
  const until = Date.now();
  const timeZone = params.timeZone ?? "UTC";
  const since = resolveModelRequestLogsSince(params.range, timeZone, until);
  return modelRequestLogsSnapshotSchema.parse(
    await store.queryModelRequestLogs({ ...params, timeZone, since, until }),
  );
}

export function resolveModelRequestLogsSince(
  range: ModelRequestLogRange,
  timeZone: string,
  until: number,
): number {
  if (range !== "today") return Math.max(0, until - (range === "7d" ? 7 : 30) * 86_400_000);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  });
  const localDay = (time: number) => {
    const parts = formatter.formatToParts(time);
    return ["year", "month", "day"]
      .map((type) => parts.find((part) => part.type === type)!.value)
      .join("-");
  };
  const today = localDay(until);
  let left = Math.max(0, until - 2 * 86_400_000);
  let right = until;
  // 夏令时切换日的 UTC 偏移会变化，按本地日期二分起点而非用此刻偏移反推午夜。
  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (localDay(middle) >= today) right = middle;
    else left = middle + 1;
  }
  return left;
}
