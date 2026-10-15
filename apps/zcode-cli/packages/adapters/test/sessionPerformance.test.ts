import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { averageTtftMs, calculateOutputTps } from "@zcode/shared";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import { querySessionPerformance } from "../src/storage/session-store/repositories/usage.js";

const SESSION_ID = "session-performance-test";
/** 主会话口径：只有主链请求算这个会话自己的输出。 */
const MAIN_TURN = ["main_turn"] as const;

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runSqliteSessionMigrations(db, ":memory:");
  insertSession(db, SESSION_ID);
  // 跨会话隔离断言需要另一个真实会话行：usage 表有 FK 指向 session。
  insertSession(db, "other-session");
  return db;
}

function insertSession(db: DatabaseSync, sessionID: string): void {
  db.prepare(
    `insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
     values (?, 'project', 'slug', 'D:/workspace', 'title', '0.0.0', 0, 0)`,
  ).run(sessionID);
}

interface ModelRowInput {
  id: string;
  sessionID?: string;
  querySource?: string;
  status?: string;
  durationMs: number | null;
  ttftMs: number | null;
  outputTokens: number;
}

function insertModelRow(db: DatabaseSync, input: ModelRowInput): void {
  db.prepare(
    `insert into model_usage (
       id, logical_request_id, session_id, query_source, provider_id, model_id, status,
       started_at, duration_ms, time_to_first_token_ms, output_tokens
     ) values (?, ?, ?, ?, 'provider', 'model', ?, 0, ?, ?, ?)`,
  ).run(
    input.id,
    input.id,
    input.sessionID ?? SESSION_ID,
    input.querySource ?? "main_turn",
    input.status ?? "completed",
    input.durationMs,
    input.ttftMs,
    input.outputTokens,
  );
}

function insertToolRow(
  db: DatabaseSync,
  input: { id: string; sessionID?: string; durationMs: number | null },
): void {
  db.prepare(
    `insert into tool_usage (
       id, session_id, tool_call_id, tool_name, status, started_at, duration_ms
     ) values (?, ?, ?, 'Bash', 'completed', 0, ?)`,
  ).run(input.id, input.sessionID ?? SESSION_ID, input.id, input.durationMs);
}

test("会话性能聚合只算主链成功请求，TPS 用首输出之后的生成时长", async () => {
  const db = createDb();
  insertModelRow(db, { id: "a", durationMs: 10_000, ttftMs: 2_000, outputTokens: 800 });
  // 没有 TTFT 的请求照样计入模型用时，但不能进 TPS 的分子或分母。
  insertModelRow(db, { id: "b", durationMs: 5_000, ttftMs: null, outputTokens: 500 });
  // 侧车请求（压缩/标题）不是用户会话的输出。
  insertModelRow(db, {
    id: "sidecar",
    querySource: "compact",
    durationMs: 9_999,
    ttftMs: 100,
    outputTokens: 9_000,
  });
  // 失败请求可能带着残缺的计量，混进来会同时污染分子与分母。
  insertModelRow(db, {
    id: "failed",
    status: "error",
    durationMs: 7_777,
    ttftMs: 10,
    outputTokens: 5,
  });
  insertToolRow(db, { id: "t1", durationMs: 1_200 });
  insertToolRow(db, { id: "t2", durationMs: 300 });
  // 别的会话的用量不能串进来。
  insertToolRow(db, { id: "t3", sessionID: "other-session", durationMs: 9_999 });
  insertModelRow(db, {
    id: "other-model",
    sessionID: "other-session",
    durationMs: 9_999,
    ttftMs: 1,
    outputTokens: 9_000,
  });

  const result = await querySessionPerformance(db, { sessionID: SESSION_ID as never, querySources: MAIN_TURN });

  assert.equal(result.modelMs, 15_000);
  assert.equal(result.modelRequestCount, 2);
  assert.equal(result.ttftSumMs, 2_000);
  assert.equal(result.ttftCount, 1);
  assert.equal(result.tpsOutputTokens, 800);
  assert.equal(result.generationMs, 8_000);
  assert.equal(result.toolMs, 1_500);
  assert.equal(result.toolCallCount, 2);
  // 组装口径：平均 2000 / 1，速度 800 / 8 秒 = 100 tok/s。
  assert.equal(averageTtftMs(result.ttftSumMs, result.ttftCount), 2_000);
  assert.equal(calculateOutputTps(result.tpsOutputTokens, result.generationMs), 100);
  db.close();
});

test("时长不大于首 token 等待的请求只进模型用时，不进 TPS", async () => {
  const db = createDb();
  insertModelRow(db, { id: "a", durationMs: 10_000, ttftMs: 2_000, outputTokens: 800 });
  // duration <= ttft 时没有可用的生成时长；用请求总时长顶替会把速度算低。
  insertModelRow(db, { id: "c", durationMs: 1_000, ttftMs: 1_000, outputTokens: 300 });

  const result = await querySessionPerformance(db, { sessionID: SESSION_ID as never, querySources: MAIN_TURN });

  assert.equal(result.modelMs, 11_000);
  assert.equal(result.tpsOutputTokens, 800);
  assert.equal(result.generationMs, 8_000);
  assert.equal(calculateOutputTps(result.tpsOutputTokens, result.generationMs), 100);
  db.close();
});

test("空会话返回零值，平均与速度不可用而不是 0", async () => {
  const db = createDb();
  const result = await querySessionPerformance(db, { sessionID: SESSION_ID as never, querySources: MAIN_TURN });

  assert.equal(result.modelMs, 0);
  assert.equal(result.toolMs, 0);
  assert.equal(result.modelRequestCount, 0);
  assert.equal(result.ttftCount, 0);
  assert.equal(averageTtftMs(result.ttftSumMs, result.ttftCount), null);
  // 没有生成时长时给 null：0 tok/s 会被读成"模型卡住了"。
  assert.equal(calculateOutputTps(result.tpsOutputTokens, result.generationMs), null);
  db.close();
});

test("子会话的请求只在 subagent 口径下算数，主链口径读出来是 0", async () => {
  const db = createDb();
  const CHILD_SESSION = "subagent-child-session";
  insertSession(db, CHILD_SESSION);
  // 子代理的模型请求记在子会话 id 上，query_source 是 subagent——不是 main_turn。
  insertModelRow(db, {
    id: "child-1",
    sessionID: CHILD_SESSION,
    querySource: "subagent",
    durationMs: 6_000,
    ttftMs: 1_000,
    outputTokens: 500,
  });
  insertModelRow(db, {
    id: "child-2",
    sessionID: CHILD_SESSION,
    querySource: "subagent",
    durationMs: 4_000,
    ttftMs: 1_000,
    outputTokens: 300,
  });

  const asChild = await querySessionPerformance(db, {
    sessionID: CHILD_SESSION as never,
    querySources: ["subagent"],
  });
  // 组装口径：1000 / 2 平均 TTFT，800 token / 8 秒生成 = 100 tok/s。
  assert.equal(asChild.modelRequestCount, 2);
  assert.equal(asChild.tpsOutputTokens, 800);
  assert.equal(asChild.generationMs, 8_000);
  assert.equal(averageTtftMs(asChild.ttftSumMs, asChild.ttftCount), 1_000);
  assert.equal(calculateOutputTps(asChild.tpsOutputTokens, asChild.generationMs), 100);

  // 同一批行用主链口径读：全 0，而不是"这个子智能体很慢"。这正是加批次支持前
  // 拿子会话 id 调单会话入口会得到的结果，也是必须按会话种类选口径的理由。
  const asMainTurn = await querySessionPerformance(db, {
    sessionID: CHILD_SESSION as never,
    querySources: MAIN_TURN,
  });
  assert.equal(asMainTurn.modelRequestCount, 0);
  assert.equal(calculateOutputTps(asMainTurn.tpsOutputTokens, asMainTurn.generationMs), null);
  db.close();
});
