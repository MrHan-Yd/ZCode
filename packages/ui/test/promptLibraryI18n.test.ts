import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

// §8 列出的全部 key（实现额外增加的 key 允许存在，但两种语言必须保持一致）。
const SETTINGS_KEYS = [
  "title",
  "description",
  "searchPlaceholder",
  "sort.label",
  "sort.recentUsed",
  "sort.recentUpdated",
  "sort.name",
  "new",
  "edit",
  "backToList",
  "group.pinned",
  "group.all",
  "group.search",
  "empty.title",
  "empty.description",
  "searchEmpty",
  "loading",
  "loadFailed",
  "pin.add",
  "pin.remove",
  "row.lastUsed",
  "row.neverUsed",
  "row.aliasHint",
  "form.name.label",
  "form.name.validation.required",
  "form.name.validation.tooLong",
  "form.content.label",
  "form.content.placeholder",
  "form.content.helper",
  "form.content.sendHint",
  "form.content.validation.required",
  "form.content.validation.tooLong",
  "form.tags.label",
  "form.tags.placeholder",
  "form.tags.hint",
  "form.tags.remove",
  "form.alias.label",
  "form.alias.placeholder",
  "form.alias.hint",
  "form.alias.validation.characters",
  "form.alias.validation.duplicate",
  "form.unsaved.title",
  "form.unsaved.keepEditing",
  "form.unsaved.discard",
  "form.delete.title",
  "form.delete.description",
  "toast.created",
  "toast.saved",
  "toast.deleted",
  // §14.5 增量：列表删除与 GitHub 同步。
  "delete",
  "sync.uploaded",
  "sync.downloaded",
  "sync.uploadTitle",
  "sync.downloadTitle",
  "sync.restoreTitle",
  "sync.readOnlyDisabled",
  "sync.planItemName",
] as const;

const COMPOSER_KEYS = [
  "title",
  "section.pinned",
  "section.recent",
  "section.all",
  "section.results",
  "emptyLibrary",
  "emptyLibraryHint",
  "emptyResults",
  "loading",
  "error",
  "deletedWhileOpen",
  "insertedAnnouncement",
  "footer.trigger",
  "footer.navigate",
  "footer.insert",
  "footer.close",
] as const;

const SETTINGS_PREFIX = "settings.promptLibrary.";
const COMPOSER_PREFIX = "composer.promptLibrary.";

const zh = zhCN as Record<string, string>;
const en = enUS as Record<string, string>;

function keysWithPrefix(locale: Record<string, string>, prefix: string): string[] {
  return Object.keys(locale)
    .filter((key) => key.startsWith(prefix))
    .sort();
}

function assertLocaleValue(locale: Record<string, string>, key: string, label: string) {
  const value = locale[key];
  if (typeof value !== "string") {
    assert.fail(`${label} 缺少 key: ${key}`);
  }
  assert.ok(value.trim().length > 0, `${label} 的 ${key} 不能为空`);
}

test("settings.promptLibrary.* 在 zh-CN / en-US 中 key 集合完全一致", () => {
  assert.deepEqual(
    keysWithPrefix(zh, SETTINGS_PREFIX),
    keysWithPrefix(en, SETTINGS_PREFIX),
    "settings.promptLibrary.* 两种语言的 key 集合必须一致",
  );
});

test("composer.promptLibrary.* 在 zh-CN / en-US 中 key 集合完全一致", () => {
  assert.deepEqual(
    keysWithPrefix(zh, COMPOSER_PREFIX),
    keysWithPrefix(en, COMPOSER_PREFIX),
    "composer.promptLibrary.* 两种语言的 key 集合必须一致",
  );
});

test("§8 全部 settings.promptLibrary.* key 存在且非空", () => {
  for (const suffix of SETTINGS_KEYS) {
    const key = `${SETTINGS_PREFIX}${suffix}`;
    assertLocaleValue(zh, key, "zh-CN");
    assertLocaleValue(en, key, "en-US");
  }
});

test("§8 全部 composer.promptLibrary.* key 存在且非空", () => {
  for (const suffix of COMPOSER_KEYS) {
    const key = `${COMPOSER_PREFIX}${suffix}`;
    assertLocaleValue(zh, key, "zh-CN");
    assertLocaleValue(en, key, "en-US");
  }
});

test("§14.5 新增删除 / 同步文案存在且非空", () => {
  const incrementalKeys = [
    "settings.promptLibrary.delete",
    "settings.promptLibrary.sync.uploaded",
    "settings.promptLibrary.sync.downloaded",
    "settings.promptLibrary.sync.uploadTitle",
    "settings.promptLibrary.sync.downloadTitle",
    "settings.promptLibrary.sync.restoreTitle",
    "settings.promptLibrary.sync.readOnlyDisabled",
    "settings.promptLibrary.sync.planItemName",
  ];

  for (const key of incrementalKeys) {
    assertLocaleValue(zh, key, "zh-CN");
    assertLocaleValue(en, key, "en-US");
  }

  // 上传成功文案需要条数占位符。
  assert.match(zh["settings.promptLibrary.sync.uploaded"] ?? "", /\{count\}/);
  assert.match(en["settings.promptLibrary.sync.uploaded"] ?? "", /\{count\}/);
});

test("关键文案与 spec §8 对齐（title / empty / sendHint / composer footer）", () => {
  assert.equal(zh["settings.promptLibrary.title"], "提示词库");
  assert.equal(en["settings.promptLibrary.title"], "Prompt Library");
  assert.equal(zh["settings.promptLibrary.empty.title"], "还没有保存的提示词");
  assert.equal(en["settings.promptLibrary.empty.title"], "No saved prompts yet");
  assert.equal(zh["composer.promptLibrary.title"], "提示词库");
  assert.equal(en["composer.promptLibrary.title"], "Prompt Library");

  // 发送提示必须提醒 /、$、@ 可能被解析成命令或提及。
  assert.match(zh["settings.promptLibrary.form.content.sendHint"] ?? "", /[/$@]/);
  assert.match(zh["settings.promptLibrary.form.content.sendHint"] ?? "", /命令|提及/);
  assert.match(en["settings.promptLibrary.form.content.sendHint"] ?? "", /[/$@]/);
  assert.match(en["settings.promptLibrary.form.content.sendHint"] ?? "", /command|mention/i);

  // Composer footer 的四个操作提示都要有文案。
  for (const key of [
    "composer.promptLibrary.footer.trigger",
    "composer.promptLibrary.footer.navigate",
    "composer.promptLibrary.footer.insert",
    "composer.promptLibrary.footer.close",
  ]) {
    assertLocaleValue(zh, key, "zh-CN");
    assertLocaleValue(en, key, "en-US");
  }

  // 插入播报需要带名称占位符。
  assert.match(zh["composer.promptLibrary.insertedAnnouncement"] ?? "", /\{name\}/);
  assert.match(en["composer.promptLibrary.insertedAnnouncement"] ?? "", /\{name\}/);
});
