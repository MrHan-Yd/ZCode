import assert from "node:assert/strict";
import test from "node:test";
import { gitCommitGraphQuerySchema } from "@zcode/shared";
import {
  buildGitGraphFilters,
  EMPTY_GIT_GRAPH_FILTER_DRAFT,
  gitGraphAuthorKey,
  readGitGraphAuthorKey,
  hasGitGraphFilters,
  validateGitGraphFilters,
} from "../src/git-graph/filters.js";

const now = 1_798_000_000_000;
test("默认筛选为空，字面空格与元字符原样保存，文本或哈希开关默认关闭", () => {
  assert.deepEqual(buildGitGraphFilters(EMPTY_GIT_GRAPH_FILTER_DRAFT, now), {});
  const filters = buildGitGraphFilters({ ...EMPTY_GIT_GRAPH_FILTER_DRAFT, text: " [fix].* " }, now);
  assert.deepEqual(filters.search, { value: " [fix].* ", mode: "literal", caseSensitive: false });
  assert.equal(validateGitGraphFilters(filters), null);
  assert.equal(hasGitGraphFilters(filters), true);
});

test("正则与大小写只作用于文本条件，作者按姓名邮箱完整身份", () => {
  const author = { name: "Synthetic", email: "synthetic@example.invalid" };
  const filters = buildGitGraphFilters(
    {
      ...EMPTY_GIT_GRAPH_FILTER_DRAFT,
      text: "fix|[a-f0-9]{8}",
      regex: true,
      caseSensitive: true,
      authorKey: gitGraphAuthorKey(author),
      branchRef: "refs/heads/feature/one",
    },
    now,
  );
  assert.deepEqual(filters.search, {
    value: "fix|[a-f0-9]{8}",
    mode: "regex",
    caseSensitive: true,
  });
  assert.deepEqual(filters.author, author);
  assert.equal(filters.branchRef, "refs/heads/feature/one");
  assert.equal(validateGitGraphFilters(filters), null);
});

test("作者候选消失后仍能由稳定key恢复完整身份标签，不误显全部", () => {
  const author = { name: "Synthetic", email: "synthetic@example.invalid" };
  assert.deepEqual(readGitGraphAuthorKey(gitGraphAuthorKey(author)), author);
  assert.deepEqual(readGitGraphAuthorKey(gitGraphAuthorKey({ name: "Empty", email: "" })), {
    name: "Empty",
    email: "",
  });
  assert.equal(readGitGraphAuthorKey(""), null);
  assert.equal(readGitGraphAuthorKey("invalid"), null);
});

test("过去24小时、7天、30天固定滚动时间边界，不生成日期输入或重置状态", () => {
  for (const [preset, days] of [
    ["24h", 1],
    ["7d", 7],
    ["30d", 30],
  ] as const) {
    const filters = buildGitGraphFilters(
      { ...EMPTY_GIT_GRAPH_FILTER_DRAFT, datePreset: preset },
      now,
    );
    assert.deepEqual(filters.date, { fromMs: now - days * 86_400_000, toMs: now });
  }
});

test("非法正则报错而不降级，元字符在字面模式合法", () => {
  assert.equal(validateGitGraphFilters({ search: { value: "[", mode: "regex" } }), "invalid-regex");
  assert.equal(validateGitGraphFilters({ search: { value: "[", mode: "literal" } }), null);
  assert.equal(validateGitGraphFilters({ date: { fromMs: now, toMs: now } }), "invalid-query");
});

test("查询schema拒绝NUL、未知筛选、非法revision与时间范围", () => {
  const query = { workspacePath: "/synthetic/git", filters: {} };
  assert.equal(gitCommitGraphQuerySchema.safeParse(query).success, true);
  for (const filters of [
    { search: { value: "bad\0text", mode: "literal" } },
    { branchRef: "--all" },
    { branchRef: "HEAD~1" },
    { date: { fromMs: now, toMs: now - 1 } },
    { reset: true },
  ]) {
    assert.equal(gitCommitGraphQuerySchema.safeParse({ ...query, filters }).success, false);
  }
});
