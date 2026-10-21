import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import type { PromptTemplateSummary } from "@zcode/shared";
import {
  filterPromptTemplates,
  normalizePromptLibrarySearchText,
  scorePromptTemplate,
} from "../src/lib/promptLibrarySearch.js";

function makeItem(
  id: string,
  overrides: Partial<PromptTemplateSummary> = {},
): PromptTemplateSummary {
  return {
    id,
    title: `Item ${id}`,
    tags: [],
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    contentPreview: `content ${id}`,
    ...overrides,
  };
}

function ids(items: readonly PromptTemplateSummary[]): string[] {
  return items.map((item) => item.id);
}

test("名称 / 内容 / 标签 / 别名都可匹配", () => {
  const byTitle = makeItem("title", { title: "Code review" });
  const byContent = makeItem("content", { contentPreview: "please review this diff" });
  const byTag = makeItem("tag", { tags: ["review"] });
  const byAlias = makeItem("alias", { alias: "review" });

  assert.notEqual(scorePromptTemplate(byTitle, "review"), null);
  assert.notEqual(scorePromptTemplate(byContent, "review"), null);
  assert.notEqual(scorePromptTemplate(byTag, "review"), null);
  assert.equal(scorePromptTemplate(byAlias, "review"), 0);
});

test("大小写不敏感", () => {
  const item = makeItem("case", { title: "Review Checklist", alias: "Review" });
  assert.notEqual(scorePromptTemplate(item, "REVIEW CHECK"), null);
  // 别名精确匹配不区分大小写。
  assert.equal(scorePromptTemplate(item, "rEvIeW"), 0);
});

test("NFKC 归一：全角输入与半角内容可互相匹配", () => {
  const item = makeItem("nfkc", { title: "ＲＥＶＩＥＷ 代码" });
  assert.notEqual(scorePromptTemplate(item, "review"), null);
  assert.notEqual(scorePromptTemplate(item, "ｒｅｖｉｅｗ"), null);
  // normalizePromptLibrarySearchText 直接验证归一化结果。
  assert.equal(normalizePromptLibrarySearchText("ＲＥＶＩＥＷ"), "review");
  // 全角标签同样可被半角 query 命中。
  const tagged = makeItem("nfkc-tag", { tags: ["ＲＥＶＩＥＷ"] });
  assert.notEqual(scorePromptTemplate(tagged, "review"), null);
});

test("相关性排序：别名精确 > 名称前缀 > 名称子串 > 标签 > 内容", () => {
  const aliasExact = makeItem("alias", { alias: "rev" });
  const titlePrefix = makeItem("prefix", {
    title: "Review checklist",
    contentPreview: "nothing relevant",
  });
  const titleSubstring = makeItem("substring", {
    title: "Code review guide",
    contentPreview: "nothing relevant",
  });
  const tagMatch = makeItem("tag", { title: "Alpha", tags: ["rev"] });
  const contentMatch = makeItem("content", { title: "Beta", contentPreview: "please rev this" });

  const items = [contentMatch, tagMatch, titleSubstring, titlePrefix, aliasExact];
  assert.deepEqual(ids(filterPromptTemplates(items, "rev")), [
    "alias",
    "prefix",
    "substring",
    "tag",
    "content",
  ]);
});

test("同分时置顶优先，再按最近使用时间", () => {
  // 两条标题长度一致，名称前缀得分相同。
  const unpinnedFresh = makeItem("fresh", {
    title: "Review one",
    pinned: false,
    lastUsedAt: 9_000,
  });
  const pinnedStale = makeItem("pinned", {
    title: "Review two",
    pinned: true,
    lastUsedAt: 1_000,
  });
  assert.deepEqual(ids(filterPromptTemplates([unpinnedFresh, pinnedStale], "Review")), [
    "pinned",
    "fresh",
  ]);

  // 三条标题长度一致，名称前缀得分相同，只剩置顶 / lastUsedAt 参与排序。
  const recent = makeItem("recent", { title: "Review one", lastUsedAt: 9_000 });
  const older = makeItem("older", { title: "Review two", lastUsedAt: 1_000 });
  const neverUsed = makeItem("never", { title: "Review xyz" });
  assert.deepEqual(ids(filterPromptTemplates([older, neverUsed, recent], "Review")), [
    "recent",
    "older",
    "never",
  ]);
});

test("不匹配的条目被过滤，空 query 返回全部并保持原顺序", () => {
  const a = makeItem("a", { title: "Alpha" });
  const b = makeItem("b", { title: "Beta" });
  const c = makeItem("c", { title: "Gamma" });
  const input = [a, b, c];

  assert.deepEqual(ids(filterPromptTemplates(input, "zzz")), []);
  const all = filterPromptTemplates(input, "   ");
  assert.deepEqual(ids(all), ["a", "b", "c"]);
  // 返回新数组，调用方排序不会污染入参。
  assert.notEqual(all, input);
});

test("搜索结果上限由面板层截断为 100 条（搜索函数本身不丢数据）", () => {
  const items = Array.from({ length: 120 }, (_, index) =>
    makeItem(`item-${index}`, { title: `Review ${index}` }),
  );
  assert.equal(filterPromptTemplates(items, "Review").length, 120);

  // PromptLibraryPlugin 依赖 React/Lexical，Node 下无法渲染；此处做源码级断言，
  // 确认面板对搜索结果的 100 条截断仍然存在。
  const pluginSource = readFileSync(
    new URL("../src/mentions/PromptLibraryPlugin.tsx", import.meta.url),
    "utf8",
  );
  assert.match(pluginSource, /const MAX_RESULTS = 100;/);
  assert.match(
    pluginSource,
    /filterPromptTemplates\(sortedItems, activeQuery\)\.slice\(0, MAX_RESULTS\)/,
  );
});
