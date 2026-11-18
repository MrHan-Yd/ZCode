import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_REQUEST_LOG_MAX_PAGE_SIZE,
  calculateRequestLogAverageTps,
  modelRequestLogGroupSchema,
  modelRequestLogRecordSchema,
  modelRequestLogsRequestSchema,
  modelRequestLogsServiceRequestSchema,
  modelRequestLogsSnapshotSchema,
} from "./model-request-logs.js";

const query = {
  range: "7d",
  view: "requests",
  page: 1,
  pageSize: 50,
  sortDirection: "desc",
  timeZone: "Asia/Shanghai",
} as const;

const record = {
  id: "request-1",
  sessionId: "session-1",
  startedAt: 1_000,
  querySource: "main_turn",
  providerId: "provider-1",
  modelId: "model-1",
  status: "completed",
  inputTokens: 100,
  uncachedInputTokens: 20,
  outputTokens: 10,
  cacheReadTokens: 80,
  cacheCreationTokens: 0,
  totalTokens: 110,
  cacheHitRate: 0.8,
  tokensPerSecond: (10 * 1_000) / 1_500,
  timeToFirstTokenMs: 500,
  durationMs: 1_500,
  costUsd: null,
  httpStatus: null,
  retryCount: 0,
} as const;

test("请求日志平均速率使用整轮耗时，计量非法时保持未知", () => {
  assert.equal(calculateRequestLogAverageTps(893, 36_490), (893 * 1_000) / 36_490);
  assert.equal(calculateRequestLogAverageTps(3_454, 109_660), (3_454 * 1_000) / 109_660);
  assert.equal(calculateRequestLogAverageTps(0, 1_500), 0);
  for (const outputTokens of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(calculateRequestLogAverageTps(outputTokens, 1_500), null);
  }
  for (const durationMs of [
    null,
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.equal(calculateRequestLogAverageTps(100, durationMs), null);
  }
  assert.equal(calculateRequestLogAverageTps(Number.MAX_VALUE, 1), null);
});

test("请求日志 query 严格限定视图、状态、时区与分页上限", () => {
  assert.deepEqual(modelRequestLogsRequestSchema.parse(query), query);
  assert.equal(modelRequestLogsRequestSchema.safeParse({ ...query, range: "today" }).success, true);
  for (const patch of [
    { page: 0 },
    { page: 100_001 },
    { pageSize: MODEL_REQUEST_LOG_MAX_PAGE_SIZE + 1 },
    { pageSize: 0 },
    { pageSize: 1.5 },
    { view: "unknown" },
    { status: "success" },
    { range: "all" },
    { timeZone: "not/a-time-zone" },
    { prompt: "never admitted" },
  ]) {
    assert.equal(modelRequestLogsRequestSchema.safeParse({ ...query, ...patch }).success, false);
  }
  for (const status of ["completed", "error", "cancelled", "running"]) {
    assert.equal(modelRequestLogsRequestSchema.safeParse({ ...query, status }).success, true);
  }
});

test("Host 路由身份只在服务契约携带，CLI 查询不能接收或忽略远端身份", () => {
  const remote = {
    ...query,
    workspacePath: "/fixture",
    workspaceIdentity: "fixture-identity",
    remoteSessionId: "fixture-attachment",
  };
  assert.deepEqual(modelRequestLogsServiceRequestSchema.parse(remote), remote);
  assert.equal(modelRequestLogsRequestSchema.safeParse(remote).success, false);
  assert.equal(
    modelRequestLogsServiceRequestSchema.safeParse({
      ...query,
      workspaceIdentity: "fixture-identity",
    }).success,
    false,
  );
  assert.equal(
    modelRequestLogsServiceRequestSchema.safeParse({ ...query, prompt: "not allowed" }).success,
    false,
  );
});

test("请求日志记录区分未知费用与已知零费用并拒绝敏感扩展字段", () => {
  assert.equal(modelRequestLogRecordSchema.parse(record).costUsd, null);
  assert.equal(modelRequestLogRecordSchema.parse({ ...record, costUsd: 0 }).costUsd, 0);
  assert.equal(modelRequestLogRecordSchema.parse({ ...record, httpStatus: 429 }).httpStatus, 429);
  for (const patch of [
    { costUsd: -1 },
    { costUsd: Number.POSITIVE_INFINITY },
    { httpStatus: 999 },
    { cacheHitRate: 1.01 },
    { durationMs: -1 },
    { headers: { Authorization: "fixture" } },
    { errorMessage: "not part of the UI contract" },
    { rawUsage: {} },
    { providerMetadata: {} },
    { responseBody: "not part of the UI contract" },
  ]) {
    assert.equal(modelRequestLogRecordSchema.safeParse({ ...record, ...patch }).success, false);
  }
});

test("请求日志分组保留供应商身份、部分费用样本数与可空计量", () => {
  const group = {
    providerId: "provider-1",
    modelId: "model-1",
    requestCount: 2,
    totalTokens: 110,
    costUsd: 0,
    costKnownCount: 1,
    successRate: 0.5,
    tokensPerSecond: null,
    timeToFirstTokenMs: null,
  };
  assert.deepEqual(modelRequestLogGroupSchema.parse(group), group);
  assert.equal(modelRequestLogGroupSchema.safeParse({ ...group, successRate: 1.1 }).success, false);
  assert.equal(modelRequestLogGroupSchema.safeParse({ ...group, requestCount: -1 }).success, false);
});

test("请求日志快照传输行数有硬上限", () => {
  const snapshot = {
    range: "7d",
    view: "requests",
    generatedAt: 2_000,
    timeZone: "UTC",
    page: 1,
    pageSize: 50,
    totalCount: 1,
    counts: { requests: 1, providers: 1, models: 1 },
    requests: [record],
    groups: [],
  };
  assert.equal(modelRequestLogsSnapshotSchema.safeParse(snapshot).success, true);
  assert.equal(
    modelRequestLogsSnapshotSchema.safeParse({
      ...snapshot,
      requests: Array.from({ length: MODEL_REQUEST_LOG_MAX_PAGE_SIZE + 1 }, () => record),
    }).success,
    false,
  );
});
