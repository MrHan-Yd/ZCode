# 设置页「使用统计 → 应用用量」首次打开加载优化

## 背景

「设置 → 使用统计 → 应用用量」首次打开要等一次完整聚合。数据事实源是 CLI 进程的 SQLite
`~/.zcode/cli/db/db.sqlite`（表 `model_usage` / `turn_usage` / `tool_usage`），链路是：

```
AppUsagePanel（两个 hook：range=7d 与 range=all 并行）
  └─ usageStatsService.getAppUsageSnapshot
      └─ zcodeAgentService.getAppUsageStats（v4/usage/stats 协议）
          └─ CLI getUsageStats → sessionStore.queryAppUsage → buildAppUsageSnapshot
```

本机实测（2026-10-21，`model_usage` 19133 行、`tool_usage` 25562 行，数据库 1.4GB）：
`range=all` 的旧查询在 `model_usage` 上扫 4 遍（totals / models / days / dayModels），
在 `tool_usage` 上扫 2 遍（totals / tools），合计约 **144ms**；查询计划显示走
`model_usage_started_model_idx (started_at, provider_id, model_id)` 后还要回表读取 token 列。

历史越长、数据库页越分散（冷缓存 + 1.4GB 文件），回表成本越高，这是「首次打开慢」的主要放大项。

## 产品规则

1. 快照内容与口径完全不变：`buildAppUsageSnapshot`、协议字段、UI 展示、range 语义都不改。
2. 首次打开只做必要的一次查询：`model_usage` 单遍聚合、`tool_usage` 单遍聚合，
   totals / models / days / dayModels（以及 tool 的 totals / tools / toolDays）由同一批分组结果在内存里派生。
3. 新增覆盖索引，使上面两条聚合成为 index-only scan，避免回表：
   - `model_usage_started_agg_idx (started_at, model_id, computed_total_tokens, input_tokens,
     output_tokens, reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens, status,
     time_to_first_token_ms)`
   - `tool_usage_started_agg_idx (started_at, tool_name, status, duration_ms)`
4. UI 侧缓存：同一次 renderer 生命周期内，`useAppUsageStats(range)` 的结果按
   `range + timeZone` 缓存 30s；同一 scope 的并发挂载共享同一个 in-flight promise；
   「刷新」按钮强制跳过缓存。缓存条目数有上限（8），不做无限增长。
5. `turn_usage` 的三条查询（totals / longest / 按日）本身是毫秒级，本次不合并，避免语义漂移。
6. 不做定时刷新、不改协议、不改写入路径。

## 状态所有者

- 累计事实：CLI 进程的 SQLite（与 `specs/session-performance-stats.md` 一致）。
- 查询实现：`apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts`
  的 `queryAppUsage`（唯一聚合入口）。
- UI 缓存：`packages/ui/src/hooks/useUsageStats.ts` 模块级 Map，只缓存成功快照；
  它是渲染层加速，不是第二份事实源，超过 30s 或点刷新即丢弃。

## 接口

无协议/服务接口改动。

`queryAppUsage` 内部改为：

```sql
-- model_usage：一次分组同时供给 totals / models / days / dayModels
select cast((started_at + ?) / ? as integer) as dayIndex,
       model_id, sum(computed_total_tokens), sum(input_tokens), sum(output_tokens),
       sum(reasoning_tokens), sum(cache_creation_input_tokens), sum(cache_read_input_tokens),
       count(*), sum(case when status = 'error' then 1 else 0 end),
       sum(time_to_first_token_ms), count(time_to_first_token_ms)
from model_usage
where started_at >= ? and started_at <= ?
group by dayIndex, model_id;

-- tool_usage：一次分组同时供给 toolTotals / tools / toolDays
select cast((started_at + ?) / ? as integer) as dayIndex,
       tool_name, count(*), sum(case when status = 'error' then 1 else 0 end),
       sum(duration_ms), count(duration_ms)
from tool_usage
where started_at >= ? and started_at <= ?
group by dayIndex, tool_name;
```

`avg(time_to_first_token_ms)` / `avg(duration_ms)` 用「sum / count(非空)」聚合派生，忽略 NULL 的语义不变。

## 验收场景

1. `range=all` 的 `model_usage` 只执行 1 条聚合 SQL、`tool_usage` 只执行 1 条（可用查询计数或 EXPLAIN 验证）。
2. `EXPLAIN QUERY PLAN` 显示 `USING COVERING INDEX model_usage_started_agg_idx` /
   `tool_usage_started_agg_idx`。
3. 同一份数据下，新实现产出的 `AppUsageSnapshot` 与旧实现逐字段相等（summary、heatmap、
   dailyModelUsage、models、tools）。
4. 首次打开同一 range 的耗时相对旧实现明显下降（本机 `all` 由约 144ms 降到约 28ms）。
5. 30s 内关闭再打开设置页：直接命中 UI 缓存，不再发协议请求；点「刷新」仍会重新请求。
6. 切换 7d / 30d 各自独立缓存，互不串数据。
7. 查询失败时不写缓存，UI 仍展示错误提示。

## 非目标

改变统计口径、增加新的统计维度、把 App Usage 改回本地 session JSON 估算、
为 `turn_usage` 做额外索引、跨 renderer / 跨进程共享缓存。
