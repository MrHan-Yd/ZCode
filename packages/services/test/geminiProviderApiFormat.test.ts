import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { AppSettings } from "@zcode/shared";
import {
  ApiKeyAccessConfig,
  compileModelOptionMaps,
  ModelConfig,
  ModelConfigRules,
  parseProviderConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  type ModelConfigRules as ModelConfigRulesType,
} from "@zcode/provider";
import {
  createNodePersonalProviderConfigRepository,
  decodeZCodeBuiltinRelease,
} from "@zcode/provider-node";
import type { AccountProviderService } from "@zcode/provider";
import type { ICredentialService } from "../src/credential/credential.js";
import { importLegacyPersonalProviderConfig } from "../src/model-provider/legacyPersonalProviderConfigImporter.js";
import { readLegacyZCodeConfigProviders } from "../src/model-provider/legacyZCodeConfigProviderReader.js";
import {
  migrateLegacyModelProviderConfig,
  legacyModelProviderListSchema,
} from "../src/model-provider/legacyModelProviderSerialized.js";
import {
  parseProviderItemContent,
  providerItemContent,
  restoreLocalApiKey,
} from "../src/model-provider/providerConfigSyncModel.js";
import { createProviderProvisioningTarget } from "../src/model-provider/providerProvisioningTarget.js";
import type { ProviderRuntime } from "../src/model-provider/providerRuntime.js";
import { getAppConfigDir, setDataBaseDir } from "../src/paths.js";
import type { ISettingService } from "../src/setting/setting.js";

const BUILTIN_PATH = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function geminiProviderConfig(overrides: { baseUrl?: string } = {}): ProviderConfig {
  return new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({ type: "api-key", apiKey: "test-only-gemini-key" }),
    api: new ProviderApiConfig({
      type: "gemini-generate-content",
      baseUrl: overrides.baseUrl ?? GEMINI_BASE_URL,
      headers: { "X-Test-Header": "test-only" },
    }),
    personalModelIds: ["gemini-2.5-pro"],
    modelOrder: ["gemini-2.5-pro"],
  });
}

function completeGeminiProviderInput() {
  return {
    group: "standard-personal" as const,
    access: { type: "api-key" as const, apiKey: "test-only-gemini-key" },
    api: {
      type: "gemini-generate-content" as const,
      baseUrl: GEMINI_BASE_URL,
      headers: { "X-Test-Header": "test-only" },
    },
    personalModelIds: ["gemini-2.5-pro"],
    modelOrder: ["gemini-2.5-pro"],
  };
}

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function loadBuiltinModelRules(): Promise<ModelConfigRulesType> {
  const release = decodeZCodeBuiltinRelease(JSON.parse(await readFile(BUILTIN_PATH, "utf8")));
  return release.config.modelConfigRules;
}

function compileResolvedOptionMaps(config: ModelConfig) {
  const specs = config.optionSpecs;
  assert.ok(specs, "resolved model config 必须提供 optionSpecs");
  const reasoningMap = specs.reasoningLevel?.map;
  const maxOutputTokensMap = specs.maxOutputTokens?.map;
  assert.ok(reasoningMap, "reasoningLevel.map 必须存在");
  assert.ok(maxOutputTokensMap, "maxOutputTokens.map 必须存在");
  return compileModelOptionMaps({
    reasoningLevel: { map: reasoningMap },
    maxOutputTokens: { map: maxOutputTokensMap },
  });
}

/** option map 输出使用 null prototype 对象；测试比较前归一成普通 JSON。 */
function plainJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

test("provider schema 接受 gemini-generate-content 并保持 ProviderApiConfig 往返", () => {
  const parsed = parseProviderConfig(completeGeminiProviderInput());
  assert.equal(parsed.api?.type, "gemini-generate-content");
  assert.equal(parsed.api?.baseUrl, GEMINI_BASE_URL);
  assert.deepEqual(parsed.validateComplete(), []);
  const json = parsed.toJSON();
  assert.deepEqual(json, completeGeminiProviderInput());
  assert.deepEqual(parseProviderConfig(json).toJSON(), json);
});

test("provider schema 拒绝未登记的 API 格式", () => {
  assert.throws(() =>
    parseProviderConfig({
      ...completeGeminiProviderInput(),
      api: { type: "gemini", baseUrl: GEMINI_BASE_URL },
    }),
  );
  assert.throws(() =>
    parseProviderConfig({
      ...completeGeminiProviderInput(),
      api: { type: "google", baseUrl: GEMINI_BASE_URL },
    }),
  );
});

test("旧三种 API 格式的解析与完整校验保持不变", () => {
  for (const type of [
    "anthropic-messages",
    "openai-chat-completions",
    "openai-responses",
  ] as const) {
    const parsed = parseProviderConfig({
      group: "standard-personal",
      access: { type: "api-key", apiKey: "test-only-key" },
      api: { type, baseUrl: "https://gateway.example.test/v1" },
      personalModelIds: ["model-a"],
    });
    assert.equal(parsed.api?.type, type);
    assert.deepEqual(parsed.validateComplete(), []);
  }
});

test("gemini 个人配置经 repository 保存后重读保持格式、Base URL 与 Key", async () => {
  await withTempDir("zcode-gemini-personal-", async (dir) => {
    const filePath = join(dir, "provider_config.json");
    const repository = createNodePersonalProviderConfigRepository({
      filePath,
      pollingIntervalMs: false,
    });
    try {
      const config = geminiProviderConfig();
      await repository.update(() => ({
        providers: new ProviderConfigMap([{ providerId: "gemini-personal", config }]),
        models: ModelConfigRules.empty(),
        providerOrder: ["gemini-personal"],
      }));
    } finally {
      repository.dispose();
    }

    const raw = JSON.parse(await readFile(filePath, "utf8")) as {
      schemaVersion: number;
      config: {
        providerConfigRules: {
          providerRules: Array<{ config: { api?: Record<string, unknown> } }>;
        };
      };
    };
    assert.equal(raw.schemaVersion, 1);
    assert.deepEqual(raw.config.providerConfigRules.providerRules[0]?.config.api, {
      type: "gemini-generate-content",
      baseUrl: GEMINI_BASE_URL,
      headers: { "X-Test-Header": "test-only" },
    });

    const reopened = createNodePersonalProviderConfigRepository({
      filePath,
      pollingIntervalMs: false,
    });
    try {
      const snapshot = await reopened.read();
      const reloaded = snapshot.providers.get("gemini-personal");
      assert.ok(reloaded);
      assert.equal(reloaded.api?.type, "gemini-generate-content");
      assert.equal(reloaded.api?.baseUrl, GEMINI_BASE_URL);
      assert.equal(reloaded.access?.type, "api-key");
      assert.equal(
        reloaded.access?.type === "api-key" ? reloaded.access.apiKey : undefined,
        "test-only-gemini-key",
      );
      assert.deepEqual(reloaded.personalModelIds, ["gemini-2.5-pro"]);
      assert.deepEqual(snapshot.providerOrder, ["gemini-personal"]);
      assert.deepEqual(reloaded.validateComplete(), []);
    } finally {
      reopened.dispose();
    }
  });
});

test("Gist 条目剥离 gemini access.apiKey，下载后按本机 Key 补回", () => {
  const local = geminiProviderConfig();
  const content = providerItemContent({ providerId: "gemini-personal", config: local });
  const uploaded = JSON.parse(content) as {
    providerId: string;
    config: {
      api: { type: string; baseUrl: string; headers?: Record<string, string> };
      access?: Record<string, unknown>;
      personalModelIds?: string[];
    };
  };
  assert.equal(uploaded.providerId, "gemini-personal");
  assert.deepEqual(uploaded.config.api, {
    type: "gemini-generate-content",
    baseUrl: GEMINI_BASE_URL,
    headers: { "X-Test-Header": "test-only" },
  });
  assert.deepEqual(uploaded.config.access, { type: "api-key" });
  assert.equal("apiKey" in (uploaded.config.access ?? {}), false);
  assert.deepEqual(uploaded.config.personalModelIds, ["gemini-2.5-pro"]);

  const parsedRule = parseProviderItemContent(content);
  assert.ok(parsedRule);
  assert.equal(parsedRule.config.api?.type, "gemini-generate-content");
  assert.equal(
    parsedRule.config.access?.type === "api-key" ? parsedRule.config.access.apiKey : "unexpected",
    undefined,
  );

  const restored = restoreLocalApiKey(parsedRule.config, local);
  assert.equal(
    restored.access?.type === "api-key" ? restored.access.apiKey : undefined,
    "test-only-gemini-key",
  );
  assert.equal(restored.api?.type, "gemini-generate-content");
  assert.equal(restored.api?.baseUrl, GEMINI_BASE_URL);
});

interface ProvisioningFixture {
  readonly target: ReturnType<typeof createProviderProvisioningTarget>;
  readonly filePath: string;
  readonly settingState: AppSettings;
  armConcurrentEdit(): void;
}

async function createProvisioningFixture(dir: string): Promise<ProvisioningFixture> {
  const filePath = join(dir, "provider_config.json");
  const stateFilePath = join(dir, "runtime", "provider", "provisioning.json");
  await mkdir(join(dir, "runtime", "provider"), { recursive: true });

  const inner = createNodePersonalProviderConfigRepository({
    filePath,
    pollingIntervalMs: false,
  });
  // 在 Provisioning 已读取、CAS 写入前插入另一个 writer，验证不会覆盖新配置。
  let concurrentEdit = false;
  const repository = {
    read: () => inner.read(),
    onDidChange: (listener: (reason: string) => void) => inner.onDidChange(listener),
    update: async (
      transform: Parameters<typeof inner.update>[0],
    ): Promise<Awaited<ReturnType<typeof inner.update>>> => {
      if (concurrentEdit) {
        concurrentEdit = false;
        await inner.update(() => ({
          providers: new ProviderConfigMap([
            {
              providerId: "concurrent-writer",
              config: new ProviderConfig({
                group: "standard-personal",
                access: new ApiKeyAccessConfig({ apiKey: "concurrent-key" }),
                api: new ProviderApiConfig({
                  type: "anthropic-messages",
                  baseUrl: "https://concurrent.example.test",
                }),
              }),
            },
          ]),
          models: ModelConfigRules.empty(),
          providerOrder: ["concurrent-writer"],
        }));
      }
      return inner.update(transform);
    },
  };

  const settingState: AppSettings = {
    locale: "zh-CN",
    recentProjects: [],
    providerFamilyConnectionSelections: {},
  };
  const settingService: ISettingService = {
    get: async () => settingState,
    update: async (patch) => {
      Object.assign(settingState, patch);
    },
    updateDataBaseDir: async () => {},
    ensureDefaultProject: async () => ({ path: "", created: false }),
  };

  const credentials = new Map<string, string>();
  const credentialService: ICredentialService = {
    load: async (key) => credentials.get(key) ?? null,
    save: async (key, value) => {
      credentials.set(key, value);
    },
    delete: async (key) => {
      credentials.delete(key);
    },
  };

  const providerRuntime = {
    start: async () => {},
    registryService: {
      refresh: async () => ({ sourceRevisions: { config: "gemini-provisioning-rev" } }),
      validateSelection: () => ({ ok: true }),
    },
  } as unknown as ProviderRuntime;
  const accountProviderSource = {
    refresh: async () => ({}),
  } as unknown as AccountProviderService;

  return {
    target: createProviderProvisioningTarget({
      providerRuntime,
      personalRepository: repository,
      accountProviderSource,
      credentialService,
      settingService,
      personalConfigFilePath: filePath,
      stateFilePath,
    }),
    filePath,
    settingState,
    armConcurrentEdit: () => {
      concurrentEdit = true;
    },
  };
}

function geminiProvisioningEnvelope(syncId: string) {
  return {
    schemaVersion: 1 as const,
    syncId,
    personalConfig: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "gemini-personal",
            providerName: "Gemini Native",
            enabled: true,
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "provisioned-gemini-key" },
              api: {
                type: "gemini-generate-content",
                baseUrl: GEMINI_BASE_URL,
                headers: { "X-Provisioned": "1" },
              },
              personalModelIds: ["gemini-2.5-pro"],
              modelOrder: ["gemini-2.5-pro"],
            },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      providerOrder: ["gemini-personal"],
    },
    accountSettings: { providerFamilyDomain: null, providerFamilyConnectionSelections: {} },
    credentials: [],
  };
}

test("Provisioning 应用 gemini 个人配置并按 syncId 幂等", async () => {
  await withTempDir("zcode-gemini-provisioning-", async (dir) => {
    const fixture = await createProvisioningFixture(dir);
    const first = await fixture.target.apply(geminiProvisioningEnvelope("sync-gemini-1"));
    assert.equal(first.status, "applied");
    assert.equal(first.personalProviderCount, 1);
    assert.equal(first.configRevision, "gemini-provisioning-rev");

    const applied = JSON.parse(await readFile(fixture.filePath, "utf8")) as {
      config: {
        providerConfigRules: {
          providerRules: Array<{ config?: { api?: { type?: string } } }>;
        };
      };
    };
    assert.equal(
      applied.config.providerConfigRules.providerRules[0]?.config?.api?.type,
      "gemini-generate-content",
    );

    // 本机后续编辑不能被同 syncId 的重复投递覆盖。
    await writeFile(fixture.filePath, JSON.stringify({ marker: "local-edit" }), "utf8");
    const replay = await fixture.target.apply(geminiProvisioningEnvelope("sync-gemini-1"));
    assert.equal(replay.status, "already-applied");
    assert.equal(await readFile(fixture.filePath, "utf8"), JSON.stringify({ marker: "local-edit" }));
  });
});

test("Provisioning 在并发编辑后跳过覆盖并报告 rollback_failed", async () => {
  await withTempDir("zcode-gemini-provisioning-cas-", async (dir) => {
    const fixture = await createProvisioningFixture(dir);
    // 初始已有配置，并发写入才会改变 CAS 版本。
    await fixture.target.apply(geminiProvisioningEnvelope("sync-gemini-seed"));
    fixture.armConcurrentEdit();
    const result = await fixture.target.apply(geminiProvisioningEnvelope("sync-gemini-conflict"));
    assert.equal(result.status, "rollback_failed");
    assert.equal(result.rolledBack, false);
    assert.match(result.errorMessage ?? "", /被其它操作修改/);

    const current = JSON.parse(await readFile(fixture.filePath, "utf8")) as {
      config: { providerConfigRules: { providerRules: Array<{ providerId?: string }> } };
    };
    assert.equal(
      current.config.providerConfigRules.providerRules[0]?.providerId,
      "concurrent-writer",
    );
  });
});

test("旧 config.json 的 @ai-sdk/google 与 endpoints.gemini 单向导入为 gemini-generate-content", async () => {
  await withTempDir("zcode-gemini-legacy-reader-", async (dir) => {
    setDataBaseDir(dir);
    try {
      const configDir = getAppConfigDir();
      await mkdir(configDir, { recursive: true });
      const legacyFile = join(configDir, "config.json");
      const legacySource = JSON.stringify({
        provider: {
          "gemini-via-npm": {
            name: "Gemini via npm",
            npm: "@ai-sdk/google",
            enabled: false,
            options: {
              baseURL: GEMINI_BASE_URL,
              apiKey: "legacy-npm-key",
              headers: { "X-Legacy": "1" },
            },
            models: {
              "gemini-2.5-flash": { limit: { context: 1048576 } },
            },
          },
          "gemini-via-endpoints": {
            name: "Legacy Gemini endpoint",
            endpoints: { gemini: "https://gateway.example.test/proxy/google/" },
            options: { apiKey: "legacy-endpoint-key" },
            models: { "gemini-2.5-pro": {} },
          },
          "anthropic-legacy": {
            name: "Anthropic legacy",
            npm: "@ai-sdk/anthropic",
            options: {
              baseURL: "https://api.example.test/anthropic",
              apiKey: "legacy-anthropic-key",
            },
            models: { "claude-legacy": {} },
          },
        },
      });
      await writeFile(legacyFile, legacySource, "utf8");

      const imported = importLegacyPersonalProviderConfig({
        legacyProviders: await readLegacyZCodeConfigProviders(),
      });
      // 单向导入只读旧文件，不能顺手把用户的 config.json 改写成新格式。
      assert.equal(await readFile(legacyFile, "utf8"), legacySource);

      const npmRule = imported.providers.getRule("gemini-via-npm");
      assert.ok(npmRule);
      assert.equal(npmRule.enabled, false);
      assert.equal(npmRule.providerName, "Gemini via npm");
      assert.equal(npmRule.config.api?.type, "gemini-generate-content");
      assert.equal(npmRule.config.api?.baseUrl, GEMINI_BASE_URL);
      assert.deepEqual(npmRule.config.api?.headers, { "X-Legacy": "1" });
      assert.equal(
        npmRule.config.access?.type === "api-key" ? npmRule.config.access.apiKey : undefined,
        "legacy-npm-key",
      );
      assert.deepEqual(npmRule.config.personalModelIds, ["gemini-2.5-flash"]);

      const endpointsRule = imported.providers.getRule("gemini-via-endpoints");
      assert.ok(endpointsRule);
      assert.equal(endpointsRule.config.api?.type, "gemini-generate-content");
      // 旧网关前缀保留，仅去掉尾部斜杠；/v1beta 由 factory 在请求期补。
      assert.equal(
        endpointsRule.config.api?.baseUrl,
        "https://gateway.example.test/proxy/google",
      );
      assert.equal(
        endpointsRule.config.access?.type === "api-key"
          ? endpointsRule.config.access.apiKey
          : undefined,
        "legacy-endpoint-key",
      );

      const anthropicRule = imported.providers.getRule("anthropic-legacy");
      assert.ok(anthropicRule);
      assert.equal(anthropicRule.config.api?.type, "anthropic-messages");
      assert.equal(anthropicRule.config.api?.baseUrl, "https://api.example.test/anthropic");
    } finally {
      setDataBaseDir(null);
    }
  });
});

test("v2 旧 store 的 endpoints.gemini 迁移为 Google kind 并保留模型成员", () => {
  const [parsed] = legacyModelProviderListSchema.parse([
    {
      id: "legacy-gemini-store",
      name: "Legacy Gemini store",
      enabled: false,
      endpoints: {
        anthropic: "",
        openai: "",
        gemini: "https://generativelanguage.googleapis.com/v1beta",
      },
      apiKey: "store-key",
      headers: { "X-Store": "1" },
      models: ["gemini-2.5-pro"],
      createdAt: 1,
      updatedAt: 2,
    },
  ]);
  assert.ok(parsed);
  const migrated = migrateLegacyModelProviderConfig(parsed);
  assert.equal(migrated.apiFormat, "gemini-generate-content");
  assert.equal(migrated.defaultKind, "google");
  assert.equal(migrated.apiKey, "store-key");
  assert.deepEqual(migrated.headers, { "X-Store": "1" });
  assert.deepEqual(
    migrated.models.map((model) => (typeof model === "string" ? model : model.id)),
    ["gemini-2.5-pro"],
  );

  const imported = importLegacyPersonalProviderConfig({ legacyProviders: [migrated] });
  const rule = imported.providers.getRule("legacy-gemini-store");
  assert.ok(rule);
  assert.equal(rule.enabled, false);
  assert.equal(rule.config.api?.type, "gemini-generate-content");
  assert.equal(rule.config.api?.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
  assert.deepEqual(rule.config.api?.headers, { "X-Store": "1" });
  assert.deepEqual(rule.config.personalModelIds, ["gemini-2.5-pro"]);
});

/** 旧 gemini 数据只做单向导入，不复活旧 store；这里也覆盖未知旧格式不被误标。 */
test("未声明 gemini/Google 的旧 OpenAI 兼容供应商仍导入为 chat 格式", () => {
  const imported = importLegacyPersonalProviderConfig({
    legacyProviders: [
      {
        id: "legacy-openai-compatible",
        name: "Legacy compat",
        endpoints: {
          baseURL: "https://compat.example.test/v1",
          paths: { "openai-compatible": "/chat/completions" },
        },
        apiKey: "compat-key",
        models: ["compat-model"],
        createdAt: 1,
        updatedAt: 2,
      },
    ],
  });
  const rule = imported.providers.getRule("legacy-openai-compatible");
  assert.ok(rule);
  assert.equal(rule.config.api?.type, "openai-chat-completions");
});

test("内置 gemini option map：兜底 maxOutputTokens 可执行且不沿用 Chat 字段", async () => {
  const rules = await loadBuiltinModelRules();
  const fallback = rules.resolve({
    providerId: "custom-gemini",
    modelId: "gemini-unverified-future",
    apiType: "gemini-generate-content",
  });
  const maps = compileResolvedOptionMaps(fallback);
  const applied = plainJson(
    maps.apply({}, { reasoningLevel: "enabled", maxOutputTokens: 4096 }),
  ) as Record<string, unknown>;
  assert.deepEqual(applied, { generationConfig: { maxOutputTokens: 4096 } });
  assert.equal(JSON.stringify(applied).includes("max_tokens"), false);
  assert.equal(JSON.stringify(applied).includes("reasoning_effort"), false);
  assert.equal(fallback.properties?.supportsNativeWebSearch, false);
  assert.equal(fallback.properties?.supportsMidConversationSystem, false);

  // 同一模型走 Chat 时仍使用 Chat 字段，证明按 apiType 分流。
  const chat = rules.resolve({
    providerId: "custom-gemini",
    modelId: "gemini-unverified-future",
    apiType: "openai-chat-completions",
  });
  const chatApplied = plainJson(
    compileResolvedOptionMaps(chat).apply(
      {},
      { reasoningLevel: "enabled", maxOutputTokens: 4096 },
    ),
  ) as Record<string, unknown>;
  assert.equal((chatApplied as { max_completion_tokens?: number }).max_completion_tokens, 4096);
  assert.equal("generationConfig" in chatApplied, false);
});

test("内置 gemini option map：2.5 用 thinkingBudget，3+/4 用 thinkingLevel", async () => {
  const rules = await loadBuiltinModelRules();
  const resolve = (modelId: string) =>
    rules.resolve({
      providerId: "custom-gemini",
      modelId,
      apiType: "gemini-generate-content",
    });

  const flash = resolve("gemini-2.5-flash");
  assert.deepEqual(flash.optionSpecs?.reasoningLevel?.values, [
    "disabled",
    "low",
    "medium",
    "high",
  ]);
  const flashMaps = compileResolvedOptionMaps(flash);
  assert.deepEqual(
    plainJson(flashMaps.apply({}, { reasoningLevel: "disabled", maxOutputTokens: 2048 })),
    { generationConfig: { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } } },
  );
  assert.deepEqual(
    plainJson(flashMaps.apply({}, { reasoningLevel: "medium", maxOutputTokens: 2048 })),
    {
      generationConfig: {
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 8192 },
      },
    },
  );

  const pro = resolve("gemini-2.5-pro");
  assert.deepEqual(pro.optionSpecs?.reasoningLevel?.values, ["low", "medium", "high"]);
  assert.deepEqual(
    plainJson(
      compileResolvedOptionMaps(pro).apply({}, { reasoningLevel: "high", maxOutputTokens: 1024 }),
    ),
    { generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingBudget: 32768 } } },
  );

  const neon = resolve("google/gemini-4-neon");
  assert.deepEqual(neon.optionSpecs?.reasoningLevel?.values, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(
    plainJson(
      compileResolvedOptionMaps(neon).apply({}, { reasoningLevel: "xhigh", maxOutputTokens: 1024 }),
    ),
    { generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "xhigh" } } },
  );

  const carbon = resolve("gemini-4-carbon");
  assert.deepEqual(carbon.optionSpecs?.reasoningLevel?.values, ["low", "medium", "high"]);

  // 已核对 3.x 网关型号只声明共同支持的 low/high，不虚构完整档位表。
  const threeFlash = resolve("google/gemini-3.7-flash");
  assert.deepEqual(threeFlash.optionSpecs?.reasoningLevel?.values, ["low", "high"]);
  assert.deepEqual(
    plainJson(
      compileResolvedOptionMaps(threeFlash).apply(
        {},
        { reasoningLevel: "low", maxOutputTokens: 1024 },
      ),
    ),
    { generationConfig: { maxOutputTokens: 1024, thinkingConfig: { thinkingLevel: "low" } } },
  );

  // 未核实型号不获得 thinking 字段，也不继承 2.5/3+/4 的档位。
  const unknown = resolve("gemini-unverified-future");
  assert.deepEqual(unknown.optionSpecs?.reasoningLevel?.values, ["disabled", "enabled"]);
  assert.deepEqual(
    plainJson(
      compileResolvedOptionMaps(unknown).apply(
        {},
        { reasoningLevel: "enabled", maxOutputTokens: 512 },
      ),
    ),
    { generationConfig: { maxOutputTokens: 512 } },
  );
});

test("内置 release 的 gemini 规则不影响既有 google/gemini 兼容网关规则", async () => {
  const rules = await loadBuiltinModelRules();
  // 兼容网关仍按各自的 apiType 解析；gemini 原生规则只命中 gemini-generate-content。
  const gatewayResponse = rules.resolve({
    providerId: "commandcode-responses",
    modelId: "google/gemini-4-argon",
    apiType: "openai-responses",
    baseUrl: "https://commandcode.example.test/v1",
  });
  assert.ok(gatewayResponse.optionSpecs?.maxOutputTokens?.map?.includes("max_output_tokens"));
  assert.equal(gatewayResponse.optionSpecs?.reasoningLevel?.map?.includes("thinkingConfig"), false);

  const gatewayChat = rules.resolve({
    providerId: "commandcode",
    modelId: "google/gemini-3.7-flash",
    apiType: "openai-chat-completions",
    baseUrl: "https://commandcode.example.test/v1",
  });
  assert.ok(gatewayChat.optionSpecs?.maxOutputTokens?.map?.includes("max_completion_tokens"));
  assert.equal(gatewayChat.optionSpecs?.reasoningLevel?.map?.includes("thinkingConfig"), false);

  // 同一模型在原生格式下才获得 Gemini 档位与 thinkingConfig。
  const native = rules.resolve({
    providerId: "gemini-native",
    modelId: "google/gemini-4-argon",
    apiType: "gemini-generate-content",
  });
  assert.deepEqual(native.optionSpecs?.reasoningLevel?.values, ["low", "medium", "high"]);
  assert.ok(native.optionSpecs?.reasoningLevel?.map?.includes("thinkingLevel"));
  assert.ok(native.optionSpecs?.maxOutputTokens?.map?.includes("generationConfig"));
});
