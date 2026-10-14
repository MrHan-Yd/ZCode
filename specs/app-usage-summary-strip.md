# App Usage 摘要条指标调整

## 背景

设置页「使用统计 → 应用用量」顶部有一条 5 格摘要条（`AppUsageLifetimeSummaryStrip`，位于 `packages/ui/src/settings/usage-stats/AppUsagePanel.tsx`），展示 lifetime 快照里的 5 个指标：

```
累计 Token 数 | 峰值 Token 数 | 最长聊天时长 | 当前连续天数 | 最长连续天数
```

本次调整：去掉两个连续天数指标，补上今日 Token 数与缓存命中率，并把最长聊天时长挪到最右。

## 产品规则

1. 摘要条改为 5 格，顺序固定为：

```
累计 Token 数 | 峰值 Token 数 | 今日 Token 数 | 缓存命中率 | 最长聊天时长
```

2. 移除「当前连续天数」「最长连续天数」两格。对应的 `currentStreakDays` / `longestStreakDays` 字段继续留在快照里（热力图、后续统计仍可能用），只是摘要条不再展示。
3. 新增「今日 Token 数」取 **当日** token 累计，而不是 `summary.inputTokens`。数据源是 lifetime 快照热力图的最后一天：`heatmap.endDate` 那个 cell 的 `totalTokens`——与 Token 活动热力图 tooltip 展示的是同一个 cell，两处口径天然一致，不新增协议字段。
4. 「今日 Token 数」与「累计 Token 数」「峰值 Token 数」共用 `formatSummaryCompactTokenUsage`，因此单位与小数位完全一致（compact 记法保留一位小数，中文补单位前的空格，如 `2.1 亿`）。
5. 新增「缓存命中率」取 `summary.cacheHitRate`，按百分比展示（`formatPercent`）。
6. 快照还没加载时（`lifetimeSnapshot` 为 null），5 格全部显示 `--`，格数与顺序不变——加载态不能闪成另一种布局。
7. 分隔线与响应式行为不变：窄屏纵向堆叠，`sm` 以上单行等分并显示竖分隔线。

## 状态所有者

`AppUsagePanel` 已经通过 `useAppUsageStats("all")` 持有 lifetime 快照，`AppUsageLifetimeSummaryStrip` 是纯展示组件。取值逻辑抽到纯函数 `buildAppUsageSummaryStripItems`（`packages/ui/src/settings/usage-stats/appUsageSummaryStripViewModel.ts`），本次不新增状态、不改 hook、不改数据来源。

## 接口

无协议/服务改动。所需数据都已在 `AppUsageSnapshot` 里：

```ts
// packages/shared/src/usage-stats.ts
summary.totalTokens;   // 累计
summary.peakDayTokens; // 峰值
summary.cacheHitRate;  // 0..1 比率
summary.longestSessionMs;
heatmap.endDate;       // 当日日期（builder 的「今天」）
heatmap.weeks[].days[] // date + totalTokens，endDate 那个 cell 即今日用量
```

时长格式化由 `AppUsagePanel` 通过 `formatDurationMs` 注入（`formatAppUsageDuration` 仍留在该文件，`CodingPlanUsagePanel` 也从那里导入），避免 view model 反向依赖面板组件。

i18n 新增 `settings.usage.lifetimeTodayTokens`（zh-CN / en-US）；「缓存命中率」复用既有 `settings.usage.cacheHitRate`。

## 验收场景

1. 打开「设置 → 使用统计 → 应用用量」，摘要条是 5 格，标签从左到右为 累计 Token 数 / 峰值 Token 数 / 今日 Token 数 / 缓存命中率 / 最长聊天时长。
2. 今日 Token 数与同一页「Token 活动」热力图当天 tooltip 的 token 数一致。
3. 今日 Token 数的单位与小数位同累计、峰值两格一致（如同为 `亿` 并保留一位小数）。
4. 今天还没有用量时第三格显示 `0`，不是 `--`。
5. 缓存命中率按百分比展示；命中率为 0 时显示 `0%`，不是 `--`。
6. 最长聊天时长位于最右一格，格式与改动前一致（如「2 小时 50 分钟」）。
7. 数据未加载时 5 格全为 `--`。
8. 窄屏下 5 格纵向堆叠，不出现横向溢出。

## 已知限制

- `settings.usage.currentStreak` / `settings.usage.longestStreak` 两条文案保留在 locale 里但暂无引用（与同区块既有的 `settings.usage.activeDays` 情况一致），不影响运行。
- 今日 Token 数随 lifetime 快照走：快照是缓存的，跨零点后需要刷新（面板上的刷新按钮，或重开页面）才会跳到新的一天，与热力图的行为一致。
- 摘要条仍是固定 5 格等分，不随窗口宽度折行；指标再多需要重新设计该条。
