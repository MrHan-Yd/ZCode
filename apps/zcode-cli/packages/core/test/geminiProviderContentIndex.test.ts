import assert from "node:assert/strict";
import test from "node:test";
import { AssistantContentAccumulator } from "../src/runtime/helpers/assistant-content-accumulator.js";

function toolCall(id: string) {
  return { id, input: { q: id }, name: "lookup" };
}

test("被快照丢弃的空 text 不占 providerContentIndex", () => {
  const accumulator = new AssistantContentAccumulator();
  accumulator.handle({ id: "text-empty", type: "text_start" });
  // 无签名的空 text 不会进入 snapshot；工具必须拿到 0 而不是内部 parts 下标 1。
  const index = accumulator.nextContentIndex();
  assert.equal(index, 0);
  accumulator.handle({ toolCall: toolCall("call-1"), type: "tool_call" });

  const snapshot = accumulator.snapshot();
  assert.deepEqual(
    snapshot.map((part) => part.type),
    ["tool_call"],
  );
  assert.equal(
    snapshot.findIndex((part) => part.type === "tool_call"),
    index,
  );
});

test("带元数据的空 text 与正文 text 仍计入快照下标", () => {
  const accumulator = new AssistantContentAccumulator();
  accumulator.handle({
    id: "text-signed",
    providerMetadata: { google: { thoughtSignature: "sig-empty" } },
    type: "text_start",
  });
  assert.equal(accumulator.nextContentIndex(), 1);

  accumulator.handle({ id: "text-body", text: "hello", type: "text_delta" });
  assert.equal(accumulator.nextContentIndex(), 2);

  const index = accumulator.nextContentIndex();
  accumulator.handle({ toolCall: toolCall("call-2"), type: "tool_call" });
  const snapshot = accumulator.snapshot();
  assert.deepEqual(
    snapshot.map((part) => part.type),
    ["text", "text", "tool_call"],
  );
  assert.equal(
    snapshot.findIndex((part) => part.type === "tool_call"),
    index,
  );
});
