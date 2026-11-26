import assert from "node:assert/strict";
import test from "node:test";
import {
  createModelId,
  createModelProviderId,
  type Model,
  type ModelInputMessage,
  type ModelRequest,
} from "@zcode/contracts";
import {
  createRuntimeUserEntry,
  realUserRuntimeMetadata,
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../src/agent/message-history.js";
import { buildRuntimeProviderRequestMessages } from "../src/runtime/helpers/runtime-provider-request-messages.js";
import { resolveUseMidConversationSystem } from "../src/runtime/helpers/mid-conversation-system-mode.js";
import { buildCompactSummaryRequestMessages } from "../src/runtime/methods/compact-active-helpers.js";

function requestModel(providerKind: string): Model {
  const model: Model = {
    providerId: createModelProviderId(`${providerKind}-provider`),
    modelId: createModelId("gemini-3.5-flash"),
    providerKind,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 1_000_000,
      inputFormat: {
        supportsAudio: false,
        supportsImage: true,
        supportsPdf: true,
        supportsText: true,
        supportsVideo: true,
      },
      outputFormat: { supportsText: true },
      supportsJsonSchemaOutput: true,
      supportsMidConversationSystem: false,
      supportsNativeWebSearch: false,
      supportsToolCall: true,
    },
    optionSpecs: {
      maxOutputTokens: { max: 8192, map: "{}" },
      reasoningLevel: { values: ["low"], map: "{}" },
    },
    options: { maxOutputTokens: 2048, reasoningLevel: "low" },
    bind: () => model,
    generateText: (_request: ModelRequest) => {
      throw new Error("projection test never calls the model");
    },
    // eslint-disable-next-line require-yield -- 投影测试不消费流
    async *streamText(_request: ModelRequest): AsyncIterable<never> {
      throw new Error("projection test never calls the model");
    },
  };
  return model;
}

function midConversationEntries(): RuntimeMessageEntry[] {
  return [
    createRuntimeUserEntry("hello", realUserRuntimeMetadata()),
    systemReminderAttachmentEntry("hook_context", "hook body"),
    { message: { content: "reply", role: "assistant" } },
  ];
}

function midConversationSystemIndexes(messages: ModelInputMessage[]): number[] {
  return messages.flatMap((message, index) => (message.role === "system" ? [index] : []));
}

test("google force 模式仍按 supportsMidConversationSystem=false 投影提醒，不生成中途 system", () => {
  const projection = buildRuntimeProviderRequestMessages(
    { config: { midConversationSystem: { mode: "force" } } },
    { entries: midConversationEntries(), model: requestModel("google") },
  );
  // Google 原生协议只允许开头 systemInstruction；中途 system 会让 SDK 抛
  // UnsupportedFunctionalityError，因此 force 不能越过协议边界。
  assert.deepEqual(midConversationSystemIndexes(projection.messages), []);
  assert.equal(
    projection.messages.some(
      (message) => message.role === "user" && String(message.content).includes("hook body"),
    ),
    true,
  );
});

test("非 google force 模式保持既有中途 system 行为", () => {
  const projection = buildRuntimeProviderRequestMessages(
    { config: { midConversationSystem: { mode: "force" } } },
    { entries: midConversationEntries(), model: requestModel("anthropic") },
  );
  // 对照组：同一 force 配置在支持该投影的 provider 上必须仍产生中途 system，
  // 证明本次修复只收窄 google，而不是把 force 整体失效。
  assert.deepEqual(midConversationSystemIndexes(projection.messages), [1]);
});

test("resolveUseMidConversationSystem 对 google 硬返回 false，即使属性误报", () => {
  const google = requestModel("google");
  const misreportingGoogle: Model = {
    ...google,
    properties: { ...google.properties, supportsMidConversationSystem: true },
  };
  assert.equal(
    resolveUseMidConversationSystem({ midConversationSystem: { mode: "force" } }, google),
    false,
  );
  assert.equal(
    resolveUseMidConversationSystem(
      { midConversationSystem: { mode: "force" } },
      misreportingGoogle,
    ),
    false,
    "google 协议边界不能依赖模型属性是否误报",
  );
  assert.equal(
    resolveUseMidConversationSystem(
      { midConversationSystem: { mode: "force" } },
      requestModel("anthropic"),
    ),
    true,
  );
});

test("google force 模式 compact summary 请求投影不生成中途 system", () => {
  const model = requestModel("google");
  const useMidConversationSystem = resolveUseMidConversationSystem(
    { midConversationSystem: { mode: "force" } },
    model,
  );
  assert.equal(useMidConversationSystem, false);

  const messages = buildCompactSummaryRequestMessages(midConversationEntries(), "summarize", {
    useMidConversationSystem,
  });
  assert.deepEqual(midConversationSystemIndexes(messages), []);
  assert.equal(
    messages.some(
      (message) => message.role === "user" && String(message.content).includes("hook body"),
    ),
    true,
    "提醒仍需以 user 投影保留，而不是被丢弃",
  );
});
