import assert from "node:assert/strict";
import test from "node:test";
import { zcodeMessagePartSchema } from "./zcode-protocol-legacy-types.js";
import { zcodeModelStreamingEventPayloadSchema } from "./zcode-protocol/index.js";

const identity = {
  partId: "fixture-part",
  sessionId: "fixture-session",
  messageId: "fixture-message",
};
const providerOptions = { google: { thoughtSignature: "fixture-native/+==" } };

function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test("既有 transcript text/reasoning metadata record 可保存原签名及内容序号，无需新增 wire 字段", () => {
  for (const part of [
    {
      ...identity,
      type: "text",
      text: "",
      metadata: { providerOptions, providerContentIndex: 2 },
    },
    {
      ...identity,
      type: "reasoning",
      text: "",
      metadata: { google: providerOptions.google, providerContentIndex: 1 },
    },
  ]) {
    assert.deepEqual(zcodeMessagePartSchema.parse(roundTrip(part)), part);
  }
});

test("工具各终态的已有 metadata 容器均可承载调用签名，不与结果 metadata 混用", () => {
  const metadata = { providerOptions, providerContentIndex: 3, providerToolName: "fixture_tool" };
  for (const state of [
    { status: "pending", input: {}, raw: "{}" },
    { status: "running", input: {}, startedAt: 1 },
    {
      status: "completed",
      input: {},
      output: "fixture",
      title: "fixture",
      metadata: { result: true },
      startedAt: 1,
      completedAt: 2,
    },
    { status: "error", input: {}, error: "fixture error", startedAt: 1, completedAt: 2 },
  ]) {
    const part = {
      ...identity,
      type: "tool",
      callId: "fixture-call",
      tool: "fixture_tool",
      metadata,
      state,
    };
    assert.deepEqual(zcodeMessagePartSchema.parse(roundTrip(part)), part);
  }
});

test("UI strict streaming 不接收 CLI replay 签名，不能 spread 新 ModelStreamEvent 字段", () => {
  for (const kind of ["text_start", "text_delta", "text_end", "tool_call"]) {
    const payload = { kind, assistantMessageId: "fixture-message", partId: "fixture-part" };
    assert.deepEqual(zcodeModelStreamingEventPayloadSchema.parse(payload), payload);
    for (const patch of [
      { providerMetadata: providerOptions },
      { providerOptions },
      { assistantContent: [] },
      { thoughtSignature: "fixture-native/+==" },
    ]) {
      assert.equal(
        zcodeModelStreamingEventPayloadSchema.safeParse({ ...payload, ...patch }).success,
        false,
      );
    }
  }
});
