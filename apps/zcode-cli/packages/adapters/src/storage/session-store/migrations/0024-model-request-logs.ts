export const MODEL_REQUEST_LOGS_MIGRATION_SQL = `
  alter table model_usage add column cost_usd real;
  alter table model_usage add column http_status integer;

  create index if not exists model_usage_started_id_idx
    on model_usage(started_at, id);
  create index if not exists model_usage_status_started_id_idx
    on model_usage(status, started_at, id);
`;
