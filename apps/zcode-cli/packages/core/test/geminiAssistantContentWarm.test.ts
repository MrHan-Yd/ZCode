import assert from "node:assert/strict";
import test from "node:test";

import type { ModelStreamEvent, ModelToolCall } from "@zcode/contracts";

import { AssistantContentAccumulator } from "../src/runtime/helpers/assistant-content-accumulator.js";
import { collectAuxiliaryStreamResult } from "../src/runtime/helpers/auxiliary-text-generation.js";
import {
  createRuntimeAssistantEntry,
  MessageHistoryImpl,
  type ModelInputMessage,
} from "../src/agent/message-history.js";

const SIGNATURE = "sig-google-thought-签名";

function feed(accumulator: AssistantContentAccumulator, events: readonly ModelStreamEvent[]): void {
  for (const event of events) accumulator.handle(event);
}

function signedTextEvent(id: string, text: string): ModelStreamEvent {
  return {
    type: "text_delta",
    id,
    text,
    providerMetadata: { google: { thoughtSignature: SIGNATURE } },
  };
}

test("warm 组装保留 text/reasoning/tool_call 原序与逐 part 签名", () => {
  const accumulator = new AssistantContentAccumulator();
  const toolCall: ModelToolCall = {
    id: "call-1",
    name: "Read",
    input: { file_path: "a.ts" },
    providerOptions: { google: { thoughtSignature: "tool-sig" } },
  };
  feed(accumulator, [
    { type: "reasoning_start", id: "r1" },
    {
      type: "reasoning_delta",
      id: "r1",
      text: "先看文件",
      providerMetadata: { google: { thoughtSignature: "r-sig" } },
    },
    { type: "reasoning_end", id: "r1" },
    { type: "text_start", id: "t1" },
    signedTextEvent("t1", "我先读取。"),
    { type: "text_end", id: "t1" },
    { type: "tool_call", toolCall },
    { type: "text_start", id: "t2" },
    { type: "text_delta", id: "t2", text: "完成。" },
    { type: "text_end", id: "t2" },
  ]);

  const content = accumulator.snapshot();
  assert.deepEqual(
    content.map((part) => part.type),
    ["reasoning", "text", "tool_call", "text"],
  );
  assert.deepEqual(content[0], {
    type: "reasoning",
    text: "先看文件",
    providerOptions: { google: { thoughtSignature: "r-sig" } },
  });
  assert.deepEqual(content[1], {
    type: "text",
    text: "我先读取。",
    providerOptions: { google: { thoughtSignature: SIGNATURE } },
  });
  assert.deepEqual(content[2], {
    type: "tool_call",
    id: "call-1",
    name: "Read",
    input: { file_path: "a.ts" },
    providerOptions: { google: { thoughtSignature: "tool-sig" } },
  });
  assert.deepEqual(content[3], { type: "text", text: "完成。" });
});

test("warm 空 signed tail text 不被过滤，sparse delta/end 元数据不擦掉签名", () => {
  const accumulator = new AssistantContentAccumulator();
  feed(accumulator, [
    { type: "text_start", id: "t1", providerMetadata: { google: { thoughtSignature: SIGNATURE } } },
    { type: "text_delta", id: "t1", text: "" },
    { type: "text_end", id: "t1", providerMetadata: { google: { other: true } } },
  ]);
  const content = accumulator.snapshot();
  assert.equal(content.length, 1);
  assert.deepEqual(content[0], {
    type: "text",
    text: "",
    providerOptions: { google: { thoughtSignature: SIGNATURE, other: true } },
  });
});

test("warm parallel tool calls 保留声明顺序且不注入空签名", () => {
  const accumulator = new AssistantContentAccumulator();
  const calls: ModelToolCall[] = [
    { id: "c1", name: "Read", input: { file_path: "a" }, providerOptions: { google: {} } },
    { id: "c2", name: "Grep", input: { pattern: "b" } },
  ];
  for (const toolCall of calls) accumulator.handle({ type: "tool_call", toolCall });
  // final call 重复投递只原位替换，不追加第二个声明。
  accumulator.handle({ type: "tool_call", toolCall: calls[1]! });

  const content = accumulator.snapshot();
  assert.equal(content.length, 2);
  assert.deepEqual(content[0], {
    type: "tool_call",
    id: "c1",
    name: "Read",
    input: { file_path: "a" },
    // 显式空字符串签名与缺字段不互换。
    providerOptions: { google: {} },
  });
  assert.deepEqual(content[1], {
    type: "tool_call",
    id: "c2",
    name: "Grep",
    input: { pattern: "b" },
  });
  assert.equal("providerOptions" in content[1]!, false);
});

test("辅助收集器合并 delta/end 元数据并保留有序 assistantContent", async () => {
  async function* stream(): AsyncIterable<ModelStreamEvent> {
    yield {
      type: "reasoning_start",
      id: "r1",
      providerMetadata: { google: { thoughtSignature: "r" } },
    };
    yield { type: "reasoning_delta", id: "r1", text: "想一下" };
    yield { type: "reasoning_end", id: "r1", providerMetadata: { google: { extra: "x" } } };
    yield { type: "text_start", id: "t1" };
    yield signedTextEvent("t1", "答案");
    yield { type: "text_end", id: "t1" };
    yield {
      type: "tool_call",
      toolCall: {
        id: "c1",
        name: "Read",
        input: {},
        providerOptions: { google: { thoughtSignature: "call" } },
      },
    };
    yield { type: "finish", finishReason: "tool-calls", usage: {} };
  }

  const result = await collectAuxiliaryStreamResult(stream());
  assert.equal(result.text, "答案");
  assert.deepEqual(result.assistantContent, [
    {
      type: "reasoning",
      text: "想一下",
      providerOptions: { google: { thoughtSignature: "r", extra: "x" } },
    },
    { type: "text", text: "答案", providerOptions: { google: { thoughtSignature: SIGNATURE } } },
    {
      type: "tool_call",
      id: "c1",
      name: "Read",
      input: {},
      providerOptions: { google: { thoughtSignature: "call" } },
    },
  ]);
  assert.deepEqual(result.reasoning, [
    {
      type: "reasoning",
      text: "想一下",
      providerOptions: { google: { thoughtSignature: "r", extra: "x" } },
    },
  ]);
});

test("warm history 从 assistantContent 派生兼容视图并保留签名", () => {
  const content: NonNullable<ModelInputMessage["assistantContent"]> = [
    { type: "text", text: "读一下", providerOptions: { google: { thoughtSignature: "t" } } },
    {
      type: "tool_call",
      id: "c1",
      name: "Read",
      input: { file_path: "a" },
      providerOptions: { google: { thoughtSignature: "c" } },
    },
  ];
  const entry = createRuntimeAssistantEntry(
    "ignored",
    undefined,
    undefined,
    undefined,
    undefined,
    content,
  );
  assert.deepEqual(entry.message.assistantContent, content);
  assert.deepEqual(entry.message.toolCalls, [
    {
      id: "c1",
      name: "Read",
      input: { file_path: "a" },
      providerOptions: { google: { thoughtSignature: "c" } },
    },
  ]);

  const history = new MessageHistoryImpl();
  history.init();
  history.addAssistant("读一下", undefined, undefined, undefined, undefined, content);
  const [runtimeEntry] = history.toRuntimeEntries();
  assert.ok(runtimeEntry && runtimeEntry.kind !== "attachment");
  assert.deepEqual(runtimeEntry.message.assistantContent, content);
});

test("fork/clone 深拷贝 assistantContent，修改副本不影响源历史", () => {
  const history = new MessageHistoryImpl();
  history.init();
  history.addAssistant("x", undefined, undefined, undefined, undefined, [
    { type: "text", text: "x", providerOptions: { google: { thoughtSignature: "sig" } } },
  ]);
  const cloned = history.toRuntimeEntries();
  const message = cloned[0]!;
  assert.ok(message.kind !== "attachment");
  const block = message.message.assistantContent?.[0];
  assert.ok(block && block.type === "text");
  (block.providerOptions!.google as Record<string, unknown>).thoughtSignature = "mutated";
  const original = history.borrowReadOnlyRuntimeEntries()[0]!;
  assert.ok(original.kind !== "attachment");
  assert.deepEqual(original.message.assistantContent?.[0]?.providerOptions, {
    google: { thoughtSignature: "sig" },
  });
});
