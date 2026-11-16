import { z } from "zod";

export const MODEL_REQUEST_LOG_RANGES = ["today", "7d", "30d"] as const;
export const MODEL_REQUEST_LOG_VIEWS = ["requests", "providers", "models"] as const;
export const MODEL_REQUEST_LOG_STATUSES = ["running", "completed", "error", "cancelled"] as const;
export const MODEL_REQUEST_LOG_MAX_PAGE_SIZE = 100;
/** UI 默认页大小：长列表默认 20 行，翻页控件在表格上方，避免滚到底才能翻页。 */
export const MODEL_REQUEST_LOG_PAGE_SIZE = 20;

const countSchema = z.number().int().nonnegative();
const measurementSchema = z.number().finite().nonnegative().nullable();
const identifierSchema = z.string().min(1);

export const modelRequestLogsRequestSchema = z
  .object({
    range: z.enum(MODEL_REQUEST_LOG_RANGES),
    view: z.enum(MODEL_REQUEST_LOG_VIEWS),
    status: z.enum(MODEL_REQUEST_LOG_STATUSES).optional(),
    page: z.number().int().min(1).max(100_000),
    pageSize: z.number().int().min(1).max(MODEL_REQUEST_LOG_MAX_PAGE_SIZE),
    sortDirection: z.enum(["asc", "desc"]),
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Invalid time zone")
      .optional(),
  })
  .strict();

export const modelRequestLogsServiceRequestSchema = modelRequestLogsRequestSchema
  .extend({
    workspacePath: z.string().trim().min(1).max(4096).optional(),
    workspaceIdentity: z.string().trim().min(1).max(4096).optional(),
    remoteSessionId: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .refine(
    (request) =>
      !(request.workspaceIdentity || request.remoteSessionId) || Boolean(request.workspacePath),
    "Remote request logs require a workspace path",
  );
export type ModelRequestLogsServiceRequest = z.infer<typeof modelRequestLogsServiceRequestSchema>;

export const modelRequestLogRecordSchema = z
  .object({
    id: identifierSchema,
    sessionId: identifierSchema,
    startedAt: countSchema,
    querySource: z.string(),
    providerId: identifierSchema,
    modelId: identifierSchema,
    status: z.enum(MODEL_REQUEST_LOG_STATUSES),
    inputTokens: countSchema,
    uncachedInputTokens: countSchema,
    outputTokens: countSchema,
    cacheReadTokens: countSchema,
    cacheCreationTokens: countSchema,
    totalTokens: countSchema,
    cacheHitRate: z.number().min(0).max(1).nullable(),
    tokensPerSecond: measurementSchema,
    timeToFirstTokenMs: measurementSchema,
    durationMs: measurementSchema,
    costUsd: measurementSchema,
    httpStatus: z.number().int().min(100).max(599).nullable(),
    retryCount: countSchema,
  })
  .strict();

export const modelRequestLogGroupSchema = z
  .object({
    providerId: identifierSchema,
    modelId: identifierSchema.nullable(),
    requestCount: countSchema,
    totalTokens: countSchema,
    costUsd: measurementSchema,
    costKnownCount: countSchema,
    successRate: z.number().min(0).max(1),
    tokensPerSecond: measurementSchema,
    timeToFirstTokenMs: measurementSchema,
  })
  .strict();

export const modelRequestLogsSnapshotSchema = z
  .object({
    range: z.enum(MODEL_REQUEST_LOG_RANGES),
    view: z.enum(MODEL_REQUEST_LOG_VIEWS),
    generatedAt: countSchema,
    timeZone: z.string(),
    page: z.number().int().min(1).max(100_000),
    pageSize: z.number().int().min(1).max(MODEL_REQUEST_LOG_MAX_PAGE_SIZE),
    totalCount: countSchema,
    counts: z
      .object({ requests: countSchema, providers: countSchema, models: countSchema })
      .strict(),
    requests: z.array(modelRequestLogRecordSchema).max(MODEL_REQUEST_LOG_MAX_PAGE_SIZE),
    groups: z.array(modelRequestLogGroupSchema).max(MODEL_REQUEST_LOG_MAX_PAGE_SIZE),
  })
  .strict();

export type ModelRequestLogsRequest = z.infer<typeof modelRequestLogsRequestSchema>;
export type ModelRequestLogRecord = z.infer<typeof modelRequestLogRecordSchema>;
export type ModelRequestLogGroup = z.infer<typeof modelRequestLogGroupSchema>;
export type ModelRequestLogsSnapshot = z.infer<typeof modelRequestLogsSnapshotSchema>;
export type ModelRequestLogRange = ModelRequestLogsRequest["range"];
export type ModelRequestLogView = ModelRequestLogsRequest["view"];
export type ModelRequestLogStatus = NonNullable<ModelRequestLogsRequest["status"]>;
