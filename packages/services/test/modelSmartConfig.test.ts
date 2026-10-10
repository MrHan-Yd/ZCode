import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseModelSmartConfigRules } from "@zcode/provider";
import { createProviderConfigRuntime } from "../src/model-provider/providerConfigRuntime.js";
import { createModelSmartConfigService } from "../src/model-provider/modelSmartConfigService.js";
import { setDataBaseDir } from "../src/paths.js";

const BUILTIN_PATH = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  setDataBaseDir(dir);
  try {
    return await run(dir);
  } finally {
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
}

test("扁平条目映射为正则/精确规则并保留稀疏参数", () => {
  const rules = parseModelSmartConfigRules({
    schemaVersion: 1,
    models: [
      { modelMatch: "gpt-7.*", contextWindow: 400000, supportsImage: true },
      { providerId: "deepseek", modelId: "deepseek-v5", maxOutputTokens: 64000 },
    ],
  });

  const byRegex = rules.resolve({ providerId: "openai", modelId: "gpt-7-preview" });
  assert.equal(byRegex.properties?.contextWindow, 400000);
  assert.equal(byRegex.properties?.inputFormat?.supportsImage, true);
  // 未写字段保持稀疏，不覆盖内置默认（这里没有其它来源，所以是 undefined）。
  assert.equal(byRegex.optionSpecs?.maxOutputTokens?.max, undefined);

  const byExact = rules.resolve({ providerId: "deepseek", modelId: "deepseek-v5" });
  assert.equal(byExact.optionSpecs?.maxOutputTokens?.max, 64000);
  // 精确规则不匹配其它 provider。
  assert.equal(
    rules.resolve({ providerId: "openai", modelId: "deepseek-v5" }).optionSpecs?.maxOutputTokens
      ?.max,
    undefined,
  );
});

test("条目必须且只能提供 modelMatch 或 providerId+modelId", () => {
  assert.throws(() =>
    parseModelSmartConfigRules({
      schemaVersion: 1,
      models: [{ contextWindow: 1000 }],
    }),
  );
  assert.throws(() =>
    parseModelSmartConfigRules({
      schemaVersion: 1,
      models: [{ modelMatch: "x", providerId: "p", modelId: "m" }],
    }),
  );
  assert.throws(() =>
    parseModelSmartConfigRules({
      schemaVersion: 1,
      models: [{ providerId: "p" }],
    }),
  );
  assert.throws(() =>
    parseModelSmartConfigRules({
      schemaVersion: 1,
      models: [{ modelMatch: "[" }],
    }),
  );
});

test("扁平条目支持 templateId 与推理映射，且按模板精确命中", () => {
  const rules = parseModelSmartConfigRules({
    schemaVersion: 1,
    models: [
      {
        templateId: "anthropic",
        modelId: "claude-sonnet-5",
        contextWindow: 1000000,
        reasoningLevels: ["low", "high"],
        reasoningLevelMap: "{}",
        supportsImage: true,
        supportsPdf: true,
        supportsJsonSchemaOutput: true,
      },
    ],
  });
  const hit = rules.resolve({
    providerId: "anything",
    templateId: "anthropic",
    modelId: "claude-sonnet-5",
  });
  assert.equal(hit.properties?.contextWindow, 1000000);
  assert.equal(hit.properties?.inputFormat?.supportsImage, true);
  assert.equal(hit.properties?.supportsJsonSchemaOutput, true);
  assert.deepEqual(hit.optionSpecs?.reasoningLevel?.values, ["low", "high"]);
  assert.equal(hit.optionSpecs?.reasoningLevel?.map, "{}");
  // 模板精确规则不影响其它模板的同名模型。
  assert.equal(
    rules.resolve({ providerId: "anything", templateId: "openai", modelId: "claude-sonnet-5" })
      .properties?.contextWindow,
    undefined,
  );
});

test("原样镜像通道生效，且扁平 models 覆盖镜像同模型", () => {
  const rules = parseModelSmartConfigRules({
    schemaVersion: 1,
    models: [{ providerId: "openai", modelId: "gpt-9", contextWindow: 111 }],
    modelConfigRules: {
      builtinProviderModelRules: [
        { providerId: "openai", modelId: "gpt-9", config: { properties: { contextWindow: 222 } } },
        { providerId: "openai", modelId: "gpt-8", config: { properties: { contextWindow: 333 } } },
      ],
    },
  });
  // 镜像提供 gpt-8。
  assert.equal(
    rules.resolve({ providerId: "openai", modelId: "gpt-8" }).properties?.contextWindow,
    333,
  );
  // 扁平规则覆盖镜像中的同名模型。
  assert.equal(
    rules.resolve({ providerId: "openai", modelId: "gpt-9" }).properties?.contextWindow,
    111,
  );
});

test("runtime 把本地同步规则叠加在内置规则之上，新增模型能自动填入参数", async () => {
  await withTempDir("zcode-model-smart-config-", async (dir) => {
    const smartPath = join(dir, "model-smart-config.json");
    await writeFile(
      smartPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        models: [
          {
            providerId: "openai",
            modelId: "gpt-7-preview",
            contextWindow: 400000,
            maxOutputTokens: 128000,
            reasoningLevels: ["low", "high"],
          },
        ],
      }),
    );
    const runtime = createProviderConfigRuntime({
      zcodeBuiltinFilePath: BUILTIN_PATH,
      personalFilePath: join(dir, "provider_config.json"),
      modelSmartConfigFilePath: smartPath,
      personalPollingIntervalMs: false,
      watch: false,
    });
    try {
      const snapshot = await runtime.configService.read();
      const resolved = snapshot.zcodeBuiltinModelRules.resolve({
        providerId: "openai",
        modelId: "gpt-7-preview",
      });
      assert.equal(resolved.properties?.contextWindow, 400000);
      assert.equal(resolved.optionSpecs?.maxOutputTokens?.max, 128000);
      assert.deepEqual(resolved.optionSpecs?.reasoningLevel?.values, ["low", "high"]);

      // 内置 `.*` 兜底仍然生效在未覆盖的字段上（例如 supportsToolCall 来自内置默认）。
      assert.equal(resolved.properties?.supportsToolCall, true);

      // 内容变化必须改变 revision，否则 Registry 会短路不刷新。
      const firstRevision = snapshot.revision;
      await writeFile(
        smartPath,
        JSON.stringify({
          schemaVersion: 1,
          revision: 2,
          models: [{ providerId: "openai", modelId: "gpt-7-preview", contextWindow: 999 }],
        }),
      );
      const next = await runtime.configService.read();
      assert.notEqual(next.revision, firstRevision);
      assert.equal(
        next.zcodeBuiltinModelRules.resolve({ providerId: "openai", modelId: "gpt-7-preview" })
          .properties?.contextWindow,
        999,
      );
    } finally {
      runtime.dispose();
    }
  });
});

test("本地文件缺失或损坏时智能配置为空且不阻断", async () => {
  await withTempDir("zcode-model-smart-config-broken-", async (dir) => {
    const smartPath = join(dir, "model-smart-config.json");
    await writeFile(smartPath, "{ not json");
    const runtime = createProviderConfigRuntime({
      zcodeBuiltinFilePath: BUILTIN_PATH,
      personalFilePath: join(dir, "provider_config.json"),
      modelSmartConfigFilePath: smartPath,
      personalPollingIntervalMs: false,
      watch: false,
    });
    try {
      const snapshot = await runtime.configService.read();
      const resolved = snapshot.zcodeBuiltinModelRules.resolve({
        providerId: "openai",
        modelId: "gpt-7-preview",
      });
      // 损坏文件等于「没有同步规则」，内置兜底参数仍然可用。
      assert.equal(resolved.properties?.contextWindow, 200000);
    } finally {
      runtime.dispose();
    }
  });
});

function routingFetch(responses: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    if (!(url in responses)) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(responses[url]), { status: 200 });
  }) as typeof fetch;
}

test("同步服务：按清单拉取厂商分片并合并落盘", async () => {
  await withTempDir("zcode-model-smart-sync-", async (dir) => {
    const smartPath = join(dir, "model-smart-config.json");
    const indexUrl = "https://example.test/raw/index.json";
    const service = createModelSmartConfigService({
      filePath: smartPath,
      indexUrl,
      fetchImpl: routingFetch({
        [indexUrl]: { schemaVersion: 1, revision: 7, files: ["openai.json", "deepseek.json"] },
        "https://example.test/raw/openai.json": {
          schemaVersion: 1,
          models: [{ modelMatch: "gpt-8.*", contextWindow: 500000 }],
        },
        "https://example.test/raw/deepseek.json": {
          schemaVersion: 1,
          modelConfigRules: {
            builtinProviderModelRules: [
              { providerId: "deepseek", modelId: "v5", config: { properties: { contextWindow: 256000 } } },
            ],
          },
        },
      }),
    });

    const before = await service.read();
    assert.equal(before.present, false);

    const after = await service.syncFromRemote();
    assert.equal(after.present, true);
    assert.equal(after.error, null);
    assert.equal(after.entries.length, 1);
    assert.equal(after.entries[0]?.modelMatch, "gpt-8.*");

    // 分片合并成单份本地文件：扁平 models 与镜像规则都在。
    const persisted = JSON.parse(await readFile(smartPath, "utf8"));
    assert.equal(persisted.models.length, 1);
    assert.equal(persisted.modelConfigRules.builtinProviderModelRules.length, 1);
    assert.equal(persisted.modelConfigRules.builtinProviderModelRules[0].providerId, "deepseek");
  });
});

test("同步服务：任一分片失败时保留本地文件不变", async () => {
  await withTempDir("zcode-model-smart-sync-invalid-", async (dir) => {
    const smartPath = join(dir, "model-smart-config.json");
    const localContent = '{\n  "schemaVersion": 1,\n  "models": []\n}\n';
    await writeFile(smartPath, localContent);
    const indexUrl = "https://example.test/raw/index.json";
    const service = createModelSmartConfigService({
      filePath: smartPath,
      indexUrl,
      fetchImpl: routingFetch({
        [indexUrl]: { schemaVersion: 1, files: ["openai.json"] },
        // openai.json 返回非法 JSON。
        "https://example.test/raw/openai.json": "{ not json",
      }),
    });

    await assert.rejects(service.syncFromRemote(), /远端同步失败/);
    assert.equal(await readFile(smartPath, "utf8"), localContent);
  });
});

test("同步服务：清单中的分片缺失时报错并保留本地文件", async () => {
  await withTempDir("zcode-model-smart-sync-missing-", async (dir) => {
    const smartPath = join(dir, "model-smart-config.json");
    const localContent = '{\n  "schemaVersion": 1,\n  "models": []\n}\n';
    await writeFile(smartPath, localContent);
    const indexUrl = "https://example.test/raw/index.json";
    const service = createModelSmartConfigService({
      filePath: smartPath,
      indexUrl,
      fetchImpl: routingFetch({
        [indexUrl]: { schemaVersion: 1, files: ["missing.json"] },
      }),
    });

    await assert.rejects(service.syncFromRemote(), /HTTP 404/);
    assert.equal(await readFile(smartPath, "utf8"), localContent);
  });
});
