import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

const PREFIX = "chat.orchestration.";

function keysWithPrefix(locale: Record<string, string>, prefix: string): string[] {
  return Object.keys(locale)
    .filter((key) => key.startsWith(prefix))
    .sort();
}

test("orchestration composer keys exist in both locales", () => {
  const en = keysWithPrefix(enUS, PREFIX);
  const zh = keysWithPrefix(zhCN, PREFIX);
  assert.ok(en.length > 30);
  assert.deepEqual(zh, en);
  for (const key of en) {
    assert.ok(enUS[key]?.trim(), `missing en value for ${key}`);
    assert.ok(zhCN[key]?.trim(), `missing zh value for ${key}`);
  }
});

test("orchestration preset copy only exposes full stack and lean review", () => {
  for (const locale of [enUS, zhCN]) {
    assert.deepEqual(keysWithPrefix(locale, "chat.orchestration.preset."), [
      "chat.orchestration.preset.fullStack",
      "chat.orchestration.preset.fullStack.description",
      "chat.orchestration.preset.solo",
      "chat.orchestration.preset.solo.description",
    ]);
  }
  assert.match(zhCN["chat.orchestration.preset.solo.description"] ?? "", /审阅/u);
  assert.match(enUS["chat.orchestration.preset.solo.description"] ?? "", /review/u);
  assert.doesNotMatch(zhCN["chat.orchestration.preset.solo.description"] ?? "", /测试/u);
  assert.doesNotMatch(enUS["chat.orchestration.preset.solo.description"] ?? "", /tests/u);
});

test("orchestration placeholders stay aligned across locales", () => {
  const placeholders = (value: string) =>
    [...value.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
  for (const key of keysWithPrefix(enUS, PREFIX)) {
    assert.deepEqual(
      placeholders(zhCN[key] ?? ""),
      placeholders(enUS[key] ?? ""),
      `placeholder mismatch for ${key}`,
    );
  }
});
