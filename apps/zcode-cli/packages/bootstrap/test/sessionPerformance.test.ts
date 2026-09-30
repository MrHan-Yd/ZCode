import assert from "node:assert/strict";
import test from "node:test";
import { sessionPerformanceSnapshotSchema } from "@zcode/shared";
import { querySessionPerformance } from "../src/zcode-protocol/session-performance.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const SESSION_ID = "session-performance-bootstrap";

type Aggregate = {
  modelMs: number;
  toolMs: number;
  modelRequestCount: number;
  toolCallCount: number;
  ttftSumMs: number;
  ttftCount: number;
  tpsOutputTokens: number;
  generationMs: number;
};

function createContext(aggregate: Aggregate | null): ZCodeProtocolAgentServerContext {
  const sessionStore =
    aggregate === null
      ? // 只实现不了新方法的旧 store：入口要退化成空统计，而不是抛错。
        {}
      : { querySessionPerformance: async () => ({ sessionID: SESSION_ID, ...aggregate }) };
  return {
    sessions: new Map([[SESSION_ID, { app: { sessionId: SESSION_ID } }]]),
    deps: { sessionStore },
  } as unknown as ZCodeProtocolAgentServerContext;
}

test("聚合计量组装成会话统计快照：平均与速度在这里换算，结果通过 wire schema", async () => {
  const context = createContext({
    modelMs: 15_000,
    toolMs: 1_500,
    modelRequestCount: 2,
    toolCallCount: 2,
    ttftSumMs: 4_000,
    ttftCount: 2,
    tpsOutputTokens: 800,
    generationMs: 8_000,
  });

  const snapshot = await querySessionPerformance(context, { sessionId: SESSION_ID });

  assert.equal(snapshot.sessionId, SESSION_ID);
  assert.equal(snapshot.summary.averageTtftMs, 2_000);
  // 速度只用生成时长：800 token / 8 秒。用请求总时长会算成 800/15 秒。
  assert.equal(snapshot.summary.tokensPerSecond, 100);
  assert.equal(snapshot.summary.modelMs, 15_000);
  assert.equal(snapshot.summary.toolMs, 1_500);
  sessionPerformanceSnapshotSchema.parse(snapshot);
});

test("没有首 token 计量时平均值为 null，没有生成时长时速度为 null", async () => {
  const context = createContext({
    modelMs: 5_000,
    toolMs: 0,
    modelRequestCount: 1,
    toolCallCount: 0,
    ttftSumMs: 0,
    ttftCount: 0,
    tpsOutputTokens: 0,
    generationMs: 0,
  });

  const snapshot = await querySessionPerformance(context, { sessionId: SESSION_ID });

  // 0 会被读成「没有延迟」/「模型卡住」，这里必须是 null。
  assert.equal(snapshot.summary.averageTtftMs, null);
  assert.equal(snapshot.summary.tokensPerSecond, null);
  sessionPerformanceSnapshotSchema.parse(snapshot);
});

test("旧 store 缺查询方法时返回空统计，不抛错", async () => {
  const snapshot = await querySessionPerformance(createContext(null), { sessionId: SESSION_ID });

  assert.deepEqual(snapshot.summary, {
    modelMs: 0,
    toolMs: 0,
    averageTtftMs: null,
    tokensPerSecond: null,
    modelRequestCount: 0,
    toolCallCount: 0,
  });
  sessionPerformanceSnapshotSchema.parse(snapshot);
});

test("会话不在本进程时与 session/debug 一致地报错，而不是返回空统计", async () => {
  const context = createContext(null);
  await assert.rejects(() => querySessionPerformance(context, { sessionId: "missing-session" }));
});
