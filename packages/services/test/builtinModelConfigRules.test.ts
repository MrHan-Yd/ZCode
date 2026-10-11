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
