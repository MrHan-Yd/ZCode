import assert from "node:assert/strict";
import test from "node:test";
import {
  createGenerateTextOptions,
  createStreamTextOptions,
} from "../src/model/runner-options.js";
import type { AiSdkModelTextRequest, ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import type { ModelStatusContext } from "../src/model/runner-status.js";

const SESSION_ID = "sess_prompt_cache_test";
const PROVIDER_ID = "provider-under-test";

function createOptionsInput(input: {
  anthropicMetadataUserId?: string;
  apiFormat: string;
  providerKind: ResolvedAiSdkModel["providerKind"];
  providerOptions?: Record<string, unknown>;
  sessionId?: string;
}) {
  return {
    anthropicMetadataUserId: input.anthropicMetadataUserId,
    includeModelIO: false,
    request: {
      messages: [],
      providerOptions: input.providerOptions,
    } as unknown as AiSdkModelTextRequest,
    resolved: {
      model: {},
      modelId: "gpt-6.1-sol",
      providerId: PROVIDER_ID,
      providerKind: input.providerKind,
      providerOptions: { apiFormat: input.apiFormat },
      properties: {},
    } as unknown as ResolvedAiSdkModel,
    statusContext: {
      maxAttempts: 1,
      modelCall: {},
      modelId: "gpt-6.1-sol",
      modelRequestSessionType: "main",
      providerId: PROVIDER_ID,
      requestId: "request-prompt-cache-test",
      sessionId: input.sessionId,
      traceId: "trace-prompt-cache-test",
      transport: "sse",
    } as unknown as ModelStatusContext,
  };
}

function openAIOptions(options: { providerOptions?: unknown }): Record<string, unknown> | undefined {
  const providerOptions = options.providerOptions as Record<string, unknown> | undefined;
  const openai = providerOptions?.openai;
  return typeof openai === "object" && openai !== null
    ? (openai as Record<string, unknown>)
    : undefined;
}

test("流式 Responses 请求用会话 id 填充 promptCacheKey", () => {
  const options = createStreamTextOptions(
    createOptionsInput({
      apiFormat: "openai-responses",
      providerKind: "openai",
      sessionId: SESSION_ID,
    }),
  );

  assert.equal(openAIOptions(options)?.promptCacheKey, SESSION_ID);
});

test("非流式 Responses 请求同样填充 promptCacheKey", () => {
  const options = createGenerateTextOptions(
    createOptionsInput({
      apiFormat: "openai-responses",
      providerKind: "openai",
      sessionId: SESSION_ID,
    }),
  );

  assert.equal(openAIOptions(options)?.promptCacheKey, SESSION_ID);
});

test("缺少 sessionId 时不注入 promptCacheKey", () => {
  const options = createStreamTextOptions(
    createOptionsInput({ apiFormat: "openai-responses", providerKind: "openai" }),
  );

  assert.equal(openAIOptions(options), undefined);
});

test("Chat Completions 与 Anthropic 格式不受影响", () => {
  const chatOptions = createStreamTextOptions(
    createOptionsInput({
      apiFormat: "openai-chat-completions",
      providerKind: "openai-compatible",
      sessionId: SESSION_ID,
    }),
  );
  const anthropicOptions = createStreamTextOptions(
    createOptionsInput({
      apiFormat: "anthropic-messages",
      providerKind: "anthropic",
      sessionId: SESSION_ID,
    }),
  );

  assert.equal(openAIOptions(chatOptions), undefined);
  assert.equal(openAIOptions(anthropicOptions), undefined);
});

test("调用方显式给出的 promptCacheKey 优先", () => {
  const options = createStreamTextOptions(
    createOptionsInput({
      apiFormat: "openai-responses",
      providerKind: "openai",
      providerOptions: { openai: { promptCacheKey: "caller-key" } },
      sessionId: SESSION_ID,
    }),
  );

  assert.equal(openAIOptions(options)?.promptCacheKey, "caller-key");
});

test("Anthropic metadata 注入与 Responses 键互不影响", () => {
  const options = createStreamTextOptions(
    createOptionsInput({
      anthropicMetadataUserId: "device-metadata-user",
      apiFormat: "anthropic-messages",
      providerKind: "anthropic",
      sessionId: SESSION_ID,
    }),
  );
  const providerOptions = options.providerOptions as
    | { anthropic?: { metadata?: { userId?: string } } }
    | undefined;

  assert.equal(providerOptions?.anthropic?.metadata?.userId, "device-metadata-user");
  assert.equal(openAIOptions(options), undefined);
});
