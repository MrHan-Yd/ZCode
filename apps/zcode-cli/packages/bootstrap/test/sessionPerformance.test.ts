import assert from "node:assert/strict";
import test from "node:test";
import type { SessionId, SessionPerformanceQueryResult } from "@zcode/contracts";
import { sessionPerformanceSnapshotSchema } from "@zcode/shared";
import { querySessionPerformance } from "../src/zcode-protocol/session-performance.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const SESSION_ID = "session-performance-bootstrap";

type Aggregate = Omit<SessionPerformanceQueryResult, "sessionID">;

function createContext(aggregate: Aggregate | null): ZCodeProtocolAgentServerContext {
  const sessionStore =
    aggregate === null
      ? // 只实现不了新方法的旧 store：入口要退化成空统计，而不是抛错。
        {}
      : {
          querySessionPerformance: async (): Promise<SessionPerformanceQueryResult> => ({
            sessionID: SESSION_ID as SessionId,
            ...aggregate,
          }),
        };
  return {
    sessions: new Map([[SESSION_ID, { app: { sessionId: SESSION_ID } }]]),
    deps: { sessionStore },
  } as unknown as ZCodeProtocolAgentServerContext;
}

test("聚合计量按成功请求总耗时换算成快照，wire 字段保持不变", async () => {
  const context = createContext({
    modelMs: 15_000,
    toolMs: 1_500,
    modelRequestCount: 2,
    toolCallCount: 2,
    ttftSumMs: 4_000,
    ttftCount: 2,
    tpsOutputTokens: 800,
    tpsDurationMs: 15_000,
  });

  const snapshot = await querySessionPerformance(context, { sessionId: SESSION_ID });

  assert.equal(snapshot.sessionId, SESSION_ID);
  assert.equal(snapshot.summary.averageTtftMs, 2_000);
  assert.equal(snapshot.summary.tokensPerSecond, (800 * 1_000) / 15_000);
  assert.equal(snapshot.summary.modelMs, 15_000);
  assert.equal(snapshot.summary.toolMs, 1_500);
  assert.equal(snapshot.summary.modelRequestCount, 2);
  assert.equal(snapshot.summary.toolCallCount, 2);
  assert.equal("tpsDurationMs" in snapshot.summary, false);
  sessionPerformanceSnapshotSchema.parse(snapshot);
});

test("没有 TTFT 计量时平均为 null，正耗时的输出速度仍可用", async () => {
  const context = createContext({
    modelMs: 5_000,
    toolMs: 0,
    modelRequestCount: 1,
    toolCallCount: 0,
    ttftSumMs: 0,
    ttftCount: 0,
    tpsOutputTokens: 500,
    tpsDurationMs: 5_000,
  });

  const snapshot = await querySessionPerformance(context, { sessionId: SESSION_ID });

  assert.equal(snapshot.summary.averageTtftMs, null);
  assert.equal(snapshot.summary.tokensPerSecond, 100);
  sessionPerformanceSnapshotSchema.parse(snapshot);
});

for (const ttftMs of [0, 1_000, 2_000]) {
  test(`协议映射不从总耗时中扣除 TTFT=${ttftMs}`, async () => {
    const snapshot = await querySessionPerformance(
      createContext({
        modelMs: 1_000,
        toolMs: 0,
        modelRequestCount: 1,
        toolCallCount: 0,
        ttftSumMs: ttftMs,
        ttftCount: 1,
        tpsOutputTokens: 300,
        tpsDurationMs: 1_000,
      }),
      { sessionId: SESSION_ID },
    );

    assert.equal(snapshot.summary.averageTtftMs, ttftMs);
    assert.equal(snapshot.summary.tokensPerSecond, 300);
    sessionPerformanceSnapshotSchema.parse(snapshot);
  });
}

test("协议速度只除以合格请求的累计耗时，不替换成 modelMs 或 TTFT 尾段", async () => {
  const snapshot = await querySessionPerformance(
    createContext({
      modelMs: 9_000,
      toolMs: 0,
      modelRequestCount: 2,
      toolCallCount: 0,
      ttftSumMs: 1_900,
      ttftCount: 2,
      tpsOutputTokens: 80,
      tpsDurationMs: 2_000,
    }),
    { sessionId: SESSION_ID },
  );

  assert.equal(snapshot.summary.tokensPerSecond, 40);
  assert.equal(snapshot.summary.modelMs, 9_000);
  sessionPerformanceSnapshotSchema.parse(snapshot);
});

test("有正耗时且输出为零的成功请求返回 0 TPS，而非缺计量的 null", async () => {
  const snapshot = await querySessionPerformance(
    createContext({
      modelMs: 1_000,
      toolMs: 0,
      modelRequestCount: 1,
      toolCallCount: 0,
      ttftSumMs: 0,
      ttftCount: 0,
      tpsOutputTokens: 0,
      tpsDurationMs: 1_000,
    }),
    { sessionId: SESSION_ID },
  );

  assert.equal(snapshot.summary.tokensPerSecond, 0);
  sessionPerformanceSnapshotSchema.parse(snapshot);
});

test("没有合格 TPS 耗时时不回退到 modelMs，速度为 null", async () => {
  const snapshot = await querySessionPerformance(
    createContext({
      modelMs: 5_000,
      toolMs: 0,
      modelRequestCount: 1,
      toolCallCount: 0,
      ttftSumMs: 0,
      ttftCount: 0,
      tpsOutputTokens: 0,
      tpsDurationMs: 0,
    }),
    { sessionId: SESSION_ID },
  );

  assert.equal(snapshot.summary.averageTtftMs, null);
  assert.equal(snapshot.summary.tokensPerSecond, null);
  sessionPerformanceSnapshotSchema.parse(snapshot);
});

for (const sample of [
  {
    name: "主截图",
    outputTokens: 5_281,
    durationMs: 195_313,
    ttftMs: 173_257,
    expectedTps: 27.03865,
  },
  {
    name: "首字接近完成",
    outputTokens: 529,
    durationMs: 15_650,
    ttftMs: 15_140,
    expectedTps: 33.80192,
  },
]) {
  test(`${sample.name} 的 wire TPS 使用完整请求耗时`, async () => {
    const snapshot = await querySessionPerformance(
      createContext({
        modelMs: sample.durationMs,
        toolMs: 0,
        modelRequestCount: 1,
        toolCallCount: 0,
        ttftSumMs: sample.ttftMs,
        ttftCount: 1,
        tpsOutputTokens: sample.outputTokens,
        tpsDurationMs: sample.durationMs,
      }),
      { sessionId: SESSION_ID },
    );
    const tps = snapshot.summary.tokensPerSecond;

    assert.ok(tps !== null);
    assert.ok(Math.abs(tps - sample.expectedTps) < 0.0001);
    sessionPerformanceSnapshotSchema.parse(snapshot);
  });
}

test("协议保留有效高 TPS，不做显示上限裁剪", async () => {
  const snapshot = await querySessionPerformance(
    createContext({
      modelMs: 100,
      toolMs: 0,
      modelRequestCount: 1,
      toolCallCount: 0,
      ttftSumMs: 0,
      ttftCount: 1,
      tpsOutputTokens: 10_000,
      tpsDurationMs: 100,
    }),
    { sessionId: SESSION_ID },
  );

  assert.equal(snapshot.summary.tokensPerSecond, 100_000);
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
