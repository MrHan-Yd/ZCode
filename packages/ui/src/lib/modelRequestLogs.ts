import {
  MODEL_REQUEST_LOG_PAGE_SIZE,
  type ModelRequestLogView,
  type ModelRequestLogsRequest,
} from "@zcode/shared";

export type ModelRequestLogsQuery = Omit<ModelRequestLogsRequest, "timeZone">;
export const initialModelRequestLogsQuery: ModelRequestLogsQuery = {
  range: "today",
  view: "requests",
  page: 1,
  pageSize: MODEL_REQUEST_LOG_PAGE_SIZE,
  sortDirection: "desc",
};

type QueryAction =
  | { type: "view"; value: ModelRequestLogsQuery["view"] }
  | { type: "range"; value: ModelRequestLogsQuery["range"] }
  | { type: "status"; value: NonNullable<ModelRequestLogsQuery["status"]> | "all" }
  | { type: "page"; value: number }
  | { type: "sort" };

export function reduceModelRequestLogsQuery(
  query: ModelRequestLogsQuery,
  action: QueryAction,
): ModelRequestLogsQuery {
  switch (action.type) {
    case "page":
      return { ...query, page: Math.max(1, Math.min(100_000, action.value)) };
    case "view":
      return { ...query, view: action.value, page: 1, sortDirection: "desc" };
    case "range":
      return { ...query, range: action.value, page: 1 };
    case "status":
      return { ...query, status: action.value === "all" ? undefined : action.value, page: 1 };
    case "sort":
      return { ...query, sortDirection: query.sortDirection === "desc" ? "asc" : "desc", page: 1 };
  }
}

export function createRequestLogGeneration() {
  let version = 0;
  return {
    start: () => ++version,
    invalidate: () => {
      version += 1;
    },
    isCurrent: (candidate: number) => candidate === version,
  };
}

/**
 * 新响应到达前能否继续展示上一次成功结果：只有目标环境与视图都不变才能复用。
 * 视图切换会改变列结构；目标环境变化会把他机数据显示在新环境，都不能复用。
 */
export function canReuseRequestLogSnapshot(
  previous: { targetKey: string; view: ModelRequestLogView } | null,
  next: { targetKey: string; view: ModelRequestLogView },
): boolean {
  return previous !== null && previous.targetKey === next.targetKey && previous.view === next.view;
}

export function formatRequestLogDuration(value: number | null, locale: string): string {
  if (value === null) return "—";
  if (value < 1_000)
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value)} ms`;
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 1_000)} s`;
}

export function formatRequestLogPercent(value: number | null, locale: string): string {
  return value === null
    ? "—"
    : new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(value);
}

export function formatRequestLogSpeed(value: number | null, locale: string): string {
  return value === null
    ? "—"
    : `${new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)} tok/s`;
}

/**
 * providerId → 可读名称的显示投影。统计键仍是 providerId；名称只用于展示，
 * 缺名称（设置未就绪/失败/未知 ID）时回退原始 ID，不阻塞日志渲染。
 */
export function buildProviderDisplayNames(
  providers: readonly { providerId: string; providerName?: string | null }[] | null,
): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const provider of providers ?? []) {
    const name = provider.providerName?.trim();
    if (name) names.set(provider.providerId, name);
  }
  return names;
}

export function resolveProviderDisplayName(
  providerId: string,
  names: ReadonlyMap<string, string>,
): string {
  return names.get(providerId) ?? providerId;
}

/** 缓存命中与命中率合并成一格：`318,848 · 98%`，任一未知时只显示已知项。 */
export function formatRequestLogCache(
  cacheReadTokens: number,
  cacheHitRate: number | null,
  locale: string,
): string {
  const tokens = new Intl.NumberFormat(locale).format(cacheReadTokens);
  return cacheHitRate === null
    ? tokens
    : `${tokens} · ${formatRequestLogPercent(cacheHitRate, locale)}`;
}
