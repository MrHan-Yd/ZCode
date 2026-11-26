import assert from "node:assert/strict";
import test from "node:test";
import { generateText, streamText } from "ai";
import {
  createModelId,
  createModelProviderId,
  type ModelAssistantContent,
  type ModelInputMessage,
  type ModelStreamEvent,
} from "@zcode/contracts";
import {
  normalizeAssistantContent,
  toModelStreamEvent,
} from "../src/model/runner-normalization.js";
import {
  normalizeReasoningHistory,
  repairReasoningHistoryAfterSignatureRejection,
} from "../src/model/reasoning-history-normalization.js";
import { createGenerateTextOptions, createStreamTextOptions } from "../src/model/runner-options.js";
import type { AiSdkModelTextRequest } from "../src/model/runner-runtime.js";
import { StreamingToolCallAssembler } from "../src/model/streaming-tool-call-assembler.js";
import { toAiSdkMessages } from "../src/model/transform.js";
import {
  createGeminiExecution,
  createStatusContext,
  geminiJsonResponse,
} from "./geminiTestSupport.js";

const THOUGHT_SIGNATURE = (value: string) => ({ google: { thoughtSignature: value } });

async function generateAssistantContent(input: {
  parts: Array<Record<string, unknown>>;
}): Promise<ModelAssistantContent> {
  const execution = createGeminiExecution({
    respond: () =>
      geminiJsonResponse({
        content: { parts: input.parts, role: "model" },
        finishReason: "STOP",
      }),
  });
  const resolved = execution.resolveRequest();
  const result = await generateText(
    createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ content: "hi", role: "user" }],
      } as AiSdkModelTextRequest,
      resolved,
      statusContext: createStatusContext({}),
    }),
  );
  const assistantContent = normalizeAssistantContent(result);
  assert.ok(assistantContent, "assistantContent must be produced from SDK content");
  return assistantContent;
}

async function collectStreamContent(events: unknown[]): Promise<{
  assistantContent: ModelAssistantContent;
  fragments: ModelStreamEvent[];
}> {
  const execution = createGeminiExecution({
    respond: () =>
      new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("")}`, {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  const resolved = execution.resolveRequest();
  const result = streamText(
    createStreamTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ content: "hi", role: "user" }],
      } as AiSdkModelTextRequest,
      resolved,
      statusContext: createStatusContext({ transport: "sse" }),
    }),
  );

  const assembler = new StreamingToolCallAssembler();
  const fragments: ModelStreamEvent[] = [];
  for await (const chunk of result.fullStream) {
    const event = toModelStreamEvent(chunk);
    if (event) fragments.push(...assembler.handle(event));
  }
  return { assistantContent: assembler.snapshotAssistantContent(), fragments };
}

test("非流式按 part 原序保留签名与未签名 parallel call", async () => {
  const assistantContent = await generateAssistantContent({
    parts: [
      { text: "Hello", thoughtSignature: "sig-text" },
      {
        functionCall: { args: { q: "x" }, id: "call-a", name: "lookup" },
        thoughtSignature: "sig-tool-a",
      },
      { functionCall: { args: { q: "y" }, id: "call-b", name: "lookup" } },
    ],
  });

  assert.deepEqual(assistantContent, [
    { providerOptions: THOUGHT_SIGNATURE("sig-text"), text: "Hello", type: "text" },
    {
      id: "call-a",
      input: { q: "x" },
      name: "lookup",
      providerOptions: THOUGHT_SIGNATURE("sig-tool-a"),
      type: "tool_call",
    },
    { id: "call-b", input: { q: "y" }, name: "lookup", type: "tool_call" },
  ]);
  assert.equal(Object.hasOwn(assistantContent[2]!, "providerOptions"), false);

  const messages = toAiSdkMessages([{ assistantContent, content: "", role: "assistant" }], {
    providerKind: "google",
  });
  const replay = messages[0]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    replay.map((part) => part.type),
    ["text", "tool-call", "tool-call"],
  );
  assert.deepEqual(replay[0]?.providerOptions, THOUGHT_SIGNATURE("sig-text"));
  assert.deepEqual(replay[1]?.providerOptions, THOUGHT_SIGNATURE("sig-tool-a"));
  assert.equal(Object.hasOwn(replay[2]!, "providerOptions"), false);
});

test("尾部空 signed text 不丢失签名，包装 part 也不会被静默丢弃", async () => {
  // Gemini 原生非流式把尾部空 text 的签名合并到上一个 part。
  const assistantContent = await generateAssistantContent({
    parts: [{ text: "Hello" }, { text: "", thoughtSignature: "sig-tail" }],
  });
  assert.deepEqual(assistantContent, [
    { providerOptions: THOUGHT_SIGNATURE("sig-tail"), text: "Hello", type: "text" },
  ]);

  // 若历史中确实存在带签名的空 text part，回放时不能按 text.length 过滤。
  const emptySigned: ModelAssistantContent = [
    { providerOptions: THOUGHT_SIGNATURE("sig-empty"), text: "", type: "text" },
  ];
  const messages = toAiSdkMessages(
    [{ assistantContent: emptySigned, content: "", role: "assistant" }],
    { providerKind: "google" },
  );
  const replay = messages[0]?.content as Array<Record<string, unknown>>;
  assert.deepEqual(replay, [
    { providerOptions: THOUGHT_SIGNATURE("sig-empty"), text: "", type: "text" },
  ]);
});

test("assistantContent 显式空数组不回退旧 content/toolCalls 视图", () => {
  const message: ModelInputMessage = {
    assistantContent: [],
    content: "legacy text",
    role: "assistant",
    toolCalls: [{ id: "legacy-call", input: {}, name: "legacy_tool" }],
  };
  const [transformed] = toAiSdkMessages([message], { providerKind: "google" });
  assert.deepEqual(transformed?.content, []);
});

test("assistantContent 保留 text/reasoning/tool_call interleaving", () => {
  const assistantContent: ModelAssistantContent = [
    { providerOptions: THOUGHT_SIGNATURE("sig-1"), text: "before", type: "text" },
    {
      id: "call-a",
      input: { q: "x" },
      name: "lookup",
      providerOptions: THOUGHT_SIGNATURE("sig-2"),
      type: "tool_call",
    },
    { providerOptions: THOUGHT_SIGNATURE("sig-3"), text: "thought", type: "reasoning" },
    { providerOptions: THOUGHT_SIGNATURE("sig-4"), text: "after", type: "text" },
  ];
  const [transformed] = toAiSdkMessages([{ assistantContent, content: "", role: "assistant" }], {
    providerKind: "google",
  });
  const replay = transformed?.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    replay.map((part) => part.type),
    ["text", "tool-call", "reasoning", "text"],
  );
  assert.deepEqual(
    replay.map((part) => part.providerOptions),
    [
      THOUGHT_SIGNATURE("sig-1"),
      THOUGHT_SIGNATURE("sig-2"),
      THOUGHT_SIGNATURE("sig-3"),
      THOUGHT_SIGNATURE("sig-4"),
    ],
  );
});

test("流式 text/reasoning/tool-call 逐 part 保留顺序与签名", async () => {
  const { assistantContent, fragments } = await collectStreamContent([
    {
      candidates: [
        {
          content: {
            parts: [
              { text: "Hi", thoughtSignature: "sig-text" },
              { thought: true, text: "weighing", thoughtSignature: "sig-thought" },
            ],
          },
        },
      ],
    },
    {
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { args: { q: "x" }, id: "call-a", name: "lookup" },
                thoughtSignature: "sig-tool-a",
              },
              { functionCall: { args: { q: "y" }, id: "call-b", name: "lookup" } },
            ],
          },
        },
      ],
    },
    {
      candidates: [{ content: { parts: [] }, finishReason: "STOP" }],
      usageMetadata: { candidatesTokenCount: 4, promptTokenCount: 3, totalTokenCount: 7 },
    },
  ]);

  assert.deepEqual(assistantContent, [
    { providerOptions: THOUGHT_SIGNATURE("sig-text"), text: "Hi", type: "text" },
    { providerOptions: THOUGHT_SIGNATURE("sig-thought"), text: "weighing", type: "reasoning" },
    {
      id: "call-a",
      input: { q: "x" },
      name: "lookup",
      providerOptions: THOUGHT_SIGNATURE("sig-tool-a"),
      type: "tool_call",
    },
    { id: "call-b", input: { q: "y" }, name: "lookup", type: "tool_call" },
  ]);
  assert.equal(Object.hasOwn(assistantContent[3]!, "providerOptions"), false);

  const textStart = fragments.find(
    (event): event is Extract<ModelStreamEvent, { type: "text_start" }> =>
      event.type === "text_start",
  );
  assert.deepEqual(textStart?.providerMetadata, THOUGHT_SIGNATURE("sig-text"));
  const toolCallEvents = fragments.filter(
    (event): event is Extract<ModelStreamEvent, { type: "tool_call" }> =>
      event.type === "tool_call",
  );
  assert.equal(toolCallEvents.length, 2);
  assert.deepEqual(toolCallEvents[0]?.toolCall.providerOptions, THOUGHT_SIGNATURE("sig-tool-a"));
  assert.equal(Object.hasOwn(toolCallEvents[1]!.toolCall, "providerOptions"), false);
});

test("start/delta/end 的稀疏 providerMetadata 增量合并且不清空签名", () => {
  const assembler = new StreamingToolCallAssembler();
  assembler.handle({
    id: "text-1",
    providerMetadata: THOUGHT_SIGNATURE("sig"),
    type: "text_start",
  });
  assembler.handle({
    id: "text-1",
    providerMetadata: { google: {} },
    text: "Hi",
    type: "text_delta",
  });
  assembler.handle({
    id: "text-1",
    providerMetadata: { google: { latency: "1" } },
    type: "text_end",
  });
  // 只有签名的空 reasoning 也必须保留。
  assembler.handle({
    id: "reasoning-1",
    providerMetadata: THOUGHT_SIGNATURE("sig-r"),
    type: "reasoning_start",
  });
  assembler.handle({
    id: "reasoning-1",
    providerMetadata: { google: { latency: "2" } },
    type: "reasoning_end",
  });

  assert.deepEqual(assembler.snapshotAssistantContent(), [
    {
      providerOptions: { google: { latency: "1", thoughtSignature: "sig" } },
      text: "Hi",
      type: "text",
    },
    {
      providerOptions: { google: { latency: "2", thoughtSignature: "sig-r" } },
      text: "",
      type: "reasoning",
    },
  ]);
});

test("旧三格式 assistant 投影保持原行为", () => {
  const assistant = {
    content: [
      { text: "hello", type: "text" as const },
      { text: "thinking", type: "reasoning" as const },
    ],
    role: "assistant" as const,
    toolCalls: [{ id: "call-1", input: { q: "x" }, name: "lookup" }],
  };

  const [responses] = toAiSdkMessages([assistant], {
    apiFormat: "openai-responses",
    providerKind: "openai",
    providerOptions: { apiFormat: "openai-responses" },
  });
  assert.ok(responses);
  assert.deepEqual(
    (responses.content as Array<Record<string, unknown>>).map((part) => part.type),
    ["text", "reasoning", "tool-call"],
  );

  const [anthropic] = toAiSdkMessages([assistant], {
    apiFormat: "anthropic-messages",
    providerKind: "anthropic",
  });
  assert.ok(anthropic);
  const anthropicParts = anthropic.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    anthropicParts.map((part) => part.type),
    ["text", "reasoning", "tool-call"],
  );
  assert.deepEqual((anthropicParts[1] as { providerOptions?: unknown }).providerOptions, {
    anthropic: { signature: "" },
  });
  assert.equal(Object.hasOwn(anthropicParts[2]!, "providerOptions"), false);

  const [chat] = toAiSdkMessages([assistant], {
    apiFormat: "openai-chat-completions",
    providerKind: "openai-compatible",
  });
  assert.ok(chat);
  assert.deepEqual(
    (chat.content as Array<Record<string, unknown>>).map((part) => part.type),
    ["text", "reasoning", "tool-call"],
  );
});

const ANTHROPIC_SIGNATURE = (signature: string) => ({ anthropic: { signature } });

function anthropicSignedAssistant(): ModelInputMessage {
  const assistantContent: ModelAssistantContent = [
    {
      type: "reasoning",
      text: "plan",
      providerOptions: ANTHROPIC_SIGNATURE("sig-old"),
    },
    { type: "text", text: "done" },
    {
      type: "tool_call",
      id: "call-1",
      name: "lookup",
      input: { q: "x" },
      providerOptions: ANTHROPIC_SIGNATURE("sig-tool"),
    },
  ];
  return {
    assistantContent,
    content: "",
    modelId: createModelId("claude-source"),
    providerId: createModelProviderId("anthropic-source"),
    role: "assistant",
    toolCalls: [{ id: "call-1", input: { q: "x" }, name: "lookup" }],
  };
}

test("跨模型归一化直接清理 assistantContent 中的外模型签名", () => {
  const messages: ModelInputMessage[] = [
    { content: "hi", role: "user" },
    anthropicSignedAssistant(),
    { content: "next", role: "user" },
  ];

  const normalized = normalizeReasoningHistory(messages, {
    modelId: createModelId("claude-target"),
    providerId: createModelProviderId("anthropic-target"),
  });
  const assistant = normalized[1]!;
  assert.ok(assistant.assistantContent);
  assert.equal(
    assistant.assistantContent.some((part) => part.type === "reasoning"),
    false,
    "外模型 signed reasoning 必须从 assistantContent 删除",
  );
  // 兼容视图必须由同一数组重算，而不是保留过滤前的 content/toolCalls。
  assert.deepEqual(assistant.content, [{ type: "text", text: "done" }]);
  assert.deepEqual(assistant.toolCalls, [
    {
      id: "call-1",
      input: { q: "x" },
      name: "lookup",
      providerOptions: ANTHROPIC_SIGNATURE("sig-tool"),
    },
  ]);

  const transformed = toAiSdkMessages(normalized, {
    apiFormat: "anthropic-messages",
    providerKind: "anthropic",
  });
  assert.equal(
    JSON.stringify(transformed).includes("sig-old"),
    false,
    "发给上游的 assistantContent 不能再带外模型签名",
  );
});

test("签名拒绝修复从 assistantContent 删除签名块并重算兼容视图", () => {
  const messages: ModelInputMessage[] = [
    { content: "hi", role: "user" },
    {
      assistantContent: [
        {
          type: "reasoning",
          text: "plan",
          providerOptions: ANTHROPIC_SIGNATURE("sig-rejected"),
        },
        { type: "text", text: "answer" },
      ],
      content: "",
      modelId: createModelId("claude-same"),
      providerId: createModelProviderId("anthropic-same"),
      role: "assistant",
    },
    { content: "next", role: "user" },
  ];

  const repaired = repairReasoningHistoryAfterSignatureRejection(messages, {
    message: "messages.1.content.0: signature in thinking block cannot be modified",
    statusCode: 400,
  });
  assert.ok(repaired, "400 signature 拒绝必须触发一次历史修复");
  const assistant = repaired[1]!;
  assert.deepEqual(assistant.assistantContent, [{ type: "text", text: "answer" }]);
  assert.deepEqual(assistant.content, [{ type: "text", text: "answer" }]);

  const transformed = toAiSdkMessages(repaired, {
    apiFormat: "anthropic-messages",
    providerKind: "anthropic",
  });
  assert.equal(
    JSON.stringify(transformed).includes("sig-rejected"),
    false,
    "修复后的上游请求不得再携带被拒签名",
  );
});

test("尾部 reasoning 从 assistantContent 移除", () => {
  const messages: ModelInputMessage[] = [
    { content: "hi", role: "user" },
    {
      assistantContent: [
        { type: "text", text: "answer" },
        {
          type: "reasoning",
          text: "tail",
          providerOptions: ANTHROPIC_SIGNATURE("sig-tail"),
        },
      ],
      content: "",
      role: "assistant",
    },
  ];

  const normalized = normalizeReasoningHistory(messages);
  const assistant = normalized[1]!;
  assert.deepEqual(assistant.assistantContent, [{ type: "text", text: "answer" }]);
  assert.deepEqual(assistant.content, [{ type: "text", text: "answer" }]);
  assert.equal(JSON.stringify(normalized).includes("sig-tail"), false);
});

test("仅 signed reasoning 的 assistant 跨模型过滤后仍产出非空 assistant 内容", () => {
  const messages: ModelInputMessage[] = [
    { content: "hi", role: "user" },
    {
      assistantContent: [
        {
          type: "reasoning",
          text: "plan",
          providerOptions: ANTHROPIC_SIGNATURE("sig-only-cross-model"),
        },
      ],
      content: "",
      modelId: createModelId("claude-source"),
      providerId: createModelProviderId("anthropic-source"),
      role: "assistant",
    },
    { content: "next", role: "user" },
  ];

  const normalized = normalizeReasoningHistory(messages, {
    modelId: createModelId("claude-target"),
    providerId: createModelProviderId("anthropic-target"),
  });
  const assistant = normalized[1]!;
  assert.ok(
    assistant.assistantContent && assistant.assistantContent.length > 0,
    "裁剪后 assistantContent 必须写回非空回退内容",
  );
  assert.deepEqual(assistant.assistantContent, [{ type: "text", text: "(no content)" }]);
  assert.deepEqual(assistant.content, [{ type: "text", text: "(no content)" }]);

  const transformed = toAiSdkMessages(normalized, {
    apiFormat: "anthropic-messages",
    providerKind: "anthropic",
  });
  const replay = transformed[1]!.content;
  assert.ok(Array.isArray(replay) && replay.length > 0, "wire 上不得出现空 assistant content");
  assert.equal(JSON.stringify(transformed).includes("sig-only-cross-model"), false);
});

test("仅 signed reasoning 的尾部 assistant 经裁剪后仍产出非空 assistant 内容", () => {
  const messages: ModelInputMessage[] = [
    { content: "hi", role: "user" },
    {
      assistantContent: [
        {
          type: "reasoning",
          text: "tail-only",
          providerOptions: ANTHROPIC_SIGNATURE("sig-only-trailing"),
        },
      ],
      content: "",
      role: "assistant",
    },
  ];

  const normalized = normalizeReasoningHistory(messages);
  const assistant = normalized[1]!;
  assert.ok(
    assistant.assistantContent && assistant.assistantContent.length > 0,
    "尾部裁剪后 assistantContent 必须写回非空回退内容",
  );
  assert.deepEqual(assistant.assistantContent, [{ type: "text", text: "(no content)" }]);

  const transformed = toAiSdkMessages(normalized, {
    apiFormat: "anthropic-messages",
    providerKind: "anthropic",
  });
  const replay = transformed[1]!.content;
  assert.ok(Array.isArray(replay) && replay.length > 0, "wire 上不得出现空 assistant content");
  assert.equal(JSON.stringify(transformed).includes("sig-only-trailing"), false);
});
