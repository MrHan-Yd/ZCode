import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderApiType } from "@zcode/provider";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import {
  resolvePendingProviderDraftSave,
  resolveProviderFormApiFormat,
  type ProviderDraftValues,
} from "@/settings/model-provider-section/ProviderDraftSave.js";
import {
  resolveProviderConnectionApiFormatDisplayLabel,
  resolveProviderConnectionApiFormatOptions,
} from "@/settings/model-provider-section/ProviderApiFormatSelect.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

const MESSAGES = { "zh-CN": zhCN, "en-US": enUS } as const;
type Locale = keyof typeof MESSAGES;

function intlFor(locale: Locale) {
  return {
    formatMessage: ({ id }: { id: string }): string => {
      const message = MESSAGES[locale][id];
      assert.ok(message, `missing ${locale} translation: ${id}`);
      return message;
    },
  };
}

function provider(
  overrides: Partial<ProviderSettingsFormProvider> = {},
): ProviderSettingsFormProvider {
  return {
    providerId: "fixture-gemini-provider",
    providerName: "Fixture Gemini",
    enabled: true,
    executable: true,
    hasPersonalConfig: false,
    personalConfig: {},
    config: {
      access: { type: "api-key", apiKey: "fixture-key" },
      api: {
        type: "anthropic-messages",
        baseUrl: "https://gateway.example.test/proxy/google",
        headers: { "x-fixture-header": "keep-me" },
      },
    },
    models: [],
    ...overrides,
  };
}

function draft(overrides: Partial<ProviderDraftValues> = {}): ProviderDraftValues {
  return {
    nameValue: "Fixture Gemini",
    apiFormat: "gemini-generate-content",
    baseUrlValue: "https://gateway.example.test/proxy/google",
    apiKeyValue: "fixture-key",
    ...overrides,
  };
}

test("API 格式选项包含原生 Gemini GenerateContent 且保留既有顺序", () => {
  assert.deepEqual(resolveProviderConnectionApiFormatOptions(), [
    "anthropic-messages",
    "openai-chat-completions",
    "openai-responses",
    "gemini-generate-content",
  ]);
});

test("格式显示标签按原生 generateContent 路径展示，中英文都可解析", () => {
  const expected: Record<Locale, Record<ProviderApiType, string>> = {
    "zh-CN": {
      "anthropic-messages": "Anthropic Messages (/v1/messages)",
      "openai-chat-completions": "Chat Completions (/chat/completions)",
      "openai-responses": "Responses (/responses)",
      "gemini-generate-content": "Gemini GenerateContent (/v1beta/models/{model}:generateContent)",
    },
    "en-US": {
      "anthropic-messages": "Anthropic messages (/v1/messages)",
      "openai-chat-completions": "Chat completions (/chat/completions)",
      "openai-responses": "Responses (/responses)",
      "gemini-generate-content": "Gemini GenerateContent (/v1beta/models/{model}:generateContent)",
    },
  };

  for (const locale of Object.keys(expected) as Locale[]) {
    const intl = intlFor(locale);
    for (const [format, label] of Object.entries(expected[locale]) as [ProviderApiType, string][]) {
      assert.equal(resolveProviderConnectionApiFormatDisplayLabel(intl, format), label);
    }
  }
});

test("选择 Gemini 只写入 api.type，保留用户 Base URL、Key 与 headers", () => {
  const base = provider();
  const saved = resolvePendingProviderDraftSave({
    provider: base,
    draft: draft(),
    now: () => 0,
  });
  assert.ok(saved);
  assert.equal(saved.config.api?.type, "gemini-generate-content");
  assert.equal(saved.config.api?.baseUrl, "https://gateway.example.test/proxy/google");
  assert.deepEqual(saved.config.api?.headers, { "x-fixture-header": "keep-me" });
  assert.equal(
    saved.config.access?.type === "api-key" ? saved.config.access.apiKey : null,
    "fixture-key",
  );

  // 个人覆盖保持稀疏：用户未改 URL/Key/headers，就不把它们写进个人配置。
  assert.equal(saved.personalConfig.api?.type, "gemini-generate-content");
  assert.equal(saved.personalConfig.api?.baseUrl, undefined);
  assert.equal(saved.personalConfig.access, undefined);
  // 表单从不重建整个 api，因此隐藏 headers 不会被删除。
  assert.equal(saved.config.api?.headers, base.config.api?.headers);
});

test("保存后重新读取保持 gemini-generate-content，不产生幽灵变更", () => {
  const saved = resolvePendingProviderDraftSave({
    provider: provider(),
    draft: draft(),
    now: () => 0,
  });
  assert.ok(saved);

  const reloaded = provider({
    hasPersonalConfig: true,
    personalConfig: saved.personalConfig,
    config: {
      ...saved.config,
      api: { ...saved.config.api, type: "gemini-generate-content" },
    },
  });
  assert.equal(resolveProviderFormApiFormat(reloaded), "gemini-generate-content");

  const afterReload = resolvePendingProviderDraftSave({
    provider: reloaded,
    draft: draft({ nameValue: "Fixture Gemini" }),
    now: () => 1,
  });
  assert.equal(afterReload, null, "重读后同值草稿不应再次提交");
});

test("已保存 Gemini 的 URL/Key 编辑不会被改回 Anthropic，也不会物化 type", () => {
  const geminiProvider = provider({
    hasPersonalConfig: true,
    // type 可以来自继承层；此时编辑 URL 不应把 type 物化进个人覆盖。
    personalConfig: {},
    config: {
      access: { type: "api-key", apiKey: "old-key" },
      api: {
        type: "gemini-generate-content",
        baseUrl: "https://old.example.test",
        headers: { "x-fixture-header": "keep-me" },
      },
    },
  });
  const saved = resolvePendingProviderDraftSave({
    provider: geminiProvider,
    draft: draft({ baseUrlValue: "https://new.example.test", apiKeyValue: "new-key" }),
    now: () => 0,
  });
  assert.ok(saved);
  assert.equal(saved.config.api?.type, "gemini-generate-content");
  assert.equal(saved.config.api?.baseUrl, "https://new.example.test");
  assert.equal(
    saved.config.api?.headers && saved.config.api.headers["x-fixture-header"],
    "keep-me",
  );
  assert.equal(saved.personalConfig.api?.type, undefined, "格式未变化时不重复写入 type");
  assert.equal(saved.personalConfig.api?.baseUrl, "https://new.example.test");
  assert.equal(saved.personalConfig.api?.headers, undefined, "未编辑 headers 不进入个人覆盖");
});

test("空配置表单选择 Gemini 时保存为新 api.type，不影响其它字段", () => {
  const empty = provider({
    config: {
      access: { type: "api-key", apiKey: "" },
      api: { baseUrl: "https://gateway.example.test/proxy/google" },
    },
  });
  assert.equal(resolveProviderFormApiFormat(empty), "anthropic-messages");
  const saved = resolvePendingProviderDraftSave({
    provider: empty,
    draft: draft({ apiKeyValue: "" }),
    now: () => 0,
  });
  assert.ok(saved);
  assert.equal(saved.config.api?.type, "gemini-generate-content");
  assert.equal(saved.config.api?.baseUrl, "https://gateway.example.test/proxy/google");
  assert.equal(saved.personalConfig.api?.type, "gemini-generate-content");
});
