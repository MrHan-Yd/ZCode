import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelId,
  createModelProviderId,
  type ModelNetworkStatusEvent,
  type ModelProperties,
  type ModelTextResult,
} from "@zcode/contracts";
import type { RegistryProviderConfig } from "@zcode/provider";
import { AiSdkModelExecution } from "../src/model/model-execution.js";
import { runGenerateText } from "../src/model/runner-generate.js";
import {
  defaultRuntime,
  type AiSdkModelTextRequest,
  type ResolvedAiSdkModel,
} from "../src/model/runner-runtime.js";
import { resolveAiSdkModelRetryOptions } from "../src/model/retry-policy.js";
import { createMockTransport, jsonResponse } from "./geminiTestSupport.js";

const ANTHROPIC_PROVIDER_ID = "anthropic-personal";
const ANTHROPIC_MODEL_ID = "claude-signature-test";
const REJECTED_SIGNATURE = "sig-rejected-by-upstream";
const SIGNATURE_REJECTION_MESSAGE =
  "messages.1.content.0: signature in thinking block cannot be modified";

const ANTHROPIC_PROPERTIES: ModelProperties = {
  contextWindow: 200_000,
  inputFormat: {
    supportsAudio: false,
    supportsImage: true,
    supportsPdf: true,
    supportsText: true,
    supportsVideo: false,
  },
  outputFormat: { supportsText: true },
  requiresMfjsToolSchema: false,
  supportsJsonSchemaOutput: false,
  supportsMidConversationSystem: false,
  supportsNativeWebSearch: false,
  supportsToolCall: true,
};

function createAnthropicExecution(input: {
  respond: Parameters<typeof createMockTransport>[0];
}): {
  requests: ReturnType<typeof createMockTransport>["requests"];
  resolved: ResolvedAiSdkModel;
} {
  const transport = createMockTransport(input.respond);
  const execution = new AiSdkModelExecution(
    // 空 env 关闭真实代理/TLS 策略，确保请求只进入 mock transport。
    { env: {} },
    { transport: transport.fetch },
  );
  const binding = execution.bindModel({
    providerId: ANTHROPIC_PROVIDER_ID,
    modelId: ANTHROPIC_MODEL_ID,
    providerConfig: {
      api: {
        type: "anthropic-messages",
        baseUrl: "https://api.anthropic.test/",
        headers: null,
      },
      access: { type: "api-key", apiKey: "frozen-key" },
    } as unknown as RegistryProviderConfig,
    supportsJsonSchemaOutput: false,
    optionSpecs: {
      reasoningLevel: {
        map: "{'thinking': {'budget_tokens': reasoningLevel == 'low' ? 1024 : 8192, 'type': 'enabled'}}",
      },
      maxOutputTokens: { map: "{'max_tokens': maxOutputTokens}" },
    },
  });
  return {
    requests: transport.requests,
    resolved: {
      ...binding.resolveRequest({ options: { maxOutputTokens: 1024, reasoningLevel: "low" } }),
      properties: ANTHROPIC_PROPERTIES,
    } as ResolvedAiSdkModel,
  };
}

function signedAssistantRequest(): AiSdkModelTextRequest {
  return {
    messages: [
      { content: "hi", role: "user" },
      {
        assistantContent: [
          {
            providerOptions: { anthropic: { signature: REJECTED_SIGNATURE } },
            text: "planning",
            type: "reasoning",
          },
          { text: "answer", type: "text" },
        ],
        // 真实历史里 content 是 assistantContent 的派生兼容视图；旧格式 wire
        // 只读 content，因此这里必须同步给出同一份 reasoning 签名。
        content: [
          {
            providerOptions: { anthropic: { signature: REJECTED_SIGNATURE } },
            text: "planning",
            type: "reasoning",
          },
          { text: "answer", type: "text" },
        ],
        modelId: createModelId(ANTHROPIC_MODEL_ID),
        providerId: createModelProviderId(ANTHROPIC_PROVIDER_ID),
        role: "assistant",
      },
      { content: "next", role: "user" },
    ],
    statusSink: undefined,
  };
}

test("400 thinking signature 拒绝后真实重试一次并发送清理后的请求体", async () => {
  let physicalAttempt = 0;
  const execution = createAnthropicExecution({
    respond: () => {
      physicalAttempt += 1;
      if (physicalAttempt === 1) {
        return jsonResponse(
          {
            error: { message: SIGNATURE_REJECTION_MESSAGE, type: "invalid_request_error" },
            type: "error",
          },
          400,
        );
      }
      return jsonResponse({
        content: [{ text: "recovered", type: "text" }],
        id: "msg-signature-retry",
        model: ANTHROPIC_MODEL_ID,
        role: "assistant",
        stop_reason: "end_turn",
        type: "message",
        usage: { input_tokens: 3, output_tokens: 1 },
      });
    },
  });
  const statusEvents: ModelNetworkStatusEvent[] = [];
  const request = signedAssistantRequest();
  request.statusSink = {
    publish: (event) => {
      statusEvents.push(event);
    },
  };

  const result: ModelTextResult = await runGenerateText({
    env: {},
    modelIoFullRetentionEnabled: false,
    request,
    resolveModel: () => execution.resolved,
    resolved: execution.resolved,
    // 只保留首请求预算：若第二次物理请求不是签名修复专属机会，就不会发生。
    retry: resolveAiSdkModelRetryOptions(
      { baseDelayMs: 0, jitter: false, maxAttempts: 1 },
      {},
    ),
    runtime: defaultRuntime,
  });

  assert.equal(execution.requests.length, 2, "必须发生第二次物理请求");
  const firstBody = JSON.stringify(execution.requests[0]?.body);
  const secondBodyText = JSON.stringify(execution.requests[1]?.body);
  assert.equal(firstBody.includes(REJECTED_SIGNATURE), true, "首请求应携带被拒签名");
  assert.equal(
    secondBodyText.includes(REJECTED_SIGNATURE),
    false,
    "第二次物理请求体不得再携带被拒签名",
  );

  const secondMessages = execution.requests[1]?.body?.messages as
    | Array<Record<string, unknown>>
    | undefined;
  assert.ok(secondMessages);
  const repairedAssistant = secondMessages[1];
  assert.deepEqual(repairedAssistant, {
    content: [{ text: "answer", type: "text" }],
    role: "assistant",
  });
  assert.equal(result.text, "recovered");

  const signatureRetry = statusEvents.find(
    (event) => event.type === "model_retry_scheduled",
  ) as Extract<ModelNetworkStatusEvent, { type: "model_retry_scheduled" }> | undefined;
  assert.ok(signatureRetry, "必须发布重试计划状态");
  assert.equal(signatureRetry.reason, "reasoning_signature_repair");
  assert.equal(signatureRetry.delayMs, 0);

  const failedEvent = statusEvents.find((event) => event.type === "model_request_failed");
  assert.ok(failedEvent);
  assert.equal(failedEvent.statusCode, 400);
  assert.equal(failedEvent.retryable, true);
});
