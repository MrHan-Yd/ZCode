import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText } from "ai";
import type { ModelInputMessage, ModelProperties } from "@zcode/contracts";
import { createGenerateTextOptions } from "../src/model/runner-options.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import { toAiSdkMessages } from "../src/model/transform.js";
import { createMockTransport, createStatusContext } from "./geminiTestSupport.js";

const PROPERTIES: ModelProperties = {
  contextWindow: 200_000,
  inputFormat: {
    supportsAudio: false,
    supportsImage: false,
    supportsPdf: false,
    supportsText: true,
    supportsVideo: false,
  },
  outputFormat: { supportsText: true },
  requiresMfjsToolSchema: false,
  supportsJsonSchemaOutput: true,
  supportsMidConversationSystem: true,
  supportsNativeWebSearch: false,
  supportsToolCall: true,
};

/**
 * 旧格式历史里可能已经带着 Gemini 引入的 part 级回放元数据；
 * 这组测试锁定 OpenAI Responses / Chat Completions / Anthropic 的 wire 不受影响。
 */
function legacyAssistantMessage(): ModelInputMessage {
  return {
    assistantContent: [
      {
        type: "text",
        text: "hello",
        providerOptions: { openai: { itemId: "msg_should_not_leak", phase: "commentary" } },
      },
      {
        type: "tool_call",
        id: "call_1",
        name: "Bash",
        input: { command: "ls" },
        providerOptions: { openai: { itemId: "fc_should_not_leak" } },
      },
    ],
    content: [{ type: "text", text: "hello" }],
    modelId: "gpt-6.1-sol" as ModelInputMessage["modelId"],
    providerId: "new-provider" as ModelInputMessage["providerId"],
    role: "assistant",
    toolCalls: [
      {
        id: "call_1",
        name: "Bash",
        input: { command: "ls" },
        providerOptions: { openai: { itemId: "fc_should_not_leak" } },
      },
    ],
  };
}

function legacyRequestMessages(): ModelInputMessage[] {
  return [
    { role: "user", content: "hi" },
    legacyAssistantMessage(),
    {
      role: "tool",
      content: "ok",
      isError: false,
      toolCallId: "call_1",
      toolName: "Bash",
    },
  ];
}

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function responsesBody(): Record<string, unknown> {
  return {
    id: "resp_test",
    object: "response",
    created_at: 0,
    model: "gpt-6.1-sol",
    status: "completed",
    output: [
      {
        type: "message",
        id: "msg_test",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "ok", annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function chatCompletionsBody(): Record<string, unknown> {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 0,
    model: "gpt-6.1-sol",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "ok" },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function anthropicBody(): Record<string, unknown> {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-4-5",
    content: [{ type: "text", text: "ok" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

async function generateBody(input: {
  apiFormat: string;
  createModel: (fetchImpl: typeof fetch) => ResolvedAiSdkModel["model"];
  providerKind: ResolvedAiSdkModel["providerKind"];
  respond: () => Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const transport = createMockTransport(() => jsonResponse(input.respond()));
  const resolved = {
    headers: {},
    model: input.createModel(transport.fetch as unknown as typeof fetch),
    modelId: "gpt-6.1-sol",
    properties: PROPERTIES,
    providerId: "new-provider",
    providerKind: input.providerKind,
    providerOptions: { apiFormat: input.apiFormat },
  } as unknown as ResolvedAiSdkModel;

  await generateText(
    createGenerateTextOptions({
      includeModelIO: false,
      request: { messages: legacyRequestMessages() } as AiSdkModelTextRequest,
      resolved,
      statusContext: createStatusContext({
        modelId: "gpt-6.1-sol",
        providerId: "new-provider",
        transport: "http",
      }),
    }),
  );

  const body = transport.requests.at(-1)?.body;
  assert.ok(body, "provider request body must be captured");
  return body;
}

test("OpenAI Responses 回放不再把 part 级 itemId 展开成 item_reference", async () => {
  const body = await generateBody({
    apiFormat: "openai-responses",
    createModel: (fetchImpl) =>
      createOpenAI({
        apiKey: "test-key",
        baseURL: "https://example.invalid/v1",
        fetch: fetchImpl,
      }).responses("gpt-6.1-sol"),
    providerKind: "openai",
    respond: responsesBody,
  });

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("item_reference"), false);
  assert.equal(serialized.includes("should_not_leak"), false);

  const input = body.input as Array<Record<string, unknown>>;
  const assistant = input.find((item) => item.role === "assistant");
  assert.deepEqual(assistant?.content, [{ type: "output_text", text: "hello" }]);
  assert.ok(
    input.some((item) => item.type === "function_call" && item.call_id === "call_1"),
    "function_call 必须继续按完整调用回放",
  );
});

test("OpenAI Chat Completions 回放不携带 Gemini 的 part 级元数据", async () => {
  const body = await generateBody({
    apiFormat: "openai-chat-completions",
    createModel: (fetchImpl) =>
      createOpenAICompatible({
        apiKey: "test-key",
        baseURL: "https://example.invalid/v1",
        fetch: fetchImpl,
        name: "legacy-chat",
      }).chatModel("gpt-6.1-sol"),
    providerKind: "openai-compatible",
    respond: chatCompletionsBody,
  });

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("should_not_leak"), false);

  const messages = body.messages as Array<Record<string, unknown>>;
  const assistant = messages.find((message) => message.role === "assistant");
  assert.equal(assistant?.content, "hello");
  const toolCalls = assistant?.tool_calls as Array<Record<string, unknown>>;
  assert.equal(toolCalls.length, 1);
  assert.equal((toolCalls[0]?.function as Record<string, unknown>).name, "Bash");
});

test("Anthropic 仍回放 thinking 签名，但 text/tool_call 不带额外 providerOptions", () => {
  const messages = toAiSdkMessages(
    [
      {
        assistantContent: [
          {
            type: "reasoning",
            text: "think",
            providerOptions: { anthropic: { signature: "thinking-signature" } },
          },
          { type: "text", text: "hello" },
          { type: "tool_call", id: "call_1", name: "Bash", input: { command: "ls" } },
        ],
        content: [
          {
            type: "reasoning",
            text: "think",
            providerOptions: { anthropic: { signature: "thinking-signature" } },
          },
          { type: "text", text: "hello" },
        ],
        modelId: "claude-sonnet-4-5" as ModelInputMessage["modelId"],
        providerId: "anthropic-provider" as ModelInputMessage["providerId"],
        role: "assistant",
        toolCalls: [{ id: "call_1", name: "Bash", input: { command: "ls" } }],
      },
    ],
    { apiFormat: "anthropic-messages", providerKind: "anthropic" },
  );

  const assistant = messages.find((message) => message.role === "assistant");
  assert.ok(Array.isArray(assistant?.content));
  const parts = assistant.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    parts.map((part) => part.type),
    ["reasoning", "text", "tool-call"],
  );
  assert.deepEqual(parts[0]?.providerOptions, { anthropic: { signature: "thinking-signature" } });
  assert.equal("providerOptions" in parts[1]!, false);
  assert.equal("providerOptions" in parts[2]!, false);
});

test("Anthropic SDK 收到的 assistant 消息不包含旧格式不认识的字段", async () => {
  const body = await generateBody({
    apiFormat: "anthropic-messages",
    createModel: (fetchImpl) =>
      createAnthropic({
        apiKey: "test-key",
        baseURL: "https://example.invalid/v1",
        fetch: fetchImpl,
      })("claude-sonnet-4-5"),
    providerKind: "anthropic",
    respond: anthropicBody,
  });

  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes("should_not_leak"), false);
  const messages = body.messages as Array<Record<string, unknown>>;
  const assistant = messages.find((message) => message.role === "assistant");
  assert.equal("providerOptions" in assistant!, false);
});

test("Gemini 保留逐 part 签名与原始顺序", () => {
  const messages = toAiSdkMessages(
    [
      {
        assistantContent: [
          {
            type: "text",
            text: "hello",
            providerOptions: { google: { thoughtSignature: "text-sig" } },
          },
          {
            type: "tool_call",
            id: "call_1",
            name: "Bash",
            input: { command: "ls" },
            providerOptions: { google: { thoughtSignature: "tool-sig" } },
          },
        ],
        content: [{ type: "text", text: "hello" }],
        modelId: "gemini-3-pro-preview" as ModelInputMessage["modelId"],
        providerId: "google-provider" as ModelInputMessage["providerId"],
        role: "assistant",
        toolCalls: [{ id: "call_1", name: "Bash", input: { command: "ls" } }],
      },
    ],
    { apiFormat: "gemini-generate-content", providerKind: "google" },
  );

  const assistant = messages.find((message) => message.role === "assistant");
  const parts = assistant?.content as Array<Record<string, unknown>>;
  assert.deepEqual(
    parts.map((part) => part.type),
    ["text", "tool-call"],
  );
  assert.deepEqual(parts[0]?.providerOptions, { google: { thoughtSignature: "text-sig" } });
  assert.deepEqual(parts[1]?.providerOptions, { google: { thoughtSignature: "tool-sig" } });
});
