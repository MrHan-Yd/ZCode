import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readLegacyCliPersonalProviderConfig } from "../src/app/legacy-cli-personal-provider-config-importer.js";

async function withLegacyConfig(
  content: unknown,
  run: (filePath: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-legacy-gemini-"));
  try {
    const filePath = join(directory, "config.json");
    await writeFile(filePath, JSON.stringify(content), "utf8");
    await run(filePath);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

for (const kind of ["gemini", "google"] as const) {
  test(`旧 CLI kind=${kind} 单向导入为 gemini-generate-content，并保留 key/headers/成员/enabled`, async () => {
    await withLegacyConfig(
      {
        model: "legacy-gemini/gemini-2.5-pro",
        provider: {
          "legacy-gemini": {
            kind,
            name: "Legacy Gemini",
            options: {
              apiKey: "legacy-key",
              baseURL: "https://generativelanguage.googleapis.com",
              headers: { "x-option-header": "option" },
            },
            headers: { "x-provider-header": "provider" },
            models: {
              "gemini-2.5-pro": {
                id: "gemini-2.5-pro",
                name: "Gemini 2.5 Pro",
                contextWindow: 1_048_576,
                enabled: true,
              },
              "gemini-2.5-flash": {
                id: "gemini-2.5-flash",
                contextWindow: 1_048_576,
                enabled: false,
              },
            },
          },
        },
      },
      async (filePath) => {
        const update = await readLegacyCliPersonalProviderConfig({ filePath });
        assert.ok(update);
        const provider = update.providers.get("legacy-gemini");
        assert.ok(provider);
        // 产品身份（providerId/name 归因）不因格式迁移改变。
        assert.equal(update.providers.rules()[0]?.providerId, "legacy-gemini");
        assert.equal(update.providers.rules()[0]?.providerName, "Legacy Gemini");
        assert.equal(provider.api?.type, "gemini-generate-content");
        assert.equal(provider.api?.baseUrl, "https://generativelanguage.googleapis.com");
        assert.deepEqual(provider.api?.headers, {
          "x-provider-header": "provider",
          "x-option-header": "option",
        });
        assert.equal(provider.access?.type, "api-key");
        assert.equal(
          provider.access?.type === "api-key" ? provider.access.apiKey : undefined,
          "legacy-key",
        );
        assert.deepEqual(provider.personalModelIds, ["gemini-2.5-pro", "gemini-2.5-flash"]);
        assert.deepEqual(update.defaultModelSelection, {
          providerId: "legacy-gemini",
          modelId: "gemini-2.5-pro",
        });

        const exactRules = update.models
          .rules()
          .filter((rule) => "providerId" in rule && rule.providerId === "legacy-gemini");
        const byModel = new Map(
          exactRules.map((rule) => ["modelId" in rule ? rule.modelId : "", rule.config]),
        );
        assert.equal(byModel.get("gemini-2.5-pro")?.enabled, true);
        assert.equal(byModel.get("gemini-2.5-flash")?.enabled, false);
        assert.equal(byModel.get("gemini-2.5-pro")?.properties?.contextWindow, 1_048_576);
      },
    );
  });
}
