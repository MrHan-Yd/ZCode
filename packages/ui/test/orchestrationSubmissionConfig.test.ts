import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionView } from "@zcode/services";
import { createComposerSubmissionConfig } from "../src/v4/composer/composerSubmissionConfig.js";

const SELECTION = {
  providerId: "fixture-provider",
  modelId: "fixture-model",
  options: { reasoningLevel: "high" },
} as const;

const VIEW = {
  revision: 1,
  providers: [
    {
      providerId: "fixture-provider",
      providerName: "Fixture",
      templateId: "fixture-template",
      config: {},
      models: [
        {
          modelId: "fixture-model",
          config: { optionSpecs: { reasoningLevel: { values: ["high"] } } },
        },
      ],
    },
  ],
} as unknown as ModelSelectionView;

const COMPOSER = {
  mode: "build",
  modelSelection: SELECTION,
  orchestrationEnabled: true,
  subagentPool: ["general-purpose", "tester"],
  orchestrationInputMode: "queue" as const,
};

test("orchestration payload is omitted when the runtime does not support it", () => {
  const classic = createComposerSubmissionConfig(COMPOSER, VIEW, {
    orchestrationSupported: false,
  });
  assert.ok(classic);
  assert.equal(classic.orchestration, undefined);
  assert.equal(classic.orchestrationInput, undefined);
  // 经典字段不受编排能力影响。
  assert.equal(classic.mode, "build");
  assert.deepEqual(classic.modelSelection, SELECTION);
});

test("orchestration payload is kept for supported runtimes and by default", () => {
  for (const options of [{ orchestrationSupported: true }, undefined]) {
    const config = createComposerSubmissionConfig(COMPOSER, VIEW, options);
    assert.ok(config);
    assert.deepEqual(config.orchestration, {
      enabled: true,
      team: ["general-purpose", "Explore", "tester"],
    });
    assert.equal(config.orchestrationInput, "queue");
  }
});

test("disabled orchestration keeps classic payload with input semantics", () => {
  const config = createComposerSubmissionConfig({ ...COMPOSER, orchestrationEnabled: false }, VIEW);
  assert.ok(config);
  assert.equal(config.orchestration, undefined);
  // 运行中插入语义只在活动 run 存在时由 Core 消费；能力支持的端仍可携带。
  assert.equal(config.orchestrationInput, "queue");
});
