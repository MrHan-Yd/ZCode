import assert from "node:assert/strict";
import test from "node:test";
import {
  canPullGitBranch,
  readGitPullIssueCode,
  resolveGitActionMenuPrimaryAction,
  resolveGitPullErrorMessageId,
} from "../src/git-action-menu/display.js";

test("有上游分支的当前分支可以拉取", () => {
  assert.equal(
    canPullGitBranch({
      headRefType: "branch",
      branchName: "main",
      trackingBranchName: "origin/main",
    }),
    true,
  );
});

test("没有上游分支时不能拉取——无法确定拉取目标", () => {
  assert.equal(
    canPullGitBranch({ headRefType: "branch", branchName: "main", trackingBranchName: null }),
    false,
  );
  assert.equal(
    canPullGitBranch({ headRefType: "branch", branchName: "main", trackingBranchName: "  " }),
    false,
  );
});

test("游离 HEAD 或空分支名不能拉取", () => {
  assert.equal(
    canPullGitBranch({
      headRefType: "detached",
      branchName: "main",
      trackingBranchName: "origin/main",
    }),
    false,
  );
  assert.equal(
    canPullGitBranch({
      headRefType: "branch",
      branchName: null,
      trackingBranchName: "origin/main",
    }),
    false,
  );
});

test("behind 为 0 也允许拉取：本地快照可能过期，以 git pull 的结果为准", () => {
  // canPullGitBranch 刻意不接收 behind；这里断言它只看分支与上游。
  assert.equal(
    canPullGitBranch({
      headRefType: "branch",
      branchName: "main",
      trackingBranchName: "origin/main",
    }),
    true,
  );
});

test("主按钮：干净工作区 + 落后远端时选中拉取（本次修复的空洞）", () => {
  assert.equal(
    resolveGitActionMenuPrimaryAction({
      actionAvailable: true,
      commitEnabled: false,
      pushEnabled: false,
      pullEnabled: true,
    }),
    "pull",
  );
});

test("主按钮：有未提交改动时提交优先于拉取", () => {
  assert.equal(
    resolveGitActionMenuPrimaryAction({
      actionAvailable: true,
      commitEnabled: true,
      pushEnabled: false,
      pullEnabled: true,
    }),
    "commit",
  );
});

test("主按钮：有未推送提交时推送优先于拉取", () => {
  assert.equal(
    resolveGitActionMenuPrimaryAction({
      actionAvailable: true,
      commitEnabled: false,
      pushEnabled: true,
      pullEnabled: true,
    }),
    "push",
  );
});

test("主按钮：仓库不可用或无事可做时仍为 null", () => {
  assert.equal(
    resolveGitActionMenuPrimaryAction({
      actionAvailable: false,
      commitEnabled: false,
      pushEnabled: false,
      pullEnabled: true,
    }),
    null,
  );
  assert.equal(
    resolveGitActionMenuPrimaryAction({
      actionAvailable: true,
      commitEnabled: false,
      pushEnabled: false,
      pullEnabled: false,
    }),
    null,
  );
});

test("失败码到本地化文案 key 的映射覆盖所有预期内失败", () => {
  const expectedCodes = [
    "no-remote",
    "no-upstream",
    "detached-head",
    "dirty-working-tree",
    "merge-conflict",
    "diverged",
    "authentication-failed",
    "network-error",
    "timeout",
    "operation-in-progress",
  ] as const;

  const messageIds = expectedCodes.map((code) => resolveGitPullErrorMessageId(code));
  for (const messageId of messageIds) {
    assert.equal(typeof messageId, "string");
    assert.match(messageId!, /^git\.actionMenu\.pullDialog\.error\./);
  }
  // 每个 code 必须有独立文案，否则不同失败原因会显示同一句提示。
  assert.equal(new Set(messageIds).size, expectedCodes.length);
});

test("unknown 与缺失失败码没有本地化文案，由 UI 回落到原始 Git 输出", () => {
  assert.equal(resolveGitPullErrorMessageId("unknown"), null);
  assert.equal(resolveGitPullErrorMessageId(null), null);
});

test("从跨 RPC 传回的异常读取失败码", () => {
  assert.equal(
    readGitPullIssueCode(Object.assign(new Error("boom"), { code: "merge-conflict" })),
    "merge-conflict",
  );
  assert.equal(readGitPullIssueCode(new Error("boom")), null);
  assert.equal(
    readGitPullIssueCode(Object.assign(new Error("boom"), { code: "not-a-known-code" })),
    null,
  );
  assert.equal(readGitPullIssueCode(null), null);
  assert.equal(readGitPullIssueCode("merge-conflict"), null);
});
