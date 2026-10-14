import type { AppUsageSnapshot } from "@zcode/shared";
import {
  formatPercent,
  formatSummaryCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";

interface UsageIntl {
  formatMessage: (descriptor: { id: string }) => string;
}

export interface AppUsageSummaryStripItem {
  label: string;
  value: string;
}

/** 快照未加载时所有格子统一占位，格数与顺序不变，避免加载态闪成另一种布局。 */
const UNKNOWN_VALUE = "--";

/**
 * 今日 Token 数取热力图最后一天（`heatmap.endDate`）的当日累计值。
 * 这跟 Token 活动热力图 tooltip 展示的是同一个 cell，两处口径天然一致；
 * builder 会为 start..end 的每一天建 cell，正常不会落到最后的 0。
 */
function resolveTodayTokens(snapshot: AppUsageSnapshot): number {
  const today = snapshot.heatmap.endDate;
  if (!today) {
    return 0;
  }
  for (const week of snapshot.heatmap.weeks) {
    for (const cell of week.days) {
      if (cell?.date === today) {
        return cell.totalTokens;
      }
    }
  }
  return 0;
}

/**
 * 应用用量摘要条的取值与顺序。
 *
 * 顺序是产品规则的一部分（累计 → 峰值 → 今日 → 缓存命中率 → 最长聊天时长），
 * 抽成纯函数是为了让列顺序与字段口径能被测试锁住，而不是散落在 JSX 里。
 * 时长格式化由调用方注入，避免 view model 反向依赖 AppUsagePanel。
 */
export function buildAppUsageSummaryStripItems({
  intl,
  locale,
  snapshot,
  formatDurationMs,
}: {
  intl: UsageIntl;
  locale: string;
  snapshot: AppUsageSnapshot | null;
  formatDurationMs: (durationMs: number) => string;
}): AppUsageSummaryStripItem[] {
  const summary = snapshot?.summary ?? null;
  return [
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimeTotalTokens" }),
      value: summary ? formatSummaryCompactTokenUsage(locale, summary.totalTokens) : UNKNOWN_VALUE,
    },
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimePeakTokens" }),
      value: summary ? formatSummaryCompactTokenUsage(locale, summary.peakDayTokens) : UNKNOWN_VALUE,
    },
    {
      label: intl.formatMessage({ id: "settings.usage.lifetimeTodayTokens" }),
      value: snapshot
        ? formatSummaryCompactTokenUsage(locale, resolveTodayTokens(snapshot))
        : UNKNOWN_VALUE,
    },
    {
      label: intl.formatMessage({ id: "settings.usage.cacheHitRate" }),
      value: summary ? formatPercent(locale, summary.cacheHitRate) : UNKNOWN_VALUE,
    },
    {
      label: intl.formatMessage({ id: "settings.usage.longestSession" }),
      value: summary ? formatDurationMs(summary.longestSessionMs) : UNKNOWN_VALUE,
    },
  ];
}
