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
};

test("orchestration payload is omitted when the runtime does not support it", () => {
  const classic = createComposerSubmissionConfig(COMPOSER, VIEW, {
    orchestrationSupported: false,
  });
  assert.ok(classic);
  assert.equal(classic.orchestration, undefined);
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
  }
});

test("submission config never carries an orchestration input mode", () => {
  // 提交配置只描述本次执行（模式/模型/团队）；运行中的投递语义由 SessionPane 在
  // sendText 时按活动 run 决定，旧草稿里残留的字段也不能进入提交载荷。
  const legacyComposer = { ...COMPOSER, orchestrationInputMode: "interrupt" };
  const config = createComposerSubmissionConfig(legacyComposer, VIEW);
  assert.ok(config);
  assert.equal("orchestrationInput" in config, false);
});

test("disabled orchestration keeps the classic payload", () => {
  const config = createComposerSubmissionConfig({ ...COMPOSER, orchestrationEnabled: false }, VIEW);
  assert.ok(config);
  assert.equal(config.orchestration, undefined);
  assert.equal("orchestrationInput" in config, false);
});
