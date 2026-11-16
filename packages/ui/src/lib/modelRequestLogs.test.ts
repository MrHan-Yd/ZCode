import assert from "node:assert/strict";
import test from "node:test";
import {
  canReuseRequestLogSnapshot,
  initialModelRequestLogsQuery,
  reduceModelRequestLogsQuery,
  formatRequestLogCache,
  formatRequestLogDuration,
  formatRequestLogPercent,
  formatRequestLogSpeed,
  buildProviderDisplayNames,
  resolveProviderDisplayName,
  createRequestLogGeneration,
} from "./modelRequestLogs.js";
import { createSettingsPageConfig } from "../settings/settingsPageConfig.js";
import { isSettingsSectionEnabled, resolveSettingsSection } from "./settingsNavigation.js";
import zhCN from "../i18n/locales/zh-CN.js";
import enUS from "../i18n/locales/en-US.js";

function deferred() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("请求日志在桌面与 Web 设置数据统计分组注册为独立入口", () => {
  for (const options of [
    {},
    { isDesktop: true },
    { isMacDesktop: true },
    { isWindowsDesktop: true },
  ]) {
    const config = createSettingsPageConfig(options);
    const sections = config.settingsSectionGroups.find(
      (group) => group.id === "dataAndStats",
    )!.sections;
    assert.equal(
      sections.findIndex((section) => section.id === "requestLogs"),
      sections.findIndex((section) => section.id === "usage") + 1,
    );
    assert.equal(
      sections.find((section) => section.id === "requestLogs")?.titleId,
      "settings.requestLogs.title",
    );
  }
  assert.equal(isSettingsSectionEnabled("requestLogs"), true);
  assert.equal(resolveSettingsSection("requestLogs"), "requestLogs");
});

test("视图/筛选/排序切换重置页码，翻页有边界", () => {
  const page = reduceModelRequestLogsQuery(initialModelRequestLogsQuery, {
    type: "page",
    value: 3,
  });
  assert.equal(page.page, 3);
  for (const action of [
    { type: "view", value: "providers" },
    { type: "range", value: "today" },
    { type: "status", value: "error" },
    { type: "sort" },
  ] as const) {
    assert.equal(reduceModelRequestLogsQuery(page, action).page, 1);
  }
  assert.equal(
    reduceModelRequestLogsQuery(page, { type: "status", value: "all" }).status,
    undefined,
  );
  assert.equal(
    reduceModelRequestLogsQuery(page, { type: "view", value: "providers" }).sortDirection,
    "desc",
  );
  assert.equal(reduceModelRequestLogsQuery(page, { type: "page", value: 0 }).page, 1);
  assert.equal(reduceModelRequestLogsQuery(page, { type: "page", value: 200_000 }).page, 100_000);
});

test("未知计量显示横杠，已知零值不丢失", () => {
  assert.equal(formatRequestLogDuration(null, "en-US"), "—");
  assert.equal(formatRequestLogDuration(0, "en-US"), "0 ms");
  assert.equal(formatRequestLogDuration(1_500, "en-US"), "1.50 s");
  assert.equal(formatRequestLogPercent(0, "en-US"), "0%");
  assert.equal(formatRequestLogPercent(0.8, "en-US"), "80%");
  assert.equal(formatRequestLogPercent(null, "en-US"), "—");
  assert.equal(formatRequestLogSpeed(0, "en-US"), "0.0 tok/s");
  assert.equal(formatRequestLogSpeed(null, "en-US"), "—");
});

test("默认每页 20 条，减少长列表滚动", () => {
  assert.equal(initialModelRequestLogsQuery.pageSize, 20);
});

test("默认时间范围为今日", () => {
  assert.equal(initialModelRequestLogsQuery.range, "today");
  assert.equal(initialModelRequestLogsQuery.page, 1);
  assert.equal(initialModelRequestLogsQuery.status, undefined);
});

test("只有目标环境与视图都不变时才复用上一次快照", () => {
  const previous = { targetKey: "local", view: "requests" as const };
  assert.equal(
    canReuseRequestLogSnapshot(previous, { targetKey: "local", view: "requests" }),
    true,
  );
  assert.equal(
    canReuseRequestLogSnapshot(previous, { targetKey: "local", view: "providers" }),
    false,
  );
  assert.equal(
    canReuseRequestLogSnapshot(previous, { targetKey: "remote", view: "requests" }),
    false,
  );
  assert.equal(canReuseRequestLogSnapshot(null, { targetKey: "local", view: "requests" }), false);
});

test("供应商显示名称来自 Provider Settings，缺失时回退原始 ID", () => {
  const names = buildProviderDisplayNames([
    { providerId: "05d87373", providerName: " DeepSeek 中转 " },
    { providerId: "blank", providerName: "   " },
  ]);
  assert.equal(resolveProviderDisplayName("05d87373", names), "DeepSeek 中转");
  assert.equal(resolveProviderDisplayName("blank", names), "blank");
  assert.equal(resolveProviderDisplayName("unknown-id", names), "unknown-id");
  assert.equal(resolveProviderDisplayName("anything", buildProviderDisplayNames(null)), "anything");
});

test("缓存命中与命中率合并为一格，命中率未知时只显示 Token 数", () => {
  assert.equal(formatRequestLogCache(318_848, 0.98, "en-US"), "318,848 · 98%");
  assert.equal(formatRequestLogCache(0, 0, "en-US"), "0 · 0%");
  assert.equal(formatRequestLogCache(1_024, null, "en-US"), "1,024");
});

test("设置文案键在两种语言中一致，已移除的应用来源文案不再残留", () => {
  const keys = Object.keys(zhCN).filter((key) => key.startsWith("settings.requestLogs."));
  assert.ok(keys.length > 20);
  assert.deepEqual(
    keys.sort(),
    Object.keys(enUS)
      .filter((key) => key.startsWith("settings.requestLogs."))
      .sort(),
  );
  for (const removed of [
    "application",
    "cacheRate",
    "cost",
    "costHint",
    "partialCost",
    "source.main",
    "source.subagent",
  ]) {
    assert.equal(zhCN[`settings.requestLogs.${removed}`], undefined);
  }
});

test("延迟旧请求在新请求完成后失效，卸载/服务切换失效所有在途响应", async () => {
  const generation = createRequestLogGeneration();
  const old = deferred();
  const next = deferred();
  const results: string[] = [];
  const run = async (promise: Promise<string>) => {
    const version = generation.start();
    const value = await promise;
    if (generation.isCurrent(version)) results.push(value);
  };
  const oldRun = run(old.promise);
  const newRun = run(next.promise);
  next.resolve("new");
  await newRun;
  old.resolve("old");
  await oldRun;
  assert.deepEqual(results, ["new"]);
  const version = generation.start();
  generation.invalidate();
  assert.equal(generation.isCurrent(version), false);
});
