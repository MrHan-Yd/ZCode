import assert from "node:assert/strict";
import test from "node:test";

import type { Model, ModelStreamEvent } from "@zcode/contracts";

import {
  collectAuxiliaryStreamResult,
  generateAuxiliaryText,
} from "../src/runtime/helpers/auxiliary-text-generation.js";

/** 用数组喂事件，等价于 provider 推完整个流；保持与 helper 相同的消费方式。 */
async function* streamOf(events: readonly ModelStreamEvent[]): AsyncIterable<ModelStreamEvent> {
  for (const event of events) {
    yield event;
  }
}

/**
 * 只实现本 helper 会用到的那一个方法：非流式调用直接失败，模拟「上游非流式响应不是 JSON」。
 * 其余 Model 字段不参与该路径，用一次显式断言收口，避免为测试伪造整套 option map。
 */
function streamingOnlyModel(input: {
  calls: string[];
  events: readonly ModelStreamEvent[];
}): Model {
  const double = {
    providerId: "test-provider",
    modelId: "test-model",
    properties: {},
    optionSpecs: {},
    options: {},
    bind: () => double,
    generateText: () => {
      input.calls.push("generateText");
      return Promise.reject(new Error("Invalid JSON response"));
    },
    streamText: () => {
      input.calls.push("streamText");
      return streamOf(input.events);
    },
  };
  return double as unknown as Model;
}

test("generateAuxiliaryText 只走流式：非流式响应不可用时仍能拿到文本", async () => {
  const calls: string[] = [];
  const model = streamingOnlyModel({
    calls,
    events: [
      { type: "text_delta", text: "chore: " },
      { type: "text_delta", text: "兼容非流式上游" },
      { type: "finish", finishReason: "stop", usage: { outputTokens: 6 } },
    ],
  });

  const result = await generateAuxiliaryText(model, {
    messages: [{ role: "user", content: "写一条提交消息" }],
  });

  assert.equal(result.text, "chore: 兼容非流式上游");
  assert.equal(result.finishReason, "stop");
  // 传输策略本身是被测对象：回退到 generateText 会让这条断言失败。
  assert.deepEqual(calls, ["streamText"]);
});

test("text_delta 累加，finish 提供 finishReason / usage / providerMetadata", async () => {
  const result = await collectAuxiliaryStreamResult(
    streamOf([
      { type: "start" },
      { type: "text_start", id: "t1" },
      { type: "text_delta", id: "t1", text: "feat: " },
      { type: "text_delta", id: "t1", text: "兼容非流式上游" },
      { type: "text_end", id: "t1" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 12, outputTokens: 4 },
        providerMetadata: { rawFinishReason: "stop" },
      },
    ]),
  );

  assert.equal(result.text, "feat: 兼容非流式上游");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 4 });
  assert.deepEqual(result.providerMetadata, { rawFinishReason: "stop" });
  assert.equal(result.toolCalls, undefined);
});

test("没有 finish 事件时按 unknown 收口，不抛错", async () => {
  const result = await collectAuxiliaryStreamResult(
    streamOf([{ type: "text_delta", text: "部分输出" }]),
  );

  assert.equal(result.text, "部分输出");
  assert.equal(result.finishReason, "unknown");
  assert.deepEqual(result.usage, {});
});

test("reasoning 按段归并：带 id 的段各自成块，无 id 的 delta 并入开启中的段", async () => {
  const result = await collectAuxiliaryStreamResult(
    streamOf([
      { type: "reasoning_start", id: "r1" },
      { type: "reasoning_delta", id: "r1", text: "先看" },
      { type: "reasoning_delta", text: "文件清单" },
      { type: "reasoning_end", id: "r1" },
      { type: "reasoning_start", id: "r2" },
      { type: "reasoning_delta", id: "r2", text: "再写消息" },
      { type: "reasoning_end", id: "r2" },
      { type: "text_delta", text: "feat: x" },
      { type: "finish", finishReason: "stop", usage: {} },
    ]),
  );

  assert.deepEqual(result.reasoning, [
    { type: "reasoning", text: "先看文件清单" },
    { type: "reasoning", text: "再写消息" },
  ]);
});

test("只有元数据、没有正文的 reasoning 段不产出空块", async () => {
  const result = await collectAuxiliaryStreamResult(
    streamOf([
      { type: "reasoning_start", id: "r1" },
      { type: "reasoning_end", id: "r1" },
      { type: "finish", finishReason: "stop", usage: {} },
    ]),
  );

  assert.equal(result.reasoning, undefined);
});

test("tool_call 事件按序收集", async () => {
  const result = await collectAuxiliaryStreamResult(
    streamOf([
      { type: "tool_call", toolCall: { id: "c1", name: "Read", input: { file: "a" } } },
      { type: "finish", finishReason: "tool-calls", usage: {} },
    ]),
  );

  assert.deepEqual(result.toolCalls, [{ id: "c1", name: "Read", input: { file: "a" } }]);
  assert.equal(result.finishReason, "tool-calls");
});

test("error 事件立即抛出：Error 原样透出，非 Error 也变成可读错误", async () => {
  const failure = new Error("provider exploded");
  await assert.rejects(
    collectAuxiliaryStreamResult(
      streamOf([{ type: "text_delta", text: "半截" }, { type: "error", error: failure }]),
    ),
    (error: unknown) => error === failure,
  );

  await assert.rejects(
    collectAuxiliaryStreamResult(streamOf([{ type: "error", error: "上游字符串错误" }])),
    (error: unknown) => error instanceof Error && error.message === "上游字符串错误",
  );
});
