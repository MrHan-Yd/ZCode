import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGitAutoRefreshWatchPaths,
  createGitAutoRefreshScheduler,
  shouldEnableGitAutoRefreshForWorkspace,
} from "../src/lib/gitAutoRefresh.js";
import { createGitRepositoryRefreshCoordinator } from "../src/lib/gitRepositoryRefresh.js";
import type { GitRefreshResult } from "@zcode/shared";

function snapshot(): GitRefreshResult {
  return {
    summary: {
      workspacePath: "/repo",
      repoRoot: "/repo",
      workspaceInRepoPath: ".",
      autoRefreshWatchPaths: [{ path: "/repo/.git", recursive: false }],
      branchName: "main",
      trackingBranchName: "origin/main",
      headRefType: "branch",
      ahead: 0,
      behind: 0,
      isDirty: true,
      isGitAvailable: true,
      isRepository: true,
    },
    identity: null,
    unstagedChanges: [],
    stagedChanges: [],
    branchComparison: null,
  };
}

test("单个文件事件在 350ms 静默后读取，最大等待 timer 不会再追加查询", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const refreshedPaths: string[] = [];
  const scheduler = createGitAutoRefreshScheduler((path) => refreshedPaths.push(path));
  try {
    scheduler.schedule("/repo/src");
    t.mock.timers.tick(349);
    assert.deepEqual(refreshedPaths, []);
    t.mock.timers.tick(1);
    assert.deepEqual(refreshedPaths, ["/repo/src"]);
    t.mock.timers.tick(2000);
    assert.equal(refreshedPaths.length, 1);
  } finally {
    scheduler.dispose();
  }
});

test("短批次只重置静默窗口，使用最后通知路径且只刷新一次", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const refreshedPaths: string[] = [];
  const scheduler = createGitAutoRefreshScheduler((path) => refreshedPaths.push(path));
  try {
    scheduler.schedule("/repo/a");
    t.mock.timers.tick(100);
    scheduler.schedule("/repo/b");
    t.mock.timers.tick(100);
    scheduler.schedule("/repo/c");
    t.mock.timers.tick(349);
    assert.deepEqual(refreshedPaths, []);
    t.mock.timers.tick(1);
    assert.deepEqual(refreshedPaths, ["/repo/c"]);
    t.mock.timers.tick(2000);
    assert.equal(refreshedPaths.length, 1);
  } finally {
    scheduler.dispose();
  }
});

test("每 100ms 持续通知仍在首次事件后 2000ms admission，后续事件不延长 maxWait", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const refreshedPaths: string[] = [];
  const scheduler = createGitAutoRefreshScheduler((path) => refreshedPaths.push(path));
  try {
    scheduler.schedule("/repo/0");
    for (let index = 1; index <= 19; index += 1) {
      t.mock.timers.tick(100);
      scheduler.schedule(`/repo/${index}`);
    }
    t.mock.timers.tick(99);
    assert.equal(refreshedPaths.length, 0);
    t.mock.timers.tick(1);
    assert.deepEqual(refreshedPaths, ["/repo/19"]);
    t.mock.timers.tick(350);
    assert.equal(refreshedPaths.length, 1);
  } finally {
    scheduler.dispose();
  }
});

test("最大等待触发后下一批从新的首次事件计时，旧 quiet timer 已取消", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let count = 0;
  const scheduler = createGitAutoRefreshScheduler(() => {
    count += 1;
  });
  try {
    scheduler.schedule("/repo");
    for (let index = 1; index <= 19; index += 1) {
      t.mock.timers.tick(100);
      scheduler.schedule("/repo");
    }
    t.mock.timers.tick(100);
    assert.equal(count, 1);
    scheduler.schedule("/repo/next");
    t.mock.timers.tick(349);
    assert.equal(count, 1);
    t.mock.timers.tick(1);
    assert.equal(count, 2);
    t.mock.timers.tick(2000);
    assert.equal(count, 2);
  } finally {
    scheduler.dispose();
  }
});

test("dispose 取消 quiet/maxWait 两个 timer，重复 dispose 或后续通知不再读取", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clearTimeoutMock = t.mock.method(globalThis, "clearTimeout");
  let count = 0;
  const scheduler = createGitAutoRefreshScheduler(() => {
    count += 1;
  });
  scheduler.schedule("/repo");
  scheduler.dispose();
  assert.equal(clearTimeoutMock.mock.calls.length, 2);
  scheduler.dispose();
  assert.equal(clearTimeoutMock.mock.calls.length, 2);
  scheduler.schedule("/repo/after-dispose");
  t.mock.timers.tick(10_000);
  assert.equal(count, 0);
});

test("静默触发后仍取消两个 timer，不残留最大等待回调", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const clearTimeoutMock = t.mock.method(globalThis, "clearTimeout");
  const scheduler = createGitAutoRefreshScheduler(() => {});
  try {
    scheduler.schedule("/repo");
    t.mock.timers.tick(350);
    assert.equal(clearTimeoutMock.mock.calls.length, 2);
    t.mock.timers.tick(10_000);
    assert.equal(clearTimeoutMock.mock.calls.length, 2);
  } finally {
    scheduler.dispose();
  }
});

test("连续事件按时 admission；RPC 仍未完成时 owner 保留一个 pending，不保证 2000ms 完成", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reads: Array<ReturnType<typeof Promise.withResolvers<GitRefreshResult>>> = [];
  const requests: Promise<GitRefreshResult>[] = [];
  const owner = createGitRepositoryRefreshCoordinator({
    workspacePath: "/repo",
    read: () => {
      const completion = Promise.withResolvers<GitRefreshResult>();
      reads.push(completion);
      return completion.promise;
    },
    publish: () => {},
  });
  const scheduler = createGitAutoRefreshScheduler(() => {
    requests.push(owner.refresh());
  });
  try {
    scheduler.schedule("/repo");
    for (let index = 1; index <= 59; index += 1) {
      t.mock.timers.tick(100);
      scheduler.schedule("/repo");
    }
    t.mock.timers.tick(100);
    assert.equal(requests.length, 3);
    assert.equal(reads.length, 1);
    assert.equal(requests[1], requests[2]);
    assert.notEqual(requests[0], requests[1]);

    reads[0]?.resolve(snapshot());
    await requests[0];
    assert.equal(reads.length, 2);
    reads[1]?.resolve(snapshot());
    await Promise.all(requests);
    assert.equal(reads.length, 2);
    t.mock.timers.tick(3000);
    assert.equal(requests.length, 3);
  } finally {
    scheduler.dispose();
    owner.dispose();
  }
});

test("相同路径不同 identity 不沿用旧 watcher，关闭状态不注册 watcher", () => {
  assert.equal(
    shouldEnableGitAutoRefreshForWorkspace({
      enabled: true,
      currentWorkspaceKey: "remote-a",
      summaryWorkspaceKey: "remote-b",
    }),
    false,
  );
  assert.equal(
    shouldEnableGitAutoRefreshForWorkspace({
      enabled: false,
      currentWorkspaceKey: "remote-a",
      summaryWorkspaceKey: "remote-a",
    }),
    false,
  );
  assert.equal(
    shouldEnableGitAutoRefreshForWorkspace({
      enabled: true,
      currentWorkspaceKey: "remote-a",
      summaryWorkspaceKey: "remote-a",
    }),
    true,
  );
});

test("Linux 保留 metadata-only 边界，Windows/macOS 继续递归监听工作区", () => {
  const summary = snapshot().summary;
  assert.deepEqual(buildGitAutoRefreshWatchPaths(summary, { platform: "linux" }), [
    { path: "/repo/.git", recursive: false },
  ]);
  assert.deepEqual(buildGitAutoRefreshWatchPaths(summary, null), [
    { path: "/repo/.git", recursive: false },
  ]);
  for (const platform of ["win32", "darwin"]) {
    assert.deepEqual(buildGitAutoRefreshWatchPaths(summary, { platform }), [
      { path: "/repo", recursive: true },
      { path: "/repo/.git", recursive: false },
    ]);
  }
});
