import assert from "node:assert/strict";
import test from "node:test";
import type { GitFileChange, GitRefreshRequest, GitRefreshResult } from "@zcode/shared";
import {
  createGitRepositoryRefreshCoordinator,
  GitRepositoryRefreshInvalidatedError,
  isGitRefreshTimeoutError,
  shouldKeepGitRepositorySnapshot,
  type GitRepositoryRefreshRetryPolicy,
} from "../src/lib/gitRepositoryRefresh.js";
import {
  buildGitBranchCommitPreviewFiles,
  getGitBranchCommitTotals,
} from "../src/git-branch-switcher/display.js";
import {
  buildCommitFileRows,
  excludeCommitPreviewFiles,
  resolveCommitRequestMode,
} from "../src/git-action-menu/display.js";

function change(
  repoRelativePath: string,
  added: number,
  removed: number,
  overrides: Partial<GitFileChange> = {},
): GitFileChange {
  return {
    path: `/repo/${repoRelativePath}`,
    repoRelativePath,
    workspaceRelativePath: repoRelativePath,
    kind: "modified",
    section: "unstaged",
    added,
    removed,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
    ...overrides,
  };
}

function snapshot(overrides: Partial<GitRefreshResult> = {}): GitRefreshResult {
  return {
    summary: {
      workspacePath: "/repo",
      repoRoot: "/repo",
      workspaceInRepoPath: ".",
      autoRefreshWatchPaths: [],
      branchName: "main",
      trackingBranchName: "origin/main",
      headRefType: "branch",
      ahead: 0,
      behind: 0,
      isDirty: true,
      isGitAvailable: true,
      isRepository: true,
    },
    identity: {
      userName: "Fixture",
      userEmail: "fixture@example.invalid",
      nameSource: "local",
      emailSource: "local",
    },
    unstagedChanges: [
      change("src/a.ts", 42, 2),
      change("src/b.ts", 25, 2),
      change("src/c.ts", 30, 5),
      change("src/d.ts", 24, 3),
      change("src/e.ts", 10, 2),
    ],
    stagedChanges: [],
    branchComparison: null,
    ...overrides,
  };
}

function harness(
  isCurrent?: () => boolean,
  options: { retry?: GitRepositoryRefreshRetryPolicy } = {},
) {
  const reads: Array<{
    request: GitRefreshRequest;
    completion: ReturnType<typeof Promise.withResolvers<GitRefreshResult>>;
  }> = [];
  const publications: Array<{ result: GitRefreshResult; sequence: number }> = [];
  const failures: Array<{ error: unknown; sequence: number }> = [];
  const starts: number[] = [];
  const owner = createGitRepositoryRefreshCoordinator({
    workspacePath: "/repo",
    isCurrent,
    read: (request) => {
      const completion = Promise.withResolvers<GitRefreshResult>();
      reads.push({ request, completion });
      return completion.promise;
    },
    onStart: (sequence) => starts.push(sequence),
    publish: (result, sequence) => publications.push({ result, sequence }),
    onError: (error, sequence) => failures.push({ error, sequence }),
    retry: options.retry,
  });
  return { owner, reads, publications, failures, starts };
}

function readAt(state: ReturnType<typeof harness>, index: number) {
  const read = state.reads[index];
  assert.ok(read, `expected Git read ${index}`);
  return read;
}

test("owner 先发布同一完整快照，再交给提交预览，不追加第二次同步查询", async () => {
  const state = harness();
  try {
    const result = snapshot();
    const loading = state.owner.refresh({ includeIdentity: true });
    assert.equal(state.reads.length, 1);
    readAt(state, 0).completion.resolve(result);

    const dialogResult = await loading;
    assert.equal(state.publications.length, 1);
    assert.equal(state.publications[0]?.result, result);
    assert.equal(dialogResult, result);
    assert.equal(dialogResult.summary, state.publications[0]?.result.summary);
    assert.equal(dialogResult.stagedChanges, state.publications[0]?.result.stagedChanges);
    assert.equal(dialogResult.unstagedChanges, state.publications[0]?.result.unstagedChanges);

    const rows = buildCommitFileRows({
      stagedFiles: buildGitBranchCommitPreviewFiles(dialogResult.stagedChanges),
      unstagedFiles: buildGitBranchCommitPreviewFiles(dialogResult.unstagedChanges),
    });
    assert.deepEqual(getGitBranchCommitTotals(rows), {
      fileCount: 5,
      totalAdded: 131,
      totalRemoved: 14,
    });
    assert.equal(state.reads.length, 1);
  } finally {
    state.owner.dispose();
  }
});

test("并发扩展需求只合并到一个 pending，并共享满足 OR flags 的新结果", async () => {
  const state = harness();
  try {
    const first = state.owner.refresh();
    const identity = state.owner.refresh({ includeIdentity: true });
    const branch = state.owner.refresh({ includeBranchComparison: true });
    const basic = state.owner.refresh({ includeIdentity: false, includeBranchComparison: false });
    assert.equal(identity, branch);
    assert.equal(identity, basic);
    assert.notEqual(first, identity);
    assert.equal(state.reads.length, 1);
    assert.deepEqual(state.starts, [1]);
    assert.deepEqual(readAt(state, 0).request, {
      workspacePath: "/repo",
      includeIdentity: false,
      includeBranchComparison: false,
    });

    const before = snapshot({ identity: null });
    readAt(state, 0).completion.resolve(before);
    assert.equal(await first, before);
    assert.equal(state.publications[0]?.result, before);
    assert.equal(state.reads.length, 2);
    assert.deepEqual(state.starts, [1, 2]);
    assert.deepEqual(readAt(state, 1).request, {
      workspacePath: "/repo",
      includeIdentity: true,
      includeBranchComparison: true,
    });

    const after = snapshot({
      branchComparison: {
        baseRef: "origin/main",
        headRef: "HEAD",
        comparisonLabel: "main",
        changes: [],
      },
    });
    readAt(state, 1).completion.resolve(after);
    const results = await Promise.all([identity, branch, basic]);
    assert.ok(results.every((result) => result === after));
    assert.notEqual(after, before);
    assert.deepEqual(
      state.publications.map(({ sequence }) => sequence),
      [1, 2],
    );
  } finally {
    state.owner.dispose();
  }
});

test("持续排队不废弃 inflight；读取期间的操作后意图不能复用操作前快照", async () => {
  const state = harness();
  try {
    const first = state.owner.refresh();
    const afterOperation = state.owner.refresh();
    const notifications = Array.from({ length: 100 }, () => state.owner.refresh());
    assert.ok(notifications.every((promise) => promise === afterOperation));
    assert.deepEqual(state.starts, [1]);
    assert.equal(state.reads.length, 1);

    const before = snapshot({ unstagedChanges: [change("src/old.ts", 1, 1)] });
    readAt(state, 0).completion.resolve(before);
    assert.equal(await first, before);
    assert.equal(state.publications[0]?.result, before);
    assert.equal(state.reads.length, 2);

    let operationResolved = false;
    void afterOperation.then(() => {
      operationResolved = true;
    });
    await Promise.resolve();
    assert.equal(operationResolved, false);
    const after = snapshot();
    readAt(state, 1).completion.resolve(after);
    assert.equal(await afterOperation, after);
    await Promise.all(notifications);
    assert.equal(state.reads.length, 2);
    assert.deepEqual(
      state.publications.map(({ sequence }) => sequence),
      [1, 2],
    );
  } finally {
    state.owner.dispose();
  }
});

test("pending 已发出后新通知只排下一次读取，不能复用已经发出的 pending", async () => {
  const state = harness();
  try {
    const first = state.owner.refresh();
    const second = state.owner.refresh();
    readAt(state, 0).completion.resolve(snapshot());
    await first;
    assert.equal(state.reads.length, 2);

    const third = state.owner.refresh({ includeIdentity: true });
    assert.notEqual(third, second);
    assert.equal(third, state.owner.refresh());
    readAt(state, 1).completion.resolve(snapshot());
    await second;
    assert.equal(state.reads.length, 3);
    assert.equal(readAt(state, 2).request.includeIdentity, true);
    readAt(state, 2).completion.resolve(snapshot());
    await third;
    assert.deepEqual(state.starts, [1, 2, 3]);
  } finally {
    state.owner.dispose();
  }
});

test("同一路径切换远端 identity，旧结果不发布，旧 pending 不 launch", async () => {
  let currentIdentity = "remote-a";
  const oldState = harness(() => currentIdentity === "remote-a");
  const first = oldState.owner.refresh();
  const pending = oldState.owner.refresh({ includeIdentity: true });
  const firstRejected = assert.rejects(first, GitRepositoryRefreshInvalidatedError);
  const pendingRejected = assert.rejects(pending, GitRepositoryRefreshInvalidatedError);
  currentIdentity = "remote-b";
  const newState = harness(() => currentIdentity === "remote-b");
  try {
    const next = newState.owner.refresh();
    const nextResult = snapshot();
    readAt(newState, 0).completion.resolve(nextResult);
    assert.equal(await next, nextResult);
    readAt(oldState, 0).completion.resolve(snapshot());
    await Promise.all([firstRejected, pendingRejected]);
    assert.equal(oldState.publications.length, 0);
    assert.equal(oldState.failures.length, 0);
    assert.equal(oldState.reads.length, 1);
    assert.equal(newState.publications[0]?.result, nextResult);
  } finally {
    oldState.owner.dispose();
    newState.owner.dispose();
  }
});

for (const invalidation of ["service", "rpc-disconnect"] as const) {
  test(`${invalidation} 变化时隔离旧读取与待执行意图`, async () => {
    let validScope = true;
    const state = harness(() => validScope);
    const first = state.owner.refresh();
    const pending = state.owner.refresh();
    const firstRejected = assert.rejects(first, GitRepositoryRefreshInvalidatedError);
    const pendingRejected = assert.rejects(pending, GitRepositoryRefreshInvalidatedError);
    try {
      validScope = false;
      readAt(state, 0).completion.resolve(snapshot());
      await Promise.all([firstRejected, pendingRejected]);
      await assert.rejects(state.owner.refresh(), GitRepositoryRefreshInvalidatedError);
      assert.equal(state.reads.length, 1);
      assert.equal(state.publications.length, 0);
      assert.equal(state.failures.length, 0);
    } finally {
      state.owner.dispose();
    }
  });
}

test("dispose 立即拒绝所有 await、阻止旧 pending 和后续读取，并可重复清理", async () => {
  const state = harness();
  const first = state.owner.refresh();
  const pending = state.owner.refresh();
  const firstRejected = assert.rejects(first, GitRepositoryRefreshInvalidatedError);
  const pendingRejected = assert.rejects(pending, GitRepositoryRefreshInvalidatedError);
  state.owner.dispose();
  state.owner.dispose();
  await Promise.all([firstRejected, pendingRejected]);
  await assert.rejects(state.owner.refresh(), GitRepositoryRefreshInvalidatedError);
  readAt(state, 0).completion.resolve(snapshot());
  await Promise.resolve();
  assert.equal(state.publications.length, 0);
  assert.equal(state.failures.length, 0);
  assert.equal(state.reads.length, 1);
});

test("RPC 同步抛错也真实拒绝，之后仍能再次刷新", async () => {
  const error = new Error("fixture synchronous RPC failure");
  const result = snapshot();
  let calls = 0;
  const publications: GitRefreshResult[] = [];
  const owner = createGitRepositoryRefreshCoordinator({
    workspacePath: "/repo",
    read: () => {
      calls += 1;
      if (calls === 1) {
        throw error;
      }
      return Promise.resolve(result);
    },
    publish: (next) => publications.push(next),
  });
  try {
    await assert.rejects(owner.refresh(), (failure) => failure === error);
    assert.equal(await owner.refresh(), result);
    assert.equal(calls, 2);
    assert.deepEqual(publications, [result]);
  } finally {
    owner.dispose();
  }
});

test("失败不发布假快照，不吞错误，也不阻止已排队和之后的新请求恢复", async () => {
  const state = harness();
  try {
    const error = new Error("fixture Git refresh failure");
    const first = state.owner.refresh();
    const firstRejected = assert.rejects(first, (failure) => failure === error);
    const pending = state.owner.refresh({ includeIdentity: true });
    readAt(state, 0).completion.reject(error);
    await firstRejected;
    assert.equal(state.publications.length, 0);
    assert.equal(state.failures[0]?.error, error);
    assert.equal(state.reads.length, 2);
    const recovered = snapshot();
    readAt(state, 1).completion.resolve(recovered);
    assert.equal(await pending, recovered);
    assert.equal(state.publications[0]?.result, recovered);

    const next = state.owner.refresh();
    readAt(state, 2).completion.resolve(recovered);
    await next;
    assert.deepEqual(state.starts, [1, 2, 3]);
    assert.deepEqual(
      state.publications.map(({ sequence }) => sequence),
      [2, 3],
    );
  } finally {
    state.owner.dispose();
  }
});

test("合并的 await 共享真实失败，失败后无遗留 pending", async () => {
  const state = harness();
  try {
    const first = state.owner.refresh();
    const pending = state.owner.refresh();
    const merged = state.owner.refresh({ includeIdentity: true });
    const error = new Error("fixture pending failure");
    const pendingRejected = assert.rejects(pending, (failure) => failure === error);
    const mergedRejected = assert.rejects(merged, (failure) => failure === error);
    readAt(state, 0).completion.resolve(snapshot());
    await first;
    readAt(state, 1).completion.reject(error);
    await Promise.all([pendingRejected, mergedRejected]);
    assert.equal(state.publications.length, 1);
    assert.equal(state.reads.length, 2);

    const next = state.owner.refresh();
    readAt(state, 2).completion.resolve(snapshot());
    await next;
    assert.equal(state.reads.length, 3);
  } finally {
    state.owner.dispose();
  }
});

test("同一基线仍保留部分暂存边界，取消勾选不改 owner 的整仓统计", async () => {
  const state = harness();
  try {
    const result = snapshot({
      stagedChanges: [change("src/partial.ts", 3, 1, { section: "staged", isStaged: true })],
      unstagedChanges: [change("src/partial.ts", 5, 2), change("src/other.ts", 123, 11)],
    });
    const unchanged = structuredClone(result);
    const loading = state.owner.refresh({ includeIdentity: true });
    readAt(state, 0).completion.resolve(result);
    const dialogResult = await loading;
    const rows = buildCommitFileRows({
      stagedFiles: buildGitBranchCommitPreviewFiles(dialogResult.stagedChanges),
      unstagedFiles: buildGitBranchCommitPreviewFiles(dialogResult.unstagedChanges),
    });
    assert.deepEqual(resolveCommitRequestMode(rows), {
      paths: ["/repo/src/other.ts", "/repo/src/partial.ts"],
      worktreePaths: ["/repo/src/other.ts"],
      stagedPaths: ["/repo/src/partial.ts"],
      stagedOnly: true,
    });
    const selected = excludeCommitPreviewFiles(rows, new Set(["/repo/src/other.ts"]));
    assert.deepEqual(getGitBranchCommitTotals(selected), {
      fileCount: 1,
      totalAdded: 3,
      totalRemoved: 1,
    });
    assert.deepEqual(
      getGitBranchCommitTotals([...result.stagedChanges, ...result.unstagedChanges]),
      {
        fileCount: 3,
        totalAdded: 131,
        totalRemoved: 14,
      },
    );
    assert.deepEqual(result, unchanged);
    assert.equal(state.publications.length, 1);
    assert.equal(state.publications[0]?.result, dialogResult);
  } finally {
    state.owner.dispose();
  }
});

const waitMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const timeoutError = (label: string) =>
  new Error(`${label} timed out after 15000ms (elapsed=19032ms, killAt=15011ms, forceKill=true)`);

test("Git 命令超时按退避重试：第二次成功后发布，不落到 onError", async () => {
  const state = harness(undefined, {
    retry: { delaysMs: [1], isRetryable: isGitRefreshTimeoutError },
  });
  try {
    // 复现 2026-11-26 的现场：重启后 host 冷启动，首个 git.refresh 因 numstat 超时失败。
    const result = snapshot({ identity: null });
    const loading = state.owner.refresh();
    readAt(state, 0).completion.reject(timeoutError("git diff --numstat"));
    await waitMs(20);
    assert.equal(state.reads.length, 2);
    assert.deepEqual(state.starts, [1, 2]);

    readAt(state, 1).completion.resolve(result);
    assert.equal(await loading, result);
    assert.equal(state.failures.length, 0);
    assert.equal(state.publications.length, 1);
    assert.equal(state.publications[0]?.sequence, 2);
  } finally {
    state.owner.dispose();
  }
});

test("非超时错误不重试：直接拒绝并只上报一次", async () => {
  const state = harness(undefined, {
    retry: { delaysMs: [1, 1], isRetryable: isGitRefreshTimeoutError },
  });
  try {
    const error = new Error("fatal: unable to access repository");
    const loading = state.owner.refresh();
    const rejected = assert.rejects(loading, (failure) => failure === error);
    readAt(state, 0).completion.reject(error);
    await rejected;
    await waitMs(20);
    assert.equal(state.reads.length, 1);
    assert.equal(state.failures.length, 1);
    assert.equal(state.publications.length, 0);
  } finally {
    state.owner.dispose();
  }
});

test("重试耗尽后拒绝一次，onError 只报一次", async () => {
  const state = harness(undefined, {
    retry: { delaysMs: [1, 1], isRetryable: isGitRefreshTimeoutError },
  });
  try {
    const lastError = timeoutError("git diff --numstat");
    const loading = state.owner.refresh();
    const rejected = assert.rejects(loading, (failure) => failure === lastError);
    readAt(state, 0).completion.reject(timeoutError("git status"));
    await waitMs(20);
    readAt(state, 1).completion.reject(timeoutError("git status"));
    await waitMs(20);
    assert.equal(state.reads.length, 3);
    readAt(state, 2).completion.reject(lastError);
    await rejected;
    assert.equal(state.failures.length, 1);
    assert.equal(state.failures[0]?.error, lastError);
    assert.equal(state.publications.length, 0);
  } finally {
    state.owner.dispose();
  }
});

test("退避等待期间 dispose 立即结束，不再发起读取", async () => {
  const state = harness(undefined, {
    retry: { delaysMs: [60_000], isRetryable: isGitRefreshTimeoutError },
  });
  try {
    const loading = state.owner.refresh();
    const rejected = assert.rejects(loading, GitRepositoryRefreshInvalidatedError);
    readAt(state, 0).completion.reject(timeoutError("git diff --numstat"));
    await waitMs(5);
    state.owner.dispose();
    await rejected;
    assert.equal(state.reads.length, 1);
    assert.equal(state.failures.length, 0);
    assert.equal(state.publications.length, 0);
  } finally {
    state.owner.dispose();
  }
});

test("读取失败时只沿用已确认的仓库摘要，不为非仓库伪造快照", () => {
  assert.equal(shouldKeepGitRepositorySnapshot({ isGitAvailable: true, isRepository: true }), true);
  assert.equal(
    shouldKeepGitRepositorySnapshot({ isGitAvailable: true, isRepository: false }),
    false,
  );
  assert.equal(
    shouldKeepGitRepositorySnapshot({ isGitAvailable: false, isRepository: true }),
    false,
  );
});

test("重试等待期间的新请求进入 pending，重试成功后只再 launch 一次", async () => {
  const state = harness(undefined, {
    retry: { delaysMs: [1], isRetryable: isGitRefreshTimeoutError },
  });
  try {
    const first = state.owner.refresh();
    readAt(state, 0).completion.reject(timeoutError("git diff --numstat"));
    const second = state.owner.refresh({ includeIdentity: true });
    await waitMs(20);
    assert.equal(state.reads.length, 2);

    const retried = snapshot({ identity: null });
    readAt(state, 1).completion.resolve(retried);
    assert.equal(await first, retried);
    assert.equal(state.reads.length, 3);
    assert.equal(readAt(state, 2).request.includeIdentity, true);

    const pending = snapshot();
    readAt(state, 2).completion.resolve(pending);
    assert.equal(await second, pending);
    assert.deepEqual(
      state.publications.map(({ sequence }) => sequence),
      [2, 3],
    );
  } finally {
    state.owner.dispose();
  }
});

test("退避等待期间有 pending 时 dispose：两者各拒绝一次且不再读取", async () => {
  const state = harness(undefined, {
    retry: { delaysMs: [60_000], isRetryable: isGitRefreshTimeoutError },
  });
  try {
    const first = state.owner.refresh();
    const second = state.owner.refresh();
    const firstRejected = assert.rejects(first, GitRepositoryRefreshInvalidatedError);
    const secondRejected = assert.rejects(second, GitRepositoryRefreshInvalidatedError);
    readAt(state, 0).completion.reject(timeoutError("git status"));
    await waitMs(5);
    state.owner.dispose();
    await Promise.all([firstRejected, secondRejected]);
    await waitMs(5);
    assert.equal(state.reads.length, 1);
    assert.equal(state.failures.length, 0);
    assert.equal(state.publications.length, 0);
  } finally {
    state.owner.dispose();
  }
});

test("InvalidatedError 不被当作可重试错误", async () => {
  const invalidated = new GitRepositoryRefreshInvalidatedError();
  const state = harness(undefined, {
    retry: { delaysMs: [1, 1], isRetryable: isGitRefreshTimeoutError },
  });
  try {
    const loading = state.owner.refresh();
    const rejected = assert.rejects(loading, (failure) => failure === invalidated);
    readAt(state, 0).completion.reject(invalidated);
    await rejected;
    await waitMs(10);
    assert.equal(state.reads.length, 1);
    assert.equal(state.failures.length, 1);
  } finally {
    state.owner.dispose();
  }
});

test("裸对象形式的超时错误（RPC PromiseErrorObj）也能识别", () => {
  assert.equal(isGitRefreshTimeoutError({ message: "git status timed out after 15000ms" }), true);
  assert.equal(isGitRefreshTimeoutError({ message: "fatal: not a repository" }), false);
  assert.equal(isGitRefreshTimeoutError(null), false);
});
