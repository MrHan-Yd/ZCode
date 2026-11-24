import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { SessionId } from "@zcode/contracts";
import { averageTtftMs, calculateRequestLogAverageTps } from "@zcode/shared";
import { runSqliteSessionMigrations } from "../src/storage/session-store/migration-runner.js";
import { querySessionPerformance } from "../src/storage/session-store/repositories/usage.js";

const SESSION_ID = "session-performance-test";
/** 主会话口径：只有主链请求算这个会话自己的输出。 */
const MAIN_TURN = ["main_turn"] as const;
const SUBAGENT = ["subagent"] as const;

async function withDb(run: (db: DatabaseSync) => Promise<void>): Promise<void> {
  const db = new DatabaseSync(":memory:");
  try {
    runSqliteSessionMigrations(db, ":memory:");
    insertSession(db, SESSION_ID);
    // 跨会话隔离断言需要另一个真实会话行：usage 表有 FK 指向 session。
    insertSession(db, "other-session");
    await run(db);
  } finally {
    db.close();
  }
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
  inputTokens?: number;
  reasoningTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

function insertModelRow(db: DatabaseSync, input: ModelRowInput): void {
  db.prepare(
    `insert into model_usage (
       id, logical_request_id, session_id, query_source, provider_id, model_id, status,
       started_at, duration_ms, time_to_first_token_ms, output_tokens, input_tokens,
       reasoning_tokens, cache_creation_input_tokens, cache_read_input_tokens
     ) values (?, ?, ?, ?, 'provider', 'model', ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.id,
    input.sessionID ?? SESSION_ID,
    input.querySource ?? "main_turn",
    input.status ?? "completed",
    input.durationMs,
    input.ttftMs,
    input.outputTokens,
    input.inputTokens ?? 0,
    input.reasoningTokens ?? 0,
    input.cacheCreationTokens ?? 0,
    input.cacheReadTokens ?? 0,
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

test("会话性能只算自身主链成功请求，TTFT 缺失不影响端到端 TPS", async () => {
  await withDb(async (db) => {
    insertModelRow(db, { id: "a", durationMs: 10_000, ttftMs: 2_000, outputTokens: 800 });
    insertModelRow(db, { id: "b", durationMs: 5_000, ttftMs: null, outputTokens: 500 });
    for (const querySource of ["compact", "title", "subagent"]) {
      insertModelRow(db, {
        id: querySource,
        querySource,
        durationMs: 9_999,
        ttftMs: 100,
        outputTokens: 9_000,
      });
    }
    // 非 completed 请求的残缺计量不能污染 TPS 任一侧。
    for (const status of ["error", "cancelled", "running"]) {
      insertModelRow(db, { id: status, status, durationMs: 7_777, ttftMs: 10, outputTokens: 5 });
    }
    insertToolRow(db, { id: "t1", durationMs: 1_200 });
    insertToolRow(db, { id: "t2", durationMs: 300 });
    insertToolRow(db, { id: "t3", sessionID: "other-session", durationMs: 9_999 });
    insertModelRow(db, {
      id: "other-model",
      sessionID: "other-session",
      durationMs: 9_999,
      ttftMs: 1,
      outputTokens: 9_000,
    });

    const result = await querySessionPerformance(db, {
      sessionID: SESSION_ID as SessionId,
      querySources: MAIN_TURN,
    });

    assert.equal(result.modelMs, 15_000);
    assert.equal(result.modelRequestCount, 2);
    assert.equal(result.ttftSumMs, 2_000);
    assert.equal(result.ttftCount, 1);
    assert.equal(result.tpsOutputTokens, 1_300);
    assert.equal(result.tpsDurationMs, 15_000);
    assert.equal(result.toolMs, 1_500);
    assert.equal(result.toolCallCount, 2);
    assert.equal(averageTtftMs(result.ttftSumMs, result.ttftCount), 2_000);
    assert.equal(
      calculateRequestLogAverageTps(result.tpsOutputTokens, result.tpsDurationMs),
      1_300 / 15,
    );
  });
});

for (const ttftMs of [null, 0, 1_000, 2_000]) {
  test(`TTFT=${ttftMs} 不改变正耗时请求的 TPS 选样或总耗时`, async () => {
    await withDb(async (db) => {
      insertModelRow(db, { id: "sample", durationMs: 1_000, ttftMs, outputTokens: 300 });
      const result = await querySessionPerformance(db, {
        sessionID: SESSION_ID as SessionId,
        querySources: MAIN_TURN,
      });

      assert.equal(result.tpsOutputTokens, 300);
      assert.equal(result.tpsDurationMs, 1_000);
      assert.equal(
        calculateRequestLogAverageTps(result.tpsOutputTokens, result.tpsDurationMs),
        300,
      );
      assert.equal(result.ttftCount, ttftMs === null ? 0 : 1);
      assert.equal(averageTtftMs(result.ttftSumMs, result.ttftCount), ttftMs);
    });
  });
}

for (const durationMs of [null, 0, -1_000]) {
  test(`duration=${durationMs} 的输出和耗时同时排除，不能只进入 TPS 分子`, async () => {
    await withDb(async (db) => {
      insertModelRow(db, { id: "valid", durationMs: 10_000, ttftMs: 2_000, outputTokens: 800 });
      insertModelRow(db, { id: "invalid", durationMs, ttftMs: 0, outputTokens: 1_000_000 });
      const result = await querySessionPerformance(db, {
        sessionID: SESSION_ID as SessionId,
        querySources: MAIN_TURN,
      });

      assert.equal(result.modelRequestCount, 2);
      assert.equal(result.tpsOutputTokens, 800);
      assert.equal(result.tpsDurationMs, 10_000);
      assert.equal(calculateRequestLogAverageTps(result.tpsOutputTokens, result.tpsDurationMs), 80);
    });
  });
}

test("只有无效耗时的请求时没有 TPS 样本，速度为 null", async () => {
  await withDb(async (db) => {
    for (const durationMs of [null, 0, -1_000]) {
      insertModelRow(db, { id: `invalid-${durationMs}`, durationMs, ttftMs: 0, outputTokens: 500 });
    }
    const result = await querySessionPerformance(db, {
      sessionID: SESSION_ID as SessionId,
      querySources: MAIN_TURN,
    });

    assert.equal(result.tpsOutputTokens, 0);
    assert.equal(result.tpsDurationMs, 0);
    assert.equal(calculateRequestLogAverageTps(result.tpsOutputTokens, result.tpsDurationMs), null);
  });
});

for (const querySources of [MAIN_TURN, SUBAGENT]) {
  test(`${querySources[0]} 累计 TPS 按请求时长加权，而非逐请求速度的算术平均`, async () => {
    await withDb(async (db) => {
      insertModelRow(db, {
        id: "short",
        querySource: querySources[0],
        durationMs: 1_000,
        ttftMs: 100,
        outputTokens: 100,
      });
      insertModelRow(db, {
        id: "long",
        querySource: querySources[0],
        durationMs: 9_000,
        ttftMs: 8_000,
        outputTokens: 180,
      });
      const result = await querySessionPerformance(db, {
        sessionID: SESSION_ID as SessionId,
        querySources,
      });
      const tps = calculateRequestLogAverageTps(result.tpsOutputTokens, result.tpsDurationMs);

      assert.equal(result.tpsOutputTokens, 280);
      assert.equal(result.tpsDurationMs, 10_000);
      assert.equal(tps, 28);
      assert.notEqual(tps, (100 + 20) / 2);
    });
  });
}

test("provider 输出不重复加 reasoning，也不额外加输入、缓存或单列 reasoning", async () => {
  await withDb(async (db) => {
    insertModelRow(db, {
      id: "included-reasoning",
      durationMs: 5_000,
      ttftMs: 4_000,
      outputTokens: 500,
      reasoningTokens: 200,
      inputTokens: 10_000,
      cacheCreationTokens: 20_000,
      cacheReadTokens: 30_000,
    });
    insertModelRow(db, {
      id: "separate-reasoning",
      durationMs: 5_000,
      ttftMs: null,
      outputTokens: 0,
      reasoningTokens: 7_000,
      inputTokens: 40_000,
      cacheCreationTokens: 50_000,
      cacheReadTokens: 60_000,
    });
    const result = await querySessionPerformance(db, {
      sessionID: SESSION_ID as SessionId,
      querySources: MAIN_TURN,
    });

    assert.equal(result.tpsOutputTokens, 500);
    assert.equal(result.tpsDurationMs, 10_000);
    assert.equal(calculateRequestLogAverageTps(result.tpsOutputTokens, result.tpsDurationMs), 50);
  });
});

const HIGH_TTFT_SAMPLES = [
  {
    name: "主会话截图",
    querySources: MAIN_TURN,
    outputTokens: 5_281,
    durationMs: 195_313,
    ttftMs: 173_257,
    expectedTps: 27.03865,
    rounded: 27,
    oldRounded: 239,
  },
  // 子样本使用接近总耗时的合成 TTFT，旧尾段算法会重现 502 / 803。
  {
    name: "子会话截图一",
    querySources: SUBAGENT,
    outputTokens: 11_522,
    durationMs: 342_695,
    ttftMs: 319_742,
    expectedTps: 33.62173,
    rounded: 34,
    oldRounded: 502,
  },
  {
    name: "子会话截图二",
    querySources: SUBAGENT,
    outputTokens: 9_164,
    durationMs: 267_169,
    ttftMs: 255_757,
    expectedTps: 34.30039,
    rounded: 34,
    oldRounded: 803,
  },
  {
    name: "首字接近完成的单请求",
    querySources: MAIN_TURN,
    outputTokens: 529,
    durationMs: 15_650,
    ttftMs: 15_140,
    expectedTps: 33.80192,
    rounded: 34,
    oldRounded: 1_037,
  },
] as const;

for (const sample of HIGH_TTFT_SAMPLES) {
  test(`${sample.name} 使用总耗时，不能从完整输出分母扣除 TTFT`, async () => {
    await withDb(async (db) => {
      insertModelRow(db, { id: "sample", querySource: sample.querySources[0], ...sample });
      const result = await querySessionPerformance(db, {
        sessionID: SESSION_ID as SessionId,
        querySources: sample.querySources,
      });
      const tps = calculateRequestLogAverageTps(result.tpsOutputTokens, result.tpsDurationMs);

      assert.equal(result.tpsOutputTokens, sample.outputTokens);
      assert.equal(result.tpsDurationMs, sample.durationMs);
      assert.equal(averageTtftMs(result.ttftSumMs, result.ttftCount), sample.ttftMs);
      assert.ok(tps !== null);
      assert.ok(Math.abs(tps - sample.expectedTps) < 0.0001);
      assert.equal(Math.round(tps), sample.rounded);
      assert.notEqual(Math.round(tps), sample.oldRounded);
    });
  });
}

test("有效的高 TPS 不做硬上限裁剪", async () => {
  await withDb(async (db) => {
    insertModelRow(db, { id: "fast", durationMs: 100, ttftMs: 0, outputTokens: 10_000 });
    const result = await querySessionPerformance(db, {
      sessionID: SESSION_ID as SessionId,
      querySources: MAIN_TURN,
    });
    assert.equal(
      calculateRequestLogAverageTps(result.tpsOutputTokens, result.tpsDurationMs),
      100_000,
    );
  });
});

test("空会话返回零值，平均与速度不可用而不是 0", async () => {
  await withDb(async (db) => {
    const result = await querySessionPerformance(db, {
      sessionID: SESSION_ID as SessionId,
      querySources: MAIN_TURN,
    });

    assert.equal(result.modelMs, 0);
    assert.equal(result.toolMs, 0);
    assert.equal(result.modelRequestCount, 0);
    assert.equal(result.ttftCount, 0);
    assert.equal(result.tpsOutputTokens, 0);
    assert.equal(result.tpsDurationMs, 0);
    assert.equal(averageTtftMs(result.ttftSumMs, result.ttftCount), null);
    assert.equal(calculateRequestLogAverageTps(result.tpsOutputTokens, result.tpsDurationMs), null);
  });
});

test("子会话按自身 subagent 口径累计，与父会话、主链和侧车隔离", async () => {
  await withDb(async (db) => {
    const childSession = "subagent-child-session";
    insertSession(db, childSession);
    for (const row of [
      { id: "child-1", durationMs: 6_000, outputTokens: 500 },
      { id: "child-2", durationMs: 4_000, outputTokens: 300 },
    ]) {
      insertModelRow(db, {
        sessionID: childSession,
        querySource: "subagent",
        ttftMs: 1_000,
        ...row,
      });
    }
    insertModelRow(db, {
      id: "child-sidecar",
      sessionID: childSession,
      querySource: "compact",
      durationMs: 100,
      ttftMs: 1,
      outputTokens: 9_000,
    });
    insertModelRow(db, { id: "parent", durationMs: 2_000, ttftMs: 1_000, outputTokens: 200 });

    const asChild = await querySessionPerformance(db, {
      sessionID: childSession as SessionId,
      querySources: SUBAGENT,
    });
    assert.equal(asChild.modelRequestCount, 2);
    assert.equal(asChild.tpsOutputTokens, 800);
    assert.equal(asChild.tpsDurationMs, 10_000);
    assert.equal(averageTtftMs(asChild.ttftSumMs, asChild.ttftCount), 1_000);
    assert.equal(calculateRequestLogAverageTps(asChild.tpsOutputTokens, asChild.tpsDurationMs), 80);

    const asMainTurn = await querySessionPerformance(db, {
      sessionID: childSession as SessionId,
      querySources: MAIN_TURN,
    });
    assert.equal(asMainTurn.modelRequestCount, 0);
    assert.equal(
      calculateRequestLogAverageTps(asMainTurn.tpsOutputTokens, asMainTurn.tpsDurationMs),
      null,
    );

    const parent = await querySessionPerformance(db, {
      sessionID: SESSION_ID as SessionId,
      querySources: MAIN_TURN,
    });
    assert.equal(parent.modelRequestCount, 1);
    assert.equal(parent.tpsOutputTokens, 200);
    assert.equal(parent.tpsDurationMs, 2_000);
  });
});
