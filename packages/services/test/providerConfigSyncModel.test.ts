import assert from "node:assert/strict";
import test from "node:test";
import { parsePersonalModelConfigRules, parsePersonalProviderConfigMap } from "@zcode/provider";
import {
  mergePersonalModelRules,
  mergeProviderOrder,
  parseProviderItemContent,
  parseProviderSettings,
  providerFileName,
  providerItemContent,
  providerNameFromFileName,
  PROVIDER_CONFIG_PROFILE,
  PROVIDER_CONFIG_SETTINGS_FILE_NAME,
  restoreLocalApiKey,
  serializeProviderSettings,
  stripProviderApiKey,
} from "../src/model-provider/providerConfigSyncModel.js";

/** 手动规则要求全部可编辑叶子齐全；`optionSpecs.reasoningLevel.map` 也必填。 */
function manualModelConfig(enabled: boolean) {
  return {
    enabled,
    properties: {
      contextWindow: 200000,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: true,
      supportsMidConversationSystem: false,
      inputFormat: { supportsImage: false, supportsVideo: false, supportsPdf: false },
    },
    optionSpecs: {
      reasoningLevel: { values: ["low", "high"], map: '{"low": 1, "high": 2}' },
      maxOutputTokens: { max: 8192 },
    },
  };
}

function rule(
  providerId: string,
  config: Record<string, unknown>,
  meta: Record<string, unknown> = {},
) {
  const map = parsePersonalProviderConfigMap({ providerRules: [{ providerId, ...meta, config }] });
  const first = map.rules()[0];
  assert.ok(first, `构造规则失败：${providerId}`);
  return first;
}

function emptyModels() {
  return parsePersonalModelConfigRules({ providerModelRules: [], manualProviderModelRules: [] });
}

test("provider 文件名映射：危险字符转义且可还原，非条目文件不认", () => {
  assert.equal(providerFileName("provider-a"), "provider.provider-a.json");
  assert.equal(providerNameFromFileName("provider.provider-a.json"), "provider-a");

  // 内置/账号 Provider 的个人覆盖可能带 `:`，Windows 文件名不允许，必须转义。
  const accountId = "account:zhipu";
  assert.equal(providerFileName(accountId), "provider.account%3azhipu.json");
  assert.equal(providerNameFromFileName("provider.account%3azhipu.json"), accountId);

  const tricky = "a/b%c\u0001";
  assert.equal(providerFileName(tricky), "provider.a%2fb%25c%01.json");
  assert.equal(providerNameFromFileName(providerFileName(tricky) ?? ""), tricky);

  assert.equal(providerNameFromFileName("manifest.json"), null);
  assert.equal(providerNameFromFileName("provider.a%zz.json"), null);
  assert.equal(providerFileName(""), null);
});

test("剥离 API Key：只摘掉 apiKey，其余配置参数原样保留", () => {
  const stripped = stripProviderApiKey({
    group: "standard-personal",
    access: {
      type: "api-key",
      apiKey: "sk-secret",
      apiKeyManagementUrl: "https://example.com/key",
    },
    api: { type: "openai-chat-completions", baseUrl: "https://api.example.com" },
  });
  assert.deepEqual(stripped, {
    group: "standard-personal",
    access: { type: "api-key", apiKeyManagementUrl: "https://example.com/key" },
    api: { type: "openai-chat-completions", baseUrl: "https://api.example.com" },
  });

  // 账号型 access 本来就不带 Key，整体保留。
  const account = {
    access: { type: "zhipu-account", accountType: "zai", mode: "start-plan", entitled: true },
  };
  assert.deepEqual(stripProviderApiKey(account), account);
});

test("条目内容：往返一致、稳定，且永远不含 apiKey", () => {
  const content = providerItemContent(
    rule(
      "provider-a",
      {
        group: "standard-personal",
        access: { type: "api-key", apiKey: "sk-secret" },
        api: { type: "openai-chat-completions", baseUrl: "https://api.example.com" },
        personalModelIds: ["m1"],
      },
      { providerName: "Alpha", enabled: true },
    ),
  );
  assert.equal(content.includes("sk-secret"), false);
  assert.equal(content.includes("apiKey"), false);

  const parsed = parseProviderItemContent(content);
  assert.ok(parsed);
  assert.equal(parsed.providerId, "provider-a");
  assert.equal(parsed.providerName, "Alpha");
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.config.api?.baseUrl, "https://api.example.com");
  assert.deepEqual(parsed.config.personalModelIds, ["m1"]);
  // 往返后再次序列化必须完全一致（指纹与 diff 依赖这个稳定性）。
  assert.equal(providerItemContent(parsed), content);
});

test("内容校验：必须能被个人 Provider 规则 schema 加载", () => {
  const valid = providerItemContent(
    rule("provider-a", { api: { baseUrl: "https://api.example.com" } }),
  );
  assert.equal(PROVIDER_CONFIG_PROFILE.isValidContent("provider.provider-a.json", valid), true);
  assert.equal(
    PROVIDER_CONFIG_PROFILE.isValidContent("provider.provider-a.json", "不是 JSON"),
    false,
  );
  assert.equal(PROVIDER_CONFIG_PROFILE.isValidContent("provider.provider-a.json", "[]"), false);
  // providerId 缺失 / 配置字段非法都要拦下来。
  assert.equal(PROVIDER_CONFIG_PROFILE.isValidContent("provider.x.json", '{"config":{}}'), false);
  assert.equal(
    parseProviderItemContent('{"providerId":"a","config":{"api":{"type":"nope"}}}'),
    null,
  );
  assert.deepEqual(PROVIDER_CONFIG_PROFILE.extraFileNames, [PROVIDER_CONFIG_SETTINGS_FILE_NAME]);
});

test("settings 额外通道：往返一致，非法内容返回 null", () => {
  const content = serializeProviderSettings({
    providerOrder: ["b", "a"],
    models: emptyModels(),
    defaultModelSelection: { providerId: "a", modelId: "m1" },
  });
  const parsed = parseProviderSettings(content);
  assert.ok(parsed);
  assert.deepEqual(parsed.providerOrder, ["b", "a"]);
  assert.deepEqual(parsed.defaultModelSelection, { providerId: "a", modelId: "m1" });
  assert.deepEqual(parsed.modelConfigRules.rules(), []);

  assert.equal(parseProviderSettings(undefined), null);
  assert.equal(parseProviderSettings("{"), null);
  assert.equal(parseProviderSettings('{"providerOrder":["a"],"modelConfigRules":"nope"}'), null);
});

test("补回本机 API Key：类型一致才补，远端改类型或缺 Key 时保持远端结果", () => {
  const local = rule("provider-a", {
    group: "standard-personal",
    access: { type: "api-key", apiKey: "sk-local" },
  }).config;
  const remote = rule("provider-a", {
    group: "standard-personal",
    access: { type: "api-key", apiKeyManagementUrl: "https://example.com/key" },
  }).config;

  const restored = restoreLocalApiKey(remote, local);
  assert.equal(restored.access?.type, "api-key");
  assert.equal(
    restored.access && "apiKey" in restored.access ? restored.access.apiKey : undefined,
    "sk-local",
  );
  // 远端自己的非密钥字段不能被本机覆盖。
  assert.equal(
    restored.access && "apiKeyManagementUrl" in restored.access
      ? restored.access.apiKeyManagementUrl
      : undefined,
    "https://example.com/key",
  );

  const accountRemote = rule("provider-a", {
    group: "standard-personal",
    access: { type: "zhipu-account", accountType: "zai", mode: "start-plan", entitled: true },
  }).config;
  assert.equal(restoreLocalApiKey(accountRemote, local), accountRemote);
  // 本机没有同名 Provider（远端新增）时保持远端结果，Key 需要用户在新机器上重新填写。
  assert.equal(restoreLocalApiKey(remote, undefined), remote);
});

test("供应商顺序稳定合并：远端在前，本地独有项按本地顺序追加", () => {
  assert.deepEqual(mergeProviderOrder(["a", "b", "c"], ["c", "a"]), ["c", "a", "b"]);
  assert.deepEqual(mergeProviderOrder(["a"], []), ["a"]);
  assert.deepEqual(mergeProviderOrder([], ["x", "y"]), ["x", "y"]);
});

function modelRules(input: {
  providerModelRules?: readonly Record<string, unknown>[];
  manualProviderModelRules?: readonly Record<string, unknown>[];
}) {
  return parsePersonalModelConfigRules({
    providerModelRules: [...(input.providerModelRules ?? [])],
    manualProviderModelRules: [...(input.manualProviderModelRules ?? [])],
  });
}

test("个人模型规则合并：按 Provider/Model 覆盖、本机独有键保留，且幂等（不会重复追加远端规则）", () => {
  const local = modelRules({
    providerModelRules: [
      { providerId: "local-only", modelId: "x", config: { enabled: true } },
      { providerId: "p2", modelId: "m2", config: { enabled: true } },
    ],
  });
  const remote = modelRules({
    providerModelRules: [{ providerId: "p2", modelId: "m2", config: { enabled: false } }],
  });

  const merged = mergePersonalModelRules(local, remote);
  assert.deepEqual(
    merged.rules().map((entry) => [entry.providerId, entry.modelId]),
    [
      ["local-only", "x"],
      ["p2", "m2"],
    ],
  );
  // 远端同键胜出。
  assert.equal(merged.getExact("p2", "m2")?.toJSON().enabled, false);

  // 幂等：连续下载不会让规则数增长（旧实现用纯拼接，这里会 2 → 3 → 4 …）。
  const twice = mergePersonalModelRules(merged, remote);
  assert.equal(twice.rules().length, merged.rules().length);
  assert.deepEqual(twice.toPersonalJSON(), merged.toPersonalJSON());
});

test("个人模型规则合并：本机手动与远端智能同键时远端胜出，且结果仍满足个人规则 schema", () => {
  const local = modelRules({
    providerModelRules: [{ providerId: "p1", modelId: "m1", config: { enabled: true } }],
  });
  const remote = modelRules({
    manualProviderModelRules: [
      { providerId: "p1", modelId: "m1", config: manualModelConfig(true) },
    ],
  });

  const merged = mergePersonalModelRules(local, remote);
  // 同一 Provider/Model 只留一条，且是远端那一条（跨类型覆盖）。
  assert.deepEqual(
    merged.rules().map((entry) => [entry.type, entry.providerId, entry.modelId]),
    [["manual-provider-model", "p1", "m1"]],
  );
  // 旧实现会同时保留智能与手动两条同键规则，`toPersonalJSON` 会抛「不能同时声明智能和手动配置」。
  assert.doesNotThrow(() => merged.toPersonalJSON());
  assert.equal(merged.toPersonalJSON().providerModelRules.length, 0);
  assert.equal(merged.toPersonalJSON().manualProviderModelRules.length, 1);
});
