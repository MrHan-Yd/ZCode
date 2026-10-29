import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ModelConfigRules } from "@zcode/provider";
import { decodeZCodeBuiltinRelease } from "@zcode/provider-node";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { setDataBaseDir } from "../src/paths.js";

const BUILTIN_PATH = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

/** 与构建期同一个校验入口：内容与 revision 不一致会在这里直接失败。 */
async function readBuiltinRules(): Promise<ModelConfigRules> {
  const release = decodeZCodeBuiltinRelease(JSON.parse(await readFile(BUILTIN_PATH, "utf8")));
  return release.config.modelConfigRules;
}

// 上游（models.dev 的 meta / opencode / opencode-go）公布的 Muse Spark 1.x 参数。
const MUSE_SPARK_CONTEXT = 1048576;
const MUSE_SPARK_MAX_OUTPUT = 131072;

test("内置规则给 muse-spark 1.x 全系变体提供 1M 上下文与 131k 输出", async () => {
  const rules = await readBuiltinRules();
  for (const modelId of [
    "muse-spark-1.3",
    "muse-spark-1.3-contributor",
    "muse-spark-1.3-contributor-free",
    "muse-spark-1.2-contributor-free",
    "muse-spark-1.1",
    // 网关前缀与供应商连字符写法。
    "meta/muse-spark-1.3",
    "muse-spark-1-2",
    // modelMatch 忽略大小写。
    "Muse-Spark-1.3",
  ]) {
    const resolved = rules.resolve({ providerId: "anything", modelId });
    assert.equal(resolved.properties?.contextWindow, MUSE_SPARK_CONTEXT, modelId);
    assert.equal(resolved.optionSpecs?.maxOutputTokens?.max, MUSE_SPARK_MAX_OUTPUT, modelId);
    assert.equal(resolved.properties?.inputFormat?.supportsImage, true, modelId);
    // 没写的字段继续继承兜底。
    assert.equal(resolved.properties?.supportsToolCall, true, modelId);
  }
});

test("家族规则不误伤同名前缀的其它模型", async () => {
  const rules = await readBuiltinRules();
  // gpt-5.3-codex-spark 有自己的规则，不该被家族规则改掉。
  assert.equal(
    rules.resolve({ providerId: "p", modelId: "gpt-5.3-codex-spark" }).properties?.contextWindow,
    400000,
  );
  // muse-glimmer 是另一家族，仍吃兜底。
  const glimmer = rules.resolve({ providerId: "p", modelId: "muse-glimmer-30b" });
  assert.equal(glimmer.properties?.contextWindow, 200000);
  assert.equal(glimmer.optionSpecs?.maxOutputTokens?.max, 32000);
});

test("个人精确规则仍然覆盖内置家族规则", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-builtin-muse-spark-"));
  setDataBaseDir(dir);
  try {
    const personalPath = join(dir, "provider_config.json");
    await writeFile(
      personalPath,
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: { providerRules: [] },
          modelConfigRules: {
            providerModelRules: [
              {
                providerId: "custom",
                modelId: "muse-spark-1.3-contributor",
                config: {
                  properties: { contextWindow: 1000000 },
                  optionSpecs: { maxOutputTokens: { max: 128000 } },
                },
              },
            ],
            manualProviderModelRules: [],
          },
        },
      }),
    );
    const runtime = createProviderConfigRuntime({
      zcodeBuiltinFilePath: BUILTIN_PATH,
      personalFilePath: personalPath,
      personalPollingIntervalMs: false,
      watch: false,
    });
    try {
      const snapshot = await runtime.configService.read();
      // 内置层自己就给出 1M。
      assert.equal(
        snapshot.zcodeBuiltinModelRules.resolve({
          providerId: "custom",
          modelId: "muse-spark-1.3-contributor",
        }).properties?.contextWindow,
        MUSE_SPARK_CONTEXT,
      );
      // 叠加个人层后由个人规则决定，内置家族规则不夺权。
      const effective = ModelConfigRules.composeEffective(
        snapshot.zcodeBuiltinModelRules,
        snapshot.personalModels,
      );
      const resolved = effective.resolve({
        providerId: "custom",
        modelId: "muse-spark-1.3-contributor",
      });
      assert.equal(resolved.properties?.contextWindow, 1000000);
      assert.equal(resolved.optionSpecs?.maxOutputTokens?.max, 128000);
    } finally {
      runtime.dispose();
    }
  } finally {
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
});

// 上游（models.dev，2026-10-20）公布的 Grok 4.7 / Claude 5.5 / GPT-6 参数。
test("内置规则覆盖 Grok 4.7，并在 OpenCode Go 放开 500k 输出上限", async () => {
  const rules = await readBuiltinRules();
  for (const modelId of ["grok-4.7", "x-ai/grok-4.7", "spacexai/grok-4.7"]) {
    const resolved = rules.resolve({ providerId: "p", modelId });
    assert.equal(resolved.properties?.contextWindow, 500000, modelId);
    assert.equal(resolved.optionSpecs?.maxOutputTokens?.max, 128000, modelId);
    assert.equal(resolved.properties?.inputFormat?.supportsImage, true, modelId);
    assert.deepEqual(
      resolved.optionSpecs?.reasoningLevel?.values,
      ["low", "medium", "high", "xhigh"],
      modelId,
    );
  }

  const openCodeGo = rules.resolve({
    providerId: "opencode-go",
    modelId: "grok-4.7",
    apiType: "openai-responses",
    baseUrl: "https://opencode.ai/zen/go/v1",
  });
  assert.equal(openCodeGo.optionSpecs?.maxOutputTokens?.max, 500000);
});

test("内置规则覆盖 GPT-6 变体，且不改写 Astra 的档位", async () => {
  const rules = await readBuiltinRules();
  for (const modelId of [
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-6.1-sol",
    "openai/gpt-6-sol",
    "openai/gpt-6-luna",
    "openai/gpt-6.1-sol",
  ]) {
    const resolved = rules.resolve({ providerId: "p", modelId });
    assert.equal(resolved.properties?.contextWindow, 1050000, modelId);
    assert.equal(resolved.optionSpecs?.maxOutputTokens?.max, 128000, modelId);
    assert.equal(resolved.properties?.inputFormat?.supportsPdf, true, modelId);
    assert.ok(
      resolved.optionSpecs?.reasoningLevel?.values?.includes("none"),
      `${modelId} 应支持 none 档`,
    );
  }

  const astra = rules.resolve({ providerId: "p", modelId: "gpt-6-astra" });
  assert.deepEqual(astra.optionSpecs?.reasoningLevel?.values, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

test("内置规则覆盖 Claude 5.5 家族", async () => {
  const rules = await readBuiltinRules();
  for (const modelId of [
    "claude-opus-5-5",
    "claude-sonnet-5-5",
    "anthropic/claude-opus-5.5",
    "anthropic/claude-sonnet-5.5",
  ]) {
    const resolved = rules.resolve({ providerId: "p", modelId });
    assert.equal(resolved.properties?.contextWindow, 1000000, modelId);
    assert.equal(resolved.optionSpecs?.maxOutputTokens?.max, 128000, modelId);
    assert.equal(resolved.properties?.inputFormat?.supportsPdf, true, modelId);
  }

  const haiku = rules.resolve({ providerId: "p", modelId: "claude-haiku-5-5" });
  assert.equal(haiku.properties?.contextWindow, 1000000);
  assert.equal(haiku.optionSpecs?.maxOutputTokens?.max, 128000);
  assert.ok(haiku.optionSpecs?.reasoningLevel?.values?.includes("disabled"));
  assert.ok(haiku.optionSpecs?.reasoningLevel?.values?.includes("enabled"));
});

test("新增模型在对应模板中默认启用", async () => {
  const rules = await readBuiltinRules();
  const cases = [
    ["xai", "grok-4.7"],
    ["anthropic", "claude-opus-5-5"],
    ["openai", "gpt-6-sol"],
    ["openrouter", "x-ai/grok-4.7"],
    ["openrouter", "anthropic/claude-opus-5.5"],
    ["opencode-zen-messages", "claude-haiku-5-5"],
    ["opencode-go-responses", "gpt-6-luna"],
  ] as const;
  for (const [templateId, modelId] of cases) {
    const resolved = rules.resolve({ providerId: "p", templateId, modelId });
    assert.equal(resolved.enabled, true, `${templateId}:${modelId}`);
  }
});

test("内置 release revision 随内容递增", async () => {
  const release = decodeZCodeBuiltinRelease(JSON.parse(await readFile(BUILTIN_PATH, "utf8")));
  assert.equal(release.revision, 35);
});

test("CommandCode / ClinePass / Ollama Cloud 模板声明内置 Logo key", async () => {
  const release = decodeZCodeBuiltinRelease(JSON.parse(await readFile(BUILTIN_PATH, "utf8")));
  const cases = [
    ["commandcode", "commandcode"],
    ["cline-pass", "cline"],
    ["ollama-cloud", "ollama"],
  ] as const;
  for (const [templateId, logoKey] of cases) {
    assert.deepEqual(release.config.providerTemplates.get(templateId)?.config.logo, {
      type: "builtin",
      key: logoKey,
    });
  }
});

test("CommandCode / ClinePass 模板内置完整模型清单并默认启用", async () => {
  const rules = await readBuiltinRules();
  const cases = [
    ["commandcode", "claude-opus-5-5"],
    ["commandcode", "gpt-6-sol"],
    ["commandcode", "xai/grok-4.7"],
    ["commandcode", "google/gemini-4-argon"],
    ["cline-pass", "cline-pass/glm-5.3-flash"],
    ["cline-pass", "cline-pass/mimo-v2.6-pro"],
    ["cline-pass", "cline-pass/kimi-k3"],
    ["ollama-cloud", "gpt-oss:120b"],
    ["ollama-cloud", "glm-5.3"],
    ["ollama-cloud", "mistral-large-4"],
  ] as const;
  for (const [templateId, modelId] of cases) {
    const resolved = rules.resolve({
      providerId: `template:${templateId}`,
      templateId,
      modelId,
      apiType: "openai-chat-completions",
    });
    assert.equal(resolved.enabled, true, `${templateId}:${modelId}`);
  }
});

test("内置规则补齐 MiMo 2.6 与 Muse Wonder", async () => {
  const rules = await readBuiltinRules();
  for (const modelId of ["mimo-v2.6-pro", "mimo-v2.6-flash", "cline-pass/mimo-v2.6-pro"]) {
    const resolved = rules.resolve({ providerId: "p", modelId });
    assert.equal(resolved.properties?.contextWindow, 1048576, modelId);
    assert.equal(resolved.optionSpecs?.maxOutputTokens?.max, 131072, modelId);
    assert.equal(resolved.properties?.inputFormat?.supportsImage, true, modelId);
  }
  const wonder = rules.resolve({ providerId: "p", modelId: "meta/muse-wonder-1.0" });
  assert.equal(wonder.properties?.contextWindow, 1048576);
  assert.equal(wonder.optionSpecs?.maxOutputTokens?.max, 131072);
  assert.equal(wonder.properties?.inputFormat?.supportsPdf, true);
});
