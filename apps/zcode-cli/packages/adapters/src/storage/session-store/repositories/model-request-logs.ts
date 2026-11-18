import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { ModelRequestLogsQueryInput } from "@zcode/contracts";
import {
  calculateRequestLogAverageTps,
  modelRequestLogsRequestSchema,
  type ModelRequestLogGroup,
  type ModelRequestLogRecord,
  type ModelRequestLogsSnapshot,
} from "@zcode/shared";
import { inputSideTokensFromStoredUsage } from "./usage.js";

interface StoredRequest {
  id: string;
  sessionId: string;
  startedAt: number;
  querySource: string;
  providerId: string;
  modelId: string;
  status: ModelRequestLogRecord["status"];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  providerTotalTokens: number | null;
  computedTotalTokens: number;
  timeToFirstTokenMs: number | null;
  durationMs: number | null;
  costUsd: number | null;
  httpStatus: number | null;
  retryCount: number;
}

interface StoredGroup {
  providerId: string;
  modelId: string | null;
  requestCount: number;
  totalTokens: number;
  costUsd: number | null;
  costKnownCount: number;
  successCount: number;
  outputTokens: number;
  durationMs: number;
  timeToFirstTokenMs: number | null;
}

export async function queryModelRequestLogs(
  db: DatabaseSync,
  input: ModelRequestLogsQueryInput,
): Promise<ModelRequestLogsSnapshot> {
  const { since, until, ...rawRequest } = input;
  const request = modelRequestLogsRequestSchema.parse(rawRequest);
  if (!Number.isFinite(since) || !Number.isFinite(until) || since < 0 || until < since) {
    throw new Error("invalid_model_request_logs_range");
  }
  const where = "started_at >= ? and started_at <= ?" + (request.status ? " and status = ?" : "");
  const values: SQLInputValue[] = [since, until];
  if (request.status) values.push(request.status);
  const direction = request.sortDirection === "asc" ? "asc" : "desc";
  const offset = (request.page - 1) * request.pageSize;

  // 同一读取事务固定计数和当前页的水位，避免其它 CLI 进程写入时出现页数与行不一致。
  db.exec("savepoint model_request_logs_read");
  try {
    const storedCounts = db
      .prepare(
        `select count(*) as requests, count(distinct provider_id) as providers,
         (select count(*) from (
           select provider_id, model_id from model_usage where ${where}
           group by provider_id, model_id
         )) as models
       from model_usage where ${where}`,
      )
      .get(...values, ...values) as ModelRequestLogsSnapshot["counts"];
    const counts = {
      requests: integer(storedCounts.requests),
      providers: integer(storedCounts.providers),
      models: integer(storedCounts.models),
    };
    const requests: ModelRequestLogRecord[] = [];
    const groups: ModelRequestLogGroup[] = [];
    if (request.view === "requests") {
      const rows = db
        .prepare(
          `select id, session_id as sessionId, started_at as startedAt,
           query_source as querySource, provider_id as providerId, model_id as modelId, status,
           input_tokens as inputTokens, output_tokens as outputTokens,
           cache_read_input_tokens as cacheReadTokens, cache_creation_input_tokens as cacheCreationTokens,
           provider_total_tokens as providerTotalTokens, computed_total_tokens as computedTotalTokens,
           time_to_first_token_ms as timeToFirstTokenMs, duration_ms as durationMs,
           cost_usd as costUsd, http_status as httpStatus, retry_count as retryCount
         from model_usage where ${where}
         order by started_at ${direction}, id ${direction} limit ? offset ?`,
        )
        .all(...values, request.pageSize, offset) as unknown as StoredRequest[];
      requests.push(...rows.map(toRequestRecord));
    } else {
      const byModel = request.view === "models";
      const modelColumn = byModel ? "model_id" : "null";
      const grouping = byModel ? "provider_id, model_id" : "provider_id";
      // 首字可能在推理或缓冲之后才出现；平均速率只要求整轮计量有效，分子和分母必须取同一批请求。
      const validSpeed = `status = 'completed' and duration_ms > 0 and duration_ms <= ${Number.MAX_VALUE} and output_tokens >= 0 and output_tokens <= ${Number.MAX_VALUE}`;
      const rows = db
        .prepare(
          `select provider_id as providerId, ${modelColumn} as modelId,
           count(*) as requestCount,
           coalesce(sum(coalesce(provider_total_tokens, computed_total_tokens)), 0) as totalTokens,
           sum(case when cost_usd >= 0 then cost_usd end) as costUsd,
           count(case when cost_usd >= 0 then 1 end) as costKnownCount,
           count(case when status = 'completed' then 1 end) as successCount,
           coalesce(sum(case when ${validSpeed} then output_tokens else 0 end), 0) as outputTokens,
           coalesce(sum(case when ${validSpeed} then duration_ms else 0 end), 0) as durationMs,
           avg(case when status = 'completed' and time_to_first_token_ms >= 0 then time_to_first_token_ms end) as timeToFirstTokenMs
         from model_usage where ${where} group by ${grouping}
         order by requestCount ${direction}, provider_id asc${byModel ? ", model_id asc" : ""}
         limit ? offset ?`,
        )
        .all(...values, request.pageSize, offset) as unknown as StoredGroup[];
      groups.push(
        ...rows.map((row) => ({
          providerId: row.providerId,
          modelId: row.modelId,
          requestCount: integer(row.requestCount),
          totalTokens: integer(row.totalTokens),
          costUsd: measurement(row.costUsd),
          costKnownCount: integer(row.costKnownCount),
          successRate: row.requestCount > 0 ? row.successCount / row.requestCount : 0,
          tokensPerSecond: calculateRequestLogAverageTps(row.outputTokens, row.durationMs),
          timeToFirstTokenMs: measurement(row.timeToFirstTokenMs),
        })),
      );
    }
    const result: ModelRequestLogsSnapshot = {
      range: request.range,
      view: request.view,
      generatedAt: until,
      timeZone: request.timeZone ?? "UTC",
      page: request.page,
      pageSize: request.pageSize,
      totalCount: counts[request.view],
      counts,
      requests,
      groups,
    };
    db.exec("release model_request_logs_read");
    return result;
  } catch (error) {
    db.exec("rollback to model_request_logs_read; release model_request_logs_read");
    throw error;
  }
}

function toRequestRecord(row: StoredRequest): ModelRequestLogRecord {
  const inputTokens = inputSideTokensFromStoredUsage(row);
  const cacheReadTokens = integer(row.cacheReadTokens);
  const durationMs = measurement(row.durationMs);
  const timeToFirstTokenMs = measurement(row.timeToFirstTokenMs);
  return {
    id: row.id,
    sessionId: row.sessionId,
    startedAt: row.startedAt,
    querySource: row.querySource,
    providerId: row.providerId,
    modelId: row.modelId,
    status: row.status,
    inputTokens,
    uncachedInputTokens: Math.max(0, inputTokens - cacheReadTokens),
    outputTokens: integer(row.outputTokens),
    cacheReadTokens,
    cacheCreationTokens: integer(row.cacheCreationTokens),
    totalTokens: integer(row.providerTotalTokens ?? row.computedTotalTokens),
    cacheHitRate: inputTokens > 0 ? Math.min(1, cacheReadTokens / inputTokens) : null,
    tokensPerSecond:
      row.status === "completed"
        ? calculateRequestLogAverageTps(row.outputTokens, durationMs)
        : null,
    durationMs,
    timeToFirstTokenMs,
    costUsd: measurement(row.costUsd),
    httpStatus:
      row.httpStatus !== null && row.httpStatus >= 100 && row.httpStatus <= 599
        ? row.httpStatus
        : null,
    retryCount: integer(row.retryCount),
  };
}

function integer(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function measurement(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}
