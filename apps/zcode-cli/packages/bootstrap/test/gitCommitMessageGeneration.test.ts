import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ModelErrorCode, ModelProtocolError, type Model } from "@zcode/contracts";
import {
  ApiKeyAccessConfig,
  createRegistryModelConfig,
  createRegistryProviderConfig,
  ModelConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderRegistry,
  type ModelSelection,
  type Provider,
  type RegistryProviderConfigObject,
} from "@zcode/provider";
import { ApiProviderModelRuntime } from "../src/app/provider-registry-model-runtime.js";
import { createSessionFacade } from "../src/app/session-facade.js";

type FacadeDeps = Parameters<typeof createSessionFacade>[0];
type GenerateWorkspaceText = FacadeDeps["runtime"]["generateWorkspaceText"];
type GenerationInput = Parameters<GenerateWorkspaceText>[0];
type ModelAdapter = ConstructorParameters<typeof ApiProviderModelRuntime>[0]["modelAdapter"];
type AdapterInput = Parameters<ModelAdapter["createModel"]>[0];
type ApiType = RegistryProviderConfigObject["api"]["type"];

const TARGET_PROVIDER = "git-fixed-provider";
const MODEL_ID = "shared-model-id";
const DEFAULT_SELECTION: ModelSelection = {
  providerId: "host-default-provider",
  modelId: MODEL_ID,
  options: { reasoningLevel: "default-only" },
};

function createProvider(providerId: string, apiType: ApiType, levels: readonly string[]): Provider {
  const provider = createRegistryProviderConfig(
    new ProviderConfig({
      group: "standard-personal",
      access: new ApiKeyAccessConfig({ type: "api-key", apiKey: "offline-fixture-placeholder" }),
      api: new ProviderApiConfig({ type: apiType, baseUrl: "https://offline.invalid/v1" }),
      visibility: "visible",
    }),
  );
  const model = createRegistryModelConfig(
    ModelConfig.fromData({
      enabled: true,
      properties: {
        requiresMfjsToolSchema: false,
        contextWindow: 32_768,
        inputFormat: {
          supportsText: true,
          supportsImage: false,
          supportsVideo: false,
          supportsAudio: false,
          supportsPdf: false,
        },
        outputFormat: { supportsText: true },
        supportsToolCall: false,
        supportsJsonSchemaOutput: false,
        supportsNativeWebSearch: false,
        supportsMidConversationSystem: true,
      },
      optionSpecs: {
        // 空映射也覆盖不发送推理参数的单档模型；执行选择仍须带公开档位。
        reasoningLevel: { values: levels, map: "{}" },
        maxOutputTokens: { max: 8_192, map: '{"max_tokens": maxOutputTokens}' },
      },
    }),
  );
  assert.ok(provider.ok, JSON.stringify(provider));
  assert.ok(model.ok, JSON.stringify(model));
  return {
    providerId,
    config: provider.config,
    models: [{ modelId: MODEL_ID, config: model.config }],
  };
}

function unexpectedOperation(): never {
  throw new Error("此离线 harness 不执行真实模型、网络或存储操作");
}

function createOfflineModel(input: AdapterInput): Model {
  return {
    providerId: input.providerId as Model["providerId"],
    modelId: input.modelId as Model["modelId"],
    properties: input.modelConfig.properties,
    optionSpecs: input.modelConfig.optionSpecs,
    options: { ...input.options },
    bind: unexpectedOperation,
    generateText: unexpectedOperation,
    streamText: unexpectedOperation,
  };
}

function createHarness(
  t: TestContext,
  options: {
    apiType?: ApiType;
    levels?: readonly string[];
    sessionSelection?: ModelSelection;
  } = {},
) {
  const defaultProvider = createProvider("host-default-provider", "openai-responses", [
    "default-only",
  ]);
  const targetProvider = createProvider(
    TARGET_PROVIDER,
    options.apiType ?? "openai-responses",
    options.levels ?? ["minimal", "high"],
  );
  // 默认渠道排在首位且使用相同 modelId，静默 fallback 会被目标 adapter 断言发现。
  const registry = new ProviderRegistry([defaultProvider, targetProvider]);
  const adapterCalls: AdapterInput[] = [];
  const modelRuntime = new ApiProviderModelRuntime({
    registry,
    modelAdapter: {
      createModel(input) {
        adapterCalls.push(input);
        return createOfflineModel(input);
      },
    },
  });
  modelRuntime.start();
  t.after(() => modelRuntime.dispose());
  const receivedInputs: GenerationInput[] = [];
  const sessionSelection = options.sessionSelection ?? DEFAULT_SELECTION;
  const generateWorkspaceText: GenerateWorkspaceText = async (input) => {
    receivedInputs.push(input);
    // 固定设置只有身份时，旧 facade 在真实 Factory 校验处先失败；创建后的 bind 来不及补档。
    const model = modelRuntime.modelFactory({ selection: input.selection });
    return {
      text: `chore: ${model.providerId}/${model.modelId}`,
      selection: input.selection,
      finishReason: "stop",
    };
  };
  const runtime = {
    generateWorkspaceText,
    getSessionModelSelection: () => sessionSelection,
  } satisfies Pick<FacadeDeps["runtime"], "generateWorkspaceText" | "getSessionModelSelection">;
  // 构造与本次入口只读 ui.locale，未调用的 Agent、执行器和 store 不装配，避免任何外部 IO。
  const facade = createSessionFacade({
    configResult: { config: { ui: { locale: "zh-CN" } } },
    configuredDefaultModelSelection: DEFAULT_SELECTION,
    providerRegistry: registry,
    runtime,
  } as unknown as FacadeDeps);
  return { facade, registry, defaultProvider, receivedInputs, adapterCalls, sessionSelection };
}

const API_TYPES: readonly ApiType[] = [
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
];

for (const apiType of API_TYPES) {
  for (const levels of [["disabled"], ["minimal", "high"]]) {
    test(`${apiType} 固定身份以公开最低档 ${levels[0]} 进入原指定 adapter`, async (t) => {
      const harness = createHarness(t, { apiType, levels });
      const selection: ModelSelection = { providerId: TARGET_PROVIDER, modelId: MODEL_ID };
      const result = await harness.facade.generateWorkspaceText({
        selection,
        prompt: "只生成提交消息",
        querySource: "git_commit_message",
      });
      assert.equal(result.text, `chore: ${TARGET_PROVIDER}/${MODEL_ID}`);
      assert.deepEqual(harness.receivedInputs[0]?.selection, {
        ...selection,
        options: { reasoningLevel: levels[0] },
      });
      assert.equal(harness.adapterCalls.length, 1);
      assert.equal(harness.adapterCalls[0]?.providerId, TARGET_PROVIDER);
      assert.equal(harness.adapterCalls[0]?.modelId, MODEL_ID);
      assert.equal(harness.adapterCalls[0]?.providerConfig.api.type, apiType);
      assert.deepEqual(harness.adapterCalls[0]?.options, { reasoningLevel: levels[0] });
      assert.deepEqual(selection, { providerId: TARGET_PROVIDER, modelId: MODEL_ID });
      assert.equal(harness.sessionSelection, DEFAULT_SELECTION);
    });
  }
}

test("跟随 high 的 Git 请求在创建前使用最低档，trim querySource 且不写回主会话", async (t) => {
  const selection: ModelSelection = {
    providerId: TARGET_PROVIDER,
    modelId: MODEL_ID,
    options: { reasoningLevel: "high" },
  };
  const harness = createHarness(t, { sessionSelection: selection });
  await harness.facade.generateWorkspaceText({
    selection,
    prompt: "只生成提交消息",
    querySource: " \tgit_commit_message\n ",
    maxOutputTokens: 777,
  });
  assert.deepEqual(harness.adapterCalls[0]?.options, { reasoningLevel: "minimal" });
  assert.equal(harness.receivedInputs[0]?.querySource, " \tgit_commit_message\n ");
  assert.equal(harness.receivedInputs[0]?.maxOutputTokens, 777);
  assert.equal(harness.sessionSelection, selection);
  assert.deepEqual(selection.options, { reasoningLevel: "high" });
});

for (const unavailable of [
  {
    selection: { providerId: "unknown-provider", modelId: MODEL_ID },
    code: ModelErrorCode.ProviderNotFound,
  },
  {
    selection: { providerId: TARGET_PROVIDER, modelId: "unknown-model" },
    code: ModelErrorCode.ModelNotFound,
  },
]) {
  test(`失效固定选择 ${unavailable.code} 明确拒绝，不回退默认渠道`, async (t) => {
    const harness = createHarness(t);
    await assert.rejects(
      harness.facade.generateWorkspaceText({
        selection: unavailable.selection,
        prompt: "只生成提交消息",
        querySource: "git_commit_message",
      }),
      (error: unknown) => error instanceof ModelProtocolError && error.code === unavailable.code,
    );
    assert.equal(harness.adapterCalls.length, 0);
    assert.equal(harness.receivedInputs[0]?.selection, unavailable.selection);
  });
}

for (const reason of ["provider-deleted", "provider-disabled"]) {
  test(`registry 未发布 ${reason} 的固定模型时拒绝，不替换模型`, async (t) => {
    const harness = createHarness(t);
    harness.registry.replace([harness.defaultProvider], reason);
    await assert.rejects(
      harness.facade.generateWorkspaceText({
        selection: { providerId: TARGET_PROVIDER, modelId: MODEL_ID },
        prompt: "只生成提交消息",
        querySource: "git_commit_message",
      }),
      (error: unknown) =>
        error instanceof ModelProtocolError && error.code === ModelErrorCode.ProviderNotFound,
    );
    assert.equal(harness.adapterCalls.length, 0);
  });
}

test("prompt_enhance 保持原 high 选择，不套用 Git 最低档策略", async (t) => {
  const harness = createHarness(t);
  const selection: ModelSelection = {
    providerId: TARGET_PROVIDER,
    modelId: MODEL_ID,
    options: { reasoningLevel: "high" },
  };
  await harness.facade.generateWorkspaceText({
    selection,
    prompt: "增强提示",
    querySource: "prompt_enhance",
  });
  assert.equal(harness.receivedInputs[0]?.selection, selection);
  assert.deepEqual(harness.adapterCalls[0]?.options, { reasoningLevel: "high" });
});

test("prompt_enhance 缺档仍按原 normalize 路径拒绝，不扩大辅助补档范围", async (t) => {
  const harness = createHarness(t);
  await assert.rejects(
    harness.facade.generateWorkspaceText({
      selection: { providerId: TARGET_PROVIDER, modelId: MODEL_ID },
      prompt: "增强提示",
      querySource: "prompt_enhance",
    }),
    (error: unknown) =>
      error instanceof ModelProtocolError && error.code === ModelErrorCode.InvalidModelRequest,
  );
  assert.equal(harness.adapterCalls.length, 0);
});
