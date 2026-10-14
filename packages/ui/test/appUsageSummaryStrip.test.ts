import assert from "node:assert/strict";
import test from "node:test";
import type { AppUsageHeatmap, AppUsageSnapshot } from "@zcode/shared";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { buildAppUsageSummaryStripItems } from "../src/settings/usage-stats/appUsageSummaryStripViewModel.js";

interface HeatmapDay {
  date: string;
  totalTokens: number;
}

/** 用 locale 表当字典，避免测试依赖 react-intl provider。 */
function intlFor(locale: Record<string, string>) {
  return {
    formatMessage: ({ id }: { id: string }) => locale[id] ?? id,
  };
}

/** 末周不足 7 天要补 null，和 builder 的行为一致；今日 token 必须能穿过这些占位找到。 */
function heatmapWith(days: HeatmapDay[]): AppUsageHeatmap {
  const cells: Array<AppUsageHeatmap["weeks"][number]["days"][number]> = days.map((day) => ({
    date: day.date,
    totalTokens: day.totalTokens,
    turnCount: 0,
    toolCallCount: 0,
    level: 0,
  }));
  const padded: Array<AppUsageHeatmap["weeks"][number]["days"][number]> = [...cells];
  while (padded.length < 7) {
    padded.push(null);
  }
  return {
    startDate: days[0]?.date ?? null,
    endDate: days.at(-1)?.date ?? null,
    maxTokens: Math.max(0, ...days.map((day) => day.totalTokens)),
    weeks: [{ weekIndex: 0, days: padded }],
  };
}

function snapshotWith(
  summary: Partial<AppUsageSnapshot["summary"]>,
  heatmap: AppUsageHeatmap = heatmapWith([]),
): AppUsageSnapshot {
  return {
    summary: {
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      cacheHitRate: 0,
      totalSessions: 0,
      totalTurns: 0,
      toolCallCount: 0,
      toolErrorRate: 0,
      modelErrorRate: 0,
      avgTimeToFirstTokenMs: null,
      avgTurnDurationMs: null,
      activeDays: 0,
      currentStreakDays: 0,
      longestSessionMs: 0,
      longestStreakDays: 0,
      peakDayTokens: 0,
      favoriteModel: null,
      ...summary,
    },
    heatmap,
  } as AppUsageSnapshot;
}

function itemsFor(snapshot: AppUsageSnapshot | null, locale = "zh-CN") {
  return buildAppUsageSummaryStripItems({
    intl: intlFor((locale === "zh-CN" ? zhCN : enUS) as Record<string, string>),
    locale,
    snapshot,
    formatDurationMs: (durationMs) => `duration:${durationMs}`,
  });
}

test("摘要条按产品规则的顺序给出 5 格，不含连续天数与输入 Token", () => {
  const labels = itemsFor(snapshotWith({ totalTokens: 24_400_000_000 })).map((item) => item.label);

  assert.deepEqual(labels, [
    "累计 Token 数",
    "峰值 Token 数",
    "今日 Token 数",
    "Cache 命中率",
    "最长聊天时长",
  ]);
  // 已移除的指标若被重新加回，这里会失败。
  for (const removed of ["当前连续天数", "最长连续天数", "输入 Token 数"]) {
    assert.equal(labels.includes(removed), false, `${removed} 不应出现在摘要条里`);
  }
});

test("英文文案同样齐全，格子数一致", () => {
  const labels = itemsFor(snapshotWith({}), "en-US").map((item) => item.label);

  assert.deepEqual(labels, [
    "Total tokens",
    "Peak tokens",
    "Today's tokens",
    "Cache hit rate",
    "Longest session",
  ]);
});

test("今日 Token 数取热力图最后一天，与另外两格同口径并保留一位小数", () => {
  const items = itemsFor(
    snapshotWith(
      {
        totalTokens: 2_440_000_000,
        peakDayTokens: 350_000_000,
        // 故意的干扰项：输入 token 与今日 token 数值不同，确认第三格不是取 inputTokens。
        inputTokens: 2_430_000_000,
        cacheHitRate: 0.96,
        longestSessionMs: 10_200_000,
      },
      heatmapWith([
        { date: "2026-10-12", totalTokens: 120_000_000 },
        { date: "2026-10-13", totalTokens: 180_000_000 },
        { date: "2026-10-14", totalTokens: 210_000_000 },
      ]),
    ),
  );

  assert.deepEqual(
    items.map((item) => item.value),
    ["24.4 亿", "3.5 亿", "2.1 亿", "96%", "duration:10200000"],
  );
});

test("今天没有用量时第三格是 0，不回退成占位符", () => {
  const items = itemsFor(
    snapshotWith(
      { totalTokens: 1000 },
      heatmapWith([
        { date: "2026-10-13", totalTokens: 1000 },
        { date: "2026-10-14", totalTokens: 0 },
      ]),
    ),
  );

  assert.equal(items[2]?.value, "0");
});

test("快照未加载时 5 格全是占位符，格数不缩水", () => {
  const items = itemsFor(null);

  assert.equal(items.length, 5);
  assert.deepEqual(
    items.map((item) => item.value),
    ["--", "--", "--", "--", "--"],
  );
});

test("命中率为 0 时显示 0%，不是占位符", () => {
  const items = itemsFor(snapshotWith({ cacheHitRate: 0 }));

  assert.equal(items[3]?.value, "0%");
});
