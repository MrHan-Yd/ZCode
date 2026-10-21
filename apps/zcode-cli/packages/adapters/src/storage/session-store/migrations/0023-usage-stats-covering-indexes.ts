/**
 * 0023：设置页「应用用量」的聚合查询改为 index-only scan。
 *
 * `queryAppUsage` 按 (本地日, model) / (本地日, tool) 各做一次分组，需要的列都在这里；
 * 没有覆盖索引时 SQLite 要按 `started_at` 命中索引后逐行回表，冷缓存下放大首次打开耗时。
 * 只新增索引，不改表结构与数据。
 */
export const USAGE_STATS_COVERING_INDEX_MIGRATION_SQL = `
  create index if not exists model_usage_started_agg_idx
    on model_usage(
      started_at,
      model_id,
      computed_total_tokens,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      cache_creation_input_tokens,
      cache_read_input_tokens,
      status,
      time_to_first_token_ms
    );

  create index if not exists tool_usage_started_agg_idx
    on tool_usage(started_at, tool_name, status, duration_ms);
`;
