import assert from "node:assert/strict";
import test from "node:test";
import type { GitRepositorySummary } from "@zcode/shared";
import { buildGitToolsModel, resolveGitToolsBadge } from "../src/v4/gitToolsModel.js";

/**
 * 只填与 Git 工具相关的字段；其余字段是 GitRepositorySummary 的结构占位，
 * 让测试可以精确控制「可见性 / 徽标优先级」的输入。
 */
function repo(overrides: Partial<GitRepositorySummary> = {}): GitRepositorySummary {
  return {
    workspacePath: "/repo",
    repoRoot: "/repo",
    workspaceInRepoPath: "",
    autoRefreshWatchPaths: [],
    branchName: "main",
    trackingBranchName: "origin/main",
    headRefType: "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: true,
    isRepository: true,
    ...overrides,
  };
}

function build(
  overrides: Parameters<typeof buildGitToolsModel>[0] = {},
): ReturnType<typeof buildGitToolsModel> {
  return buildGitToolsModel({ gitSummary: repo(), ...overrides });
}

test("Office 模式不产出 Git 工具模型（入口与浮层同时消失）", () => {
  assert.equal(build({ isOfficeMode: true }), null);
});

test("非 Git 仓库或 Git 不可用：模型为 null", () => {
  assert.equal(build({ gitSummary: repo({ isRepository: false }) }), null);
  assert.equal(build({ gitSummary: repo({ isGitAvailable: false }) }), null);
  assert.equal(resolveGitToolsBadge(null), null);
});

test("游离 HEAD 且干净：保留图谱入口但不伪造徽标", () => {
  const model = build({
    gitSummary: repo({ headRefType: "detached", branchName: null, trackingBranchName: null }),
  });
  assert.ok(model);
  assert.equal(resolveGitToolsBadge(model), null);
});

test("干净、有上游、ahead/behind 均为 0：可见且徽标为「已同步」且无计数", () => {
  const model = build();
  assert.ok(model);
  assert.equal(model.dirtyFileCount, 0);
  assert.equal(model.hasPushableCommits, false);
  assert.equal(model.canPull, true);
  assert.deepEqual(resolveGitToolsBadge(model), { kind: "synced", count: null });
});

test("有文件改动、行级增减为 0（二进制/未跟踪）：徽标按文件数计数，不落到已同步", () => {
  const model = build({
    gitDirtyFileCount: 1,
    gitWorktreeChangeSummary: { added: 0, removed: 0 },
  });
  assert.ok(model);
  assert.deepEqual(resolveGitToolsBadge(model), { kind: "changes", count: 1 });
});

test("行级增减非零：徽标为「更改」并优先于远程摘要", () => {
  const model = build({
    gitSummary: repo({ ahead: 3, behind: 2 }),
    gitDirtyFileCount: 2,
    gitWorktreeChangeSummary: { added: 4, removed: 1 },
  });
  assert.ok(model);
  assert.deepEqual(resolveGitToolsBadge(model), { kind: "changes", count: 2 });
});

test("干净且 ahead > 0：徽标为「未推送提交」并带 ahead 计数", () => {
  const model = build({ gitSummary: repo({ ahead: 2 }) });
  assert.ok(model);
  assert.equal(model.hasPushableCommits, true);
  assert.deepEqual(resolveGitToolsBadge(model), { kind: "pushable", count: 2 });
});

test("分支尚无 upstream：可见且徽标为「未推送提交」，ahead 为 0 时计数保留 0", () => {
  const model = build({ gitSummary: repo({ trackingBranchName: null, ahead: 0 }) });
  assert.ok(model);
  assert.equal(model.hasPushableCommits, true);
  assert.equal(model.canPull, false);
  assert.deepEqual(resolveGitToolsBadge(model), { kind: "pushable", count: 0 });
});

test("干净且 behind > 0：徽标为「落后远端」并带 behind 计数", () => {
  const model = build({ gitSummary: repo({ behind: 5 }) });
  assert.ok(model);
  assert.deepEqual(resolveGitToolsBadge(model), { kind: "behind", count: 5 });
});

test("优先顺序 changes → pushable → behind：ahead 与 behind 同时存在时选未推送提交", () => {
  const model = build({ gitSummary: repo({ ahead: 1, behind: 5 }) });
  assert.ok(model);
  assert.deepEqual(resolveGitToolsBadge(model), { kind: "pushable", count: 1 });
});
