import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import { queryAppUsage } from "../src/storage/session-store/repositories/usage.js";

/**
 * App Usage 聚合的语义锁定：查询从「多条 SQL 各扫一遍」收敛成
 * 「model / tool 各一次分组」，断言 totals / models / days / dayModels / tools 不被合并改坏。
 */

const DAY_MS = 86_400_000;
const DAY0 = 1_000;
const DAY1 = DAY_MS + 1_000;

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runSqliteSessionMigrations(db, ":memory:");
  for (const sessionID of ["s1", "s2"]) {
    db.prepare(
      `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
       values (?, 'project', 'slug', 'D:/workspace', 'title', '0.0.0', 0, 0)`,
    ).run(sessionID);
  }
  return db;
}

function insertModelRow(
  db: DatabaseSync,
  input: {
    id: string;
    sessionID: string;
    modelID: string;
    startedAt: number;
    status?: "completed" | "error";
    ttftMs: number | null;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens?: number;
    cacheCreationTokens?: number;
    cacheReadTokens?: number;
    computedTotalTokens: number;
  },
): void {
  db.prepare(
    `insert into model_usage (
       id, logical_request_id, session_id, query_source, provider_id, model_id, status,
       started_at, time_to_first_token_ms, input_tokens, output_tokens, reasoning_tokens,
       cache_creation_input_tokens, cache_read_input_tokens, computed_total_tokens
     ) values (?, ?, ?, 'main_turn', 'provider', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.id,
    input.sessionID,
    input.modelID,
    input.status ?? "completed",
    input.startedAt,
    input.ttftMs,
    input.inputTokens,
    input.outputTokens,
    input.reasoningTokens ?? 0,
    input.cacheCreationTokens ?? 0,
    input.cacheReadTokens ?? 0,
    input.computedTotalTokens,
  );
}

function insertTurnRow(
  db: DatabaseSync,
  input: { sessionID: string; turnID: string; startedAt: number; durationMs: number },
): void {
  db.prepare(
    `insert into turn_usage (session_id, turn_id, status, started_at, duration_ms)
     values (?, ?, 'completed', ?, ?)`,
  ).run(input.sessionID, input.turnID, input.startedAt, input.durationMs);
}

function insertToolRow(
  db: DatabaseSync,
  input: {
    id: string;
    sessionID: string;
    toolName: string;
    startedAt: number;
    status?: "completed" | "error";
    durationMs: number | null;
  },
): void {
  db.prepare(
    `insert into tool_usage (
       id, session_id, tool_call_id, tool_name, status, started_at, duration_ms
     ) values (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.sessionID,
    input.id,
    input.toolName,
    input.status ?? "completed",
    input.startedAt,
    input.durationMs,
  );
}

test("queryAppUsage 单遍聚合保持 totals/models/days/dayModels/tools 口径", async () => {
  const db = createDb();
  insertModelRow(db, {
    id: "r1",
    sessionID: "s1",
    modelID: "model-a",
    startedAt: DAY0,
    ttftMs: 100,
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 2,
    cacheCreationTokens: 1,
    cacheReadTokens: 3,
    computedTotalTokens: 20,
  });
  insertModelRow(db, {
    id: "r2",
    sessionID: "s1",
    modelID: "model-a",
    startedAt: DAY0,
    status: "error",
    ttftMs: null,
    inputTokens: 4,
    outputTokens: 1,
    computedTotalTokens: 5,
  });
  insertModelRow(db, {
    id: "r3",
    sessionID: "s2",
    modelID: "model-b",
    startedAt: DAY1,
    ttftMs: 300,
    inputTokens: 20,
    outputTokens: 10,
    computedTotalTokens: 30,
  });
  insertTurnRow(db, { sessionID: "s1", turnID: "t1", startedAt: DAY0, durationMs: 1_000 });
  insertTurnRow(db, { sessionID: "s1", turnID: "t2", startedAt: DAY1, durationMs: 2_000 });
  insertTurnRow(db, { sessionID: "s2", turnID: "t3", startedAt: DAY0, durationMs: 500 });
  insertToolRow(db, {
    id: "tool1",
    sessionID: "s1",
    toolName: "Bash",
    startedAt: DAY0,
    durationMs: 100,
  });
  insertToolRow(db, {
    id: "tool2",
    sessionID: "s1",
    toolName: "Read",
    startedAt: DAY0,
    status: "error",
    durationMs: null,
  });
  insertToolRow(db, {
    id: "tool3",
    sessionID: "s2",
    toolName: "Bash",
    startedAt: DAY1,
    durationMs: 300,
  });

  const result = await queryAppUsage(db, { since: 0, until: DAY1 + 1_000, tzOffsetMs: 0 });

  assert.deepEqual(result.totals, {
    totalTokens: 55,
    inputTokens: 34,
    outputTokens: 16,
    reasoningTokens: 2,
    cacheCreationTokens: 1,
    cacheReadTokens: 3,
    modelRequestCount: 3,
    modelErrorCount: 1,
    avgTimeToFirstTokenMs: 200,
  });
  assert.deepEqual(result.models, [
    { modelId: "model-b", totalTokens: 30, inputTokens: 20, outputTokens: 10, requestCount: 1 },
    { modelId: "model-a", totalTokens: 25, inputTokens: 14, outputTokens: 6, requestCount: 2 },
  ]);
  assert.deepEqual(result.days, [
    { dayIndex: 0, totalTokens: 25, turnCount: 2, toolCallCount: 2 },
    { dayIndex: 1, totalTokens: 30, turnCount: 1, toolCallCount: 1 },
  ]);
  assert.deepEqual(
    [...result.dayModels].sort(
      (left, right) => left.dayIndex - right.dayIndex || left.modelId!.localeCompare(right.modelId!),
    ),
    [
      { dayIndex: 0, modelId: "model-a", totalTokens: 25 },
      { dayIndex: 1, modelId: "model-b", totalTokens: 30 },
    ],
  );
  assert.deepEqual(result.toolTotals, { toolCallCount: 3, toolErrorCount: 1 });
  assert.deepEqual(result.tools, [
    { toolName: "Bash", callCount: 2, errorCount: 0, avgDurationMs: 200 },
    { toolName: "Read", callCount: 1, errorCount: 1, avgDurationMs: null },
  ]);
  assert.deepEqual(result.turnTotals, {
    totalSessions: 2,
    totalTurns: 3,
    avgTurnDurationMs: 3_500 / 3,
    longestSessionMs: 3_000,
  });
  db.close();
});

test("迁移 0023 创建 App Usage 覆盖索引", () => {
  const db = createDb();
  const indexes = db
    .prepare("select name from sqlite_master where type = 'index'")
    .all()
    .map((row) => (row as { name: string }).name);
  assert.ok(indexes.includes("model_usage_started_agg_idx"));
  assert.ok(indexes.includes("tool_usage_started_agg_idx"));
  db.close();
});
