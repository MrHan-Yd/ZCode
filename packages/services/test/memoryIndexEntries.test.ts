import assert from "node:assert/strict";
import test from "node:test";
import { stripMemoryIndexEntries } from "../src/memory/index-entries.js";

const INDEX = [
  "# Memory Index",
  "",
  "- [User: Chinese-speaking Java dev](user-chinese-java-dev.md) — answers in Chinese",
  "- [Project: soft delete work](project-soft-delete.md) — Criteria API details",
  "- [Env: 空串当 NULL](env-empty-string-is-null.md) — coalesce 会过滤全表",
  "",
];

test("移除指向被删文件的索引行，其余内容逐字保留", () => {
  const result = stripMemoryIndexEntries(INDEX.join("\n"), "project-soft-delete.md");

  assert.equal(
    result,
    [
      "# Memory Index",
      "",
      "- [User: Chinese-speaking Java dev](user-chinese-java-dev.md) — answers in Chinese",
      "- [Env: 空串当 NULL](env-empty-string-is-null.md) — coalesce 会过滤全表",
      "",
    ].join("\n"),
  );
});

test("./ 前缀写法视为同一条目", () => {
  const content = "- [A](a.md) — one\n- [B](./b.md) — two\n";

  assert.equal(stripMemoryIndexEntries(content, "b.md"), "- [A](a.md) — one\n");
});

test("没有匹配行时原样返回（调用方据此跳过写盘）", () => {
  const content = "- [A](a.md) — one\n";

  assert.equal(stripMemoryIndexEntries(content, "missing.md"), content);
});

test("只认链接目标，标题文本里出现同名不误删", () => {
  const content = [
    "- [notes about a.md](other.md) — 标题里提到了 a.md",
    "- [real](a.md) — 真正的引用",
    "",
  ].join("\n");

  assert.equal(
    stripMemoryIndexEntries(content, "a.md"),
    "- [notes about a.md](other.md) — 标题里提到了 a.md\n",
  );
});

test("路径形式的链接目标不会被当成同名文件", () => {
  const content = "- [A](sub/a.md) — nested\n- [B](a.md) — root\n";

  assert.equal(stripMemoryIndexEntries(content, "a.md"), "- [A](sub/a.md) — nested\n");
});

test("非链接行（散文、标题、空行）不受影响", () => {
  const content = "a.md 是这行正文\n\n## a.md\n";

  assert.equal(stripMemoryIndexEntries(content, "a.md"), content);
});

test("删除唯一一条记忆后索引只剩骨架，不会留下空行堆积", () => {
  const content = "# Memory Index\n\n- [Only](only.md) — hook\n";

  assert.equal(stripMemoryIndexEntries(content, "only.md"), "# Memory Index\n\n");
});
