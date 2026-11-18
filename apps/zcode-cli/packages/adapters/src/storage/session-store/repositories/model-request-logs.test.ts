import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ModelRequestLogsQueryInput, SessionId } from "@zcode/contracts";
import { modelRequestLogsSnapshotSchema } from "@zcode/shared";
import { runSqliteSessionMigrations } from "../migration-runner.js";
import { queryModelRequestLogs } from "./model-request-logs.js";
import { recordModelUsage } from "./usage.js";

const NOW = Date.now();
const query: ModelRequestLogsQueryInput = {
  range: "7d",
  view: "requests",
  page: 1,
  pageSize: 2,
  sortDirection: "desc",
  timeZone: "UTC",
  since: NOW - 100_000,
  until: NOW,
};

function createDb() {
  const db = new DatabaseSync(":memory:");
  runSqliteSessionMigrations(db, ":memory:");
  db.prepare(
    "insert into session (id, project_id, slug, directory, title, version, time_created, time_updated) values ('s1', 'p1', 's1', '/fixture', 'Fixture', '1', 0, 0)",
  ).run();
  return db;
}

async function write(db: DatabaseSync, id: string, patch: Record<string, unknown> = {}) {
  await recordModelUsage(db, {
    id,
    logicalRequestId: id,
    sessionID: "s1" as SessionId,
    querySource: "main_turn",
    providerId: "provider-a",
    modelId: "same-model",
    status: "completed",
    startedAt: NOW - 1_000,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadInputTokens: 80,
    cacheCreationInputTokens: 5,
    providerTotalTokens: 110,
    durationMs: 1_500,
    timeToFirstTokenMs: 500,
    ...patch,
  });
}

test("明细分页保持完整计数、稳定时间/ID 排序且不返回内部字段", async () => {
  const db = createDb();
  try {
    await write(db, "r-a");
    await write(db, "r-b", {
      providerId: "provider-b",
      errorMessage: "private",
      rawUsage: { secret: 1 },
    });
    await write(db, "r-c", {
      startedAt: NOW - 2_000,
      status: "error",
      httpStatus: 429,
      retryCount: 2,
    });
    const first = await queryModelRequestLogs(db, query);
    assert.deepEqual(first.counts, { requests: 3, providers: 2, models: 2 });
    assert.equal(first.totalCount, 3);
    assert.deepEqual(
      first.requests.map((row) => row.id),
      ["r-b", "r-a"],
    );
    assert.equal(first.groups.length, 0);
    assert.equal("rawUsage" in first.requests[0]!, false);
    assert.equal("errorMessage" in first.requests[0]!, false);
    modelRequestLogsSnapshotSchema.parse(first);
    const second = await queryModelRequestLogs(db, { ...query, page: 2 });
    assert.deepEqual(
      second.requests.map((row) => row.id),
      ["r-c"],
    );
    assert.equal(second.requests[0]?.httpStatus, 429);
    assert.equal(second.requests[0]?.retryCount, 2);
    assert.deepEqual(second.counts, first.counts);
  } finally {
    db.close();
  }
});

test("平均速率使用整轮耗时，不把推理和等待期间的输出挤入末尾时间", async () => {
  const db = createDb();
  try {
    await write(db, "short-tail", {
      outputTokens: 893,
      reasoningTokens: 700,
      durationMs: 36_490,
      timeToFirstTokenMs: 36_125,
      retryCount: 2,
    });
    await write(db, "long-reasoning", {
      outputTokens: 3_454,
      reasoningTokens: 3_000,
      durationMs: 109_660,
      timeToFirstTokenMs: 109_130,
    });
    const result = await queryModelRequestLogs(db, query);
    const short = result.requests.find((row) => row.id === "short-tail")!;
    const long = result.requests.find((row) => row.id === "long-reasoning")!;
    assert.equal(short.outputTokens, 893);
    assert.equal(short.tokensPerSecond, (893 * 1_000) / 36_490);
    assert.equal(short.retryCount, 2);
    assert.equal(long.outputTokens, 3_454);
    assert.equal(long.tokensPerSecond, (3_454 * 1_000) / 109_660);
    assert.equal(long.timeToFirstTokenMs, 109_130);
    assert.equal(long.durationMs, 109_660);
    modelRequestLogsSnapshotSchema.parse(result);
  } finally {
    db.close();
  }
});

test("平均速率不依赖首字缺失、为零或不早于请求结束", async () => {
  const db = createDb();
  try {
    const firstTokens = [undefined, 0, 1_500, 2_000];
    for (const [index, timeToFirstTokenMs] of firstTokens.entries()) {
      await write(db, `ttft-${index}`, { timeToFirstTokenMs });
    }
    const result = await queryModelRequestLogs(db, { ...query, pageSize: 50 });
    for (const row of result.requests) {
      assert.equal(row.tokensPerSecond, (10 * 1_000) / 1_500, row.id);
    }
    assert.equal(result.requests.find((row) => row.id === "ttft-0")?.timeToFirstTokenMs, null);
    for (const view of ["providers", "models"] as const) {
      const groups = await queryModelRequestLogs(db, { ...query, view });
      assert.equal(groups.groups[0]?.tokensPerSecond, (40 * 1_000) / 6_000);
      assert.equal(groups.groups[0]?.timeToFirstTokenMs, 3_500 / 3);
      modelRequestLogsSnapshotSchema.parse(groups);
    }
  } finally {
    db.close();
  }
});

test("非法总耗时和非成功请求不参与平均速率，零输出与未知计量分开", async () => {
  const db = createDb();
  try {
    const durations = [
      undefined,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];
    for (const [index, durationMs] of durations.entries()) {
      await write(db, `invalid-duration-${index}`, { durationMs });
    }
    for (const status of ["error", "cancelled", "running"] as const) {
      await write(db, status, { status, outputTokens: 1_000 });
    }
    const result = await queryModelRequestLogs(db, { ...query, pageSize: 50 });
    for (const row of result.requests) assert.equal(row.tokensPerSecond, null, row.id);
    const unknown = await queryModelRequestLogs(db, { ...query, view: "providers" });
    assert.equal(unknown.groups[0]?.tokensPerSecond, null);

    await write(db, "zero-output", { outputTokens: 0 });
    const zero = await queryModelRequestLogs(db, { ...query, view: "models" });
    assert.equal(zero.groups[0]?.tokensPerSecond, 0);
    await write(db, "valid", {
      outputTokens: 10,
      durationMs: 2_000,
      timeToFirstTokenMs: undefined,
    });
    for (const view of ["providers", "models"] as const) {
      const groups = await queryModelRequestLogs(db, { ...query, view });
      assert.equal(groups.groups[0]?.tokensPerSecond, (10 * 1_000) / 3_500);
      modelRequestLogsSnapshotSchema.parse(groups);
    }
    const details = await queryModelRequestLogs(db, { ...query, pageSize: 50 });
    assert.equal(details.requests.find((row) => row.id === "zero-output")?.tokensPerSecond, 0);
    assert.equal(details.requests.find((row) => row.id === "valid")?.tokensPerSecond, 5);
  } finally {
    db.close();
  }
});

test("非法历史输出不污染分组平均速率的分子或分母", async () => {
  const db = createDb();
  try {
    for (const [index, outputTokens] of [-1, Number.POSITIVE_INFINITY].entries()) {
      const id = `invalid-output-${index}`;
      await write(db, id);
      db.prepare("update model_usage set output_tokens = ? where id = ?").run(outputTokens, id);
    }
    await write(db, "valid");
    const result = await queryModelRequestLogs(db, { ...query, pageSize: 50 });
    assert.equal(
      result.requests.find((row) => row.id === "invalid-output-0")?.tokensPerSecond,
      null,
    );
    assert.equal(
      result.requests.find((row) => row.id === "invalid-output-1")?.tokensPerSecond,
      null,
    );
    for (const view of ["providers", "models"] as const) {
      const groups = await queryModelRequestLogs(db, { ...query, view });
      assert.equal(groups.groups[0]?.tokensPerSecond, (10 * 1_000) / 1_500);
    }
  } finally {
    db.close();
  }
});

test("聚合区分同名模型的供应商，平均速率按总耗时加权、失败/取消不污染计量", async () => {
  const db = createDb();
  try {
    await write(db, "r1", { costUsd: 0.01 });
    await write(db, "r2", {
      outputTokens: 90,
      providerTotalTokens: 190,
      durationMs: 9_500,
      costUsd: 0,
    });
    await write(db, "r3", { status: "error", timeToFirstTokenMs: 100_000, outputTokens: 1_000 });
    await write(db, "r4", { status: "cancelled" });
    await write(db, "r5", {
      providerId: "provider-b",
      durationMs: undefined,
      timeToFirstTokenMs: undefined,
    });
    const result = await queryModelRequestLogs(db, { ...query, view: "models" });
    assert.equal(result.totalCount, 2);
    assert.deepEqual(result.counts, { requests: 5, providers: 2, models: 2 });
    assert.equal(result.requests.length, 0);
    const group = result.groups[0]!;
    assert.equal(group.providerId, "provider-a");
    assert.equal(group.modelId, "same-model");
    assert.equal(group.requestCount, 4);
    assert.equal(group.successRate, 0.5);
    assert.equal(group.tokensPerSecond, (100 * 1_000) / 11_000);
    assert.notEqual(group.tokensPerSecond, ((10 * 1_000) / 1_500 + (90 * 1_000) / 9_500) / 2);
    assert.equal(group.timeToFirstTokenMs, 500);
    assert.equal(group.costUsd, 0.01);
    assert.equal(group.costKnownCount, 2);
    assert.equal(result.groups[1]?.tokensPerSecond, null);
    assert.equal(result.groups[1]?.costUsd, null);
    const providers = await queryModelRequestLogs(db, {
      ...query,
      view: "providers",
      pageSize: 1,
      sortDirection: "asc",
    });
    assert.equal(providers.groups.length, 1);
    assert.equal(providers.groups[0]?.providerId, "provider-b");
    assert.equal(providers.groups[0]?.modelId, null);
    assert.equal(providers.totalCount, 2);
  } finally {
    db.close();
  }
});

test("新增输入与缓存命中兼容 v6 total input 和旧版分离缓存", async () => {
  const db = createDb();
  try {
    await write(db, "v6");
    await write(db, "old", { inputTokens: 15, providerTotalTokens: 110 });
    await write(db, "no-input", {
      inputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
    const result = await queryModelRequestLogs(db, { ...query, pageSize: 50 });
    const v6 = result.requests.find((row) => row.id === "v6")!;
    const old = result.requests.find((row) => row.id === "old")!;
    assert.equal(v6.inputTokens, 100);
    assert.equal(old.inputTokens, 100);
    assert.equal(v6.uncachedInputTokens, 20);
    assert.equal(old.uncachedInputTokens, 20);
    assert.equal(v6.cacheHitRate, 0.8);
    assert.equal(old.cacheHitRate, 0.8);
    assert.equal(result.requests.find((row) => row.id === "no-input")?.cacheHitRate, null);
  } finally {
    db.close();
  }
});

test("范围与状态过滤含上下界，页越界空列表而计数保留，非法参数拒绝", async () => {
  const db = createDb();
  try {
    await write(db, "since", { startedAt: query.since });
    await write(db, "until", { startedAt: query.until, status: "error" });
    await write(db, "outside", { startedAt: query.since - 1 });
    const result = await queryModelRequestLogs(db, query);
    assert.equal(result.totalCount, 2);
    const errors = await queryModelRequestLogs(db, { ...query, status: "error", page: 2 });
    assert.equal(errors.totalCount, 1);
    assert.equal(errors.requests.length, 0);
    await assert.rejects(queryModelRequestLogs(db, { ...query, pageSize: 101 }));
    await assert.rejects(queryModelRequestLogs(db, { ...query, status: "invalid" as never }));
  } finally {
    db.close();
  }
});

test("迁移后历史费用未知，已知零成本与重复 ID 更新均保留", async () => {
  const db = createDb();
  try {
    db.prepare(
      "insert into model_usage (id, logical_request_id, session_id, query_source, provider_id, model_id, status, started_at) values ('legacy', 'legacy', 's1', 'main_turn', 'provider-a', 'same-model', 'completed', ?)",
    ).run(NOW);
    await write(db, "new", { costUsd: 0, httpStatus: 503 });
    await write(db, "new", { costUsd: 0.02, httpStatus: undefined });
    const result = await queryModelRequestLogs(db, query);
    assert.equal(result.counts.requests, 2);
    assert.equal(result.requests.find((row) => row.id === "legacy")?.costUsd, null);
    assert.equal(result.requests.find((row) => row.id === "new")?.costUsd, 0.02);
    assert.equal(result.requests.find((row) => row.id === "new")?.httpStatus, null);
  } finally {
    db.close();
  }
});
