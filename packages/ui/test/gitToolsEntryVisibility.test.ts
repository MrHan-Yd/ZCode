import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldShowGitRemoteSummary,
  shouldShowGitToolsEntry,
} from "../src/v4/gitToolsEntryVisibility.js";

const repo = { isGitAvailable: true, isRepository: true } as const;

function visibility(overrides: Partial<Parameters<typeof shouldShowGitToolsEntry>[0]> = {}) {
  return shouldShowGitToolsEntry({
    gitSummary: repo,
    dirtyFileCount: 0,
    added: 0,
    removed: 0,
    hasPushableCommits: false,
    behind: 0,
    ...overrides,
  });
}

test("干净且与上游同步：不显示（保留「不给 clean repo 挂空卡」的既有行为）", () => {
  assert.equal(visibility(), false);
});

test("提交之后工作区变干净、但还有未推送提交：仍然显示 ← 本次修复的核心场景", () => {
  assert.equal(visibility({ hasPushableCommits: true }), true);
});

test("分支尚无 upstream 时同样显示，与「推送」项的可用性保持一致", () => {
  // canPushGitBranch 对「有分支但无跟踪分支」返回 true，调用方会把结果传成 hasPushableCommits。
  assert.equal(visibility({ hasPushableCommits: true, behind: 0 }), true);
});

test("落后上游：显示（那同样是需要用户处理的状态）", () => {
  assert.equal(visibility({ behind: 3 }), true);
});

test("只有二进制改动（文件数 1、行级增减为 0）：显示，否则用户无法提交它", () => {
  assert.equal(visibility({ dirtyFileCount: 1, added: 0, removed: 0 }), true);
});

test("只有行级增减：显示", () => {
  assert.equal(visibility({ added: 4, removed: 0 }), true);
  assert.equal(visibility({ added: 0, removed: 2 }), true);
});

test("文件数与行级增减都为零、也没有待推送提交：不显示", () => {
  assert.equal(visibility({ dirtyFileCount: 0, added: 0, removed: 0, behind: 0 }), false);
});

test("非 Git 仓库或 Git 不可用：不显示", () => {
  assert.equal(
    visibility({
      gitSummary: { isGitAvailable: true, isRepository: false },
      hasPushableCommits: true,
    }),
    false,
  );
  assert.equal(
    visibility({
      gitSummary: { isGitAvailable: false, isRepository: true },
      hasPushableCommits: true,
    }),
    false,
  );
});

test("收起态胶囊：工作区无行级增减但有未推送提交时，显示「未推送提交」摘要", () => {
  // 窄屏 auto 形态只显示胶囊，胶囊必须可点，否则「推送」仍然无处可点。
  assert.equal(
    shouldShowGitRemoteSummary({
      added: 0,
      removed: 0,
      hasPushableCommits: true,
      behind: 0,
    }),
    true,
  );
});

test("收起态胶囊：有行级增减时由「+/- 更改」摘要表达，不重复显示远程摘要", () => {
  assert.equal(
    shouldShowGitRemoteSummary({
      added: 3,
      removed: 1,
      hasPushableCommits: true,
      behind: 2,
    }),
    false,
  );
});

test("收起态胶囊：只落后远端时也给出摘要", () => {
  assert.equal(
    shouldShowGitRemoteSummary({
      added: 0,
      removed: 0,
      hasPushableCommits: false,
      behind: 2,
    }),
    true,
  );
});

test("收起态胶囊：无改动、无远程待办时不显示摘要", () => {
  assert.equal(
    shouldShowGitRemoteSummary({
      added: 0,
      removed: 0,
      hasPushableCommits: false,
      behind: 0,
    }),
    false,
  );
});
