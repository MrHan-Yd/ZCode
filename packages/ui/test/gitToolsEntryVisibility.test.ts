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
    canPull: false,
    ...overrides,
  });
}

test("干净 + 有上游：仍然显示 ← 落后远端在本地观测不到，不能判成「无事可做」", () => {
  // behind 只在 fetch/push/pull 之后才更新，而本应用没有后台 fetch：
  // 干净工作区 + 别人刚推送过 + 自己还没 fetch 时 behind 仍是 0。
  // 若把该状态隐藏，拉取入口恰恰在最需要它的场景下不可见。
  assert.equal(visibility({ canPull: true }), true);
});

test("提交之后工作区变干净、但还有未推送提交：仍然显示 ← v3.16.1 修复的场景", () => {
  assert.equal(visibility({ hasPushableCommits: true }), true);
});

test("分支尚无 upstream（可推送建立上游）时同样显示", () => {
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

test("干净、无上游、无未推送提交、无落后：三处都为空才不显示", () => {
  assert.equal(
    visibility({
      dirtyFileCount: 0,
      added: 0,
      removed: 0,
      hasPushableCommits: false,
      behind: 0,
      canPull: false,
    }),
    false,
  );
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
  // 有上游也不能让非仓库显示出来。
  assert.equal(
    visibility({
      gitSummary: { isGitAvailable: true, isRepository: false },
      canPull: true,
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
      canPull: true,
    }),
    true,
  );
});

test("收起态胶囊：干净且有上游时给出「已同步」摘要，否则窄屏下展开面板的入口会消失", () => {
  assert.equal(
    shouldShowGitRemoteSummary({
      added: 0,
      removed: 0,
      hasPushableCommits: false,
      behind: 0,
      canPull: true,
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
      canPull: true,
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
      canPull: true,
    }),
    true,
  );
});

test("收起态胶囊：无改动、无上游、无远程待办时不显示摘要", () => {
  assert.equal(
    shouldShowGitRemoteSummary({
      added: 0,
      removed: 0,
      hasPushableCommits: false,
      behind: 0,
      canPull: false,
    }),
    false,
  );
});
