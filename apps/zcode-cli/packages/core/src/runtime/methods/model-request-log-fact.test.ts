import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  type Model,
  type ModelUsageRecord,
  type SessionEvent,
  type TraceContext,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import { recordModelUsageFact } from "./usage-observability.js";

function setup() {
  const records: ModelUsageRecord[] = [];
  const runtime = {
    sessionId: "fixture-session",
    config: { taskType: "interactive" },
    sessionStore: {
      recordModelUsage: async (record: ModelUsageRecord) => {
        records.push(record);
      },
      upsertTurnUsage: async () => {},
      upsertToolUsage: async () => {},
      pruneUsage: async () => {},
    },
  } as unknown as AgentRuntimeInternal;
  const model = { providerId: "fixture-provider", modelId: "fixture-model", options: {} } as Model;
  const traceContext = { spanId: "fixture-span" } as TraceContext;
  const events = [
    {
      type: SessionEventType.ModelNetworkStatus,
      payload: {
        type: "model_request_failed",
        statusCode: 429,
        reason: "rate_limit",
        retryable: true,
      },
    },
  ] as SessionEvent[];
  return { runtime, model, traceContext, events, records };
}

test("同一模型事实写入路径保留明确成本和终态 HTTP 错误码", async () => {
  const input = setup();
  await recordModelUsageFact(input.runtime, {
    model: input.model,
    traceContext: input.traceContext,
    events: input.events,
    networkEventStartIndex: 0,
    querySource: "main_turn",
    startedAt: Date.now() - 1_000,
    status: "error",
    error: new Error("fixture failure"),
    result: { text: "", usage: { costUsd: 0 } },
  });
  assert.equal(input.records.length, 1);
  assert.equal(input.records[0]?.costUsd, 0);
  assert.equal(input.records[0]?.httpStatus, 429);
  assert.equal(input.records[0]?.providerId, "fixture-provider");
});

test("重试成功后不把旧失败状态码写成最终成功码，未知成本不伪造", async () => {
  const input = setup();
  await recordModelUsageFact(input.runtime, {
    model: input.model,
    traceContext: input.traceContext,
    events: input.events,
    networkEventStartIndex: 0,
    querySource: "workspace_git_commit_message",
    startedAt: Date.now() - 1_000,
    status: "completed",
    result: { text: "fixture", usage: { inputTokens: 10, outputTokens: 1 } },
  });
  assert.equal(input.records[0]?.httpStatus, undefined);
  assert.equal(input.records[0]?.costUsd, undefined);
  assert.equal(input.records[0]?.querySource, "workspace_git_commit_message");
});

test("纯工具调用没有正文增量时用 provider 首内容里程碑回填首字", async () => {
  const input = setup();
  const startedAt = 1_000;
  await recordModelUsageFact(input.runtime, {
    model: input.model,
    traceContext: input.traceContext,
    events: [
      {
        type: SessionEventType.ModelNetworkStatus,
        payload: {
          type: "model_request_completed",
          durationMs: 3_000,
          timeToFirstContentMs: 800,
          finishReason: "tool-calls",
        },
        timestamp: new Date(startedAt + 3_000),
      },
    ] as SessionEvent[],
    networkEventStartIndex: 0,
    querySource: "main_turn",
    startedAt,
    status: "completed",
    result: { text: "", usage: { outputTokens: 120 } },
  });
  // attempt 起点 = 完成事件时间 − durationMs，再加首个内容耗时。
  assert.equal(input.records[0]?.timeToFirstTokenMs, 800);
});

test("有文本增量时保留事件口径，不被里程碑覆盖", async () => {
  const input = setup();
  const startedAt = 1_000;
  await recordModelUsageFact(input.runtime, {
    model: input.model,
    traceContext: input.traceContext,
    events: [
      {
        type: SessionEventType.ModelStreaming,
        payload: { kind: "text_delta", delta: "hi" },
        timestamp: new Date(startedAt + 500),
      },
      {
        type: SessionEventType.ModelNetworkStatus,
        payload: {
          type: "model_request_completed",
          durationMs: 3_000,
          timeToFirstContentMs: 800,
        },
        timestamp: new Date(startedAt + 3_000),
      },
    ] as SessionEvent[],
    networkEventStartIndex: 0,
    querySource: "main_turn",
    startedAt,
    status: "completed",
    result: { text: "hi", usage: { outputTokens: 2 } },
  });
  assert.equal(input.records[0]?.timeToFirstTokenMs, 500);
});

test("里程碑缺失或超过本次尝试耗时时保持首字未知", async () => {
  for (const payload of [
    { type: "model_request_completed", durationMs: 3_000 },
    { type: "model_request_completed", durationMs: 3_000, timeToFirstContentMs: 4_000 },
  ]) {
    const input = setup();
    await recordModelUsageFact(input.runtime, {
      model: input.model,
      traceContext: input.traceContext,
      events: [
        { type: SessionEventType.ModelNetworkStatus, payload, timestamp: new Date(4_000) },
      ] as SessionEvent[],
      networkEventStartIndex: 0,
      querySource: "main_turn",
      startedAt: 1_000,
      status: "completed",
      result: { text: "", usage: { outputTokens: 1 } },
    });
    assert.equal(input.records[0]?.timeToFirstTokenMs, undefined);
  }
});
