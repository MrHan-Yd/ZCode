import assert from "node:assert/strict";
import test from "node:test";
import { createGitService } from "../src/git/gitService.js";
import type {
  GitCliRepo,
  GitLineStat,
  GitStatusEntry,
  GitStatusSnapshot,
} from "../src/git/repo/gitCliRepo.js";

const REPO_ROOT = "C:/fake-repo";

function entry(overrides: Partial<GitStatusEntry> & Pick<GitStatusEntry, "path">): GitStatusEntry {
  const y = overrides.y ?? "?";
  return {
    originalPath: null,
    kind: "added",
    x: null,
    y,
    // `??` 条目由 status 解析器标成未跟踪；这里按同样的约定推导，避免每个用例都手写。
    isUntracked: y === "?",
    isConflicted: false,
    ...overrides,
  };
}

function stat(added: number, removed = 0): GitLineStat {
  return { added, removed };
}

function createSnapshot(input: {
  entries: GitStatusEntry[];
  stagedStats?: Array<[string, GitLineStat]>;
  unstagedStats?: Array<[string, GitLineStat]>;
  untrackedStats?: Array<[string, GitLineStat]>;
}): GitStatusSnapshot {
  return {
    resolution: {
      workspacePath: REPO_ROOT,
      repoRoot: REPO_ROOT,
      workspaceInRepoPath: ".",
      autoRefreshWatchPaths: [],
      isGitAvailable: true,
      isRepository: true,
    },
    summary: {
      workspacePath: REPO_ROOT,
      repoRoot: REPO_ROOT,
      workspaceInRepoPath: ".",
      autoRefreshWatchPaths: [],
      branchName: "main",
      trackingBranchName: "origin/main",
      headRefType: "branch",
      ahead: 0,
      behind: 0,
      isDirty: input.entries.length > 0,
      isGitAvailable: true,
      isRepository: true,
    },
    entries: input.entries,
    stagedStats: new Map(input.stagedStats ?? []),
    unstagedStats: new Map(input.unstagedStats ?? []),
    untrackedStats: new Map(input.untrackedStats ?? []),
  };
}

function createService(snapshot: GitStatusSnapshot) {
  const repo = {
    getStatus: async () => snapshot,
    getIdentity: async () => ({ name: "tester", email: "tester@example.com" }),
  } as unknown as GitCliRepo;
  return createGitService({ repo });
}

// 背景：countUntrackedFileLines 对含 NUL 字节的文件返回 0 行，旧实现用 added>0 当
// 「文件是否存在」的判据，于是 PNG/ICO 这类二进制未跟踪文件被整条删掉，
// 提交弹窗看不到、也提交不了（specs/git-commit-file-selection.md 规则 4）。
test("未跟踪的二进制文件（行数为 0）仍然是一条变更", async () => {
  const service = createService(
    createSnapshot({
      entries: [entry({ path: "docs/logo/png/icon-16.png" })],
      untrackedStats: [["docs/logo/png/icon-16.png", stat(0)]],
    }),
  );

  const changes = await service.getChanges({ workspacePath: REPO_ROOT, sourceId: "unstaged" });
  assert.equal(changes.length, 1);
  assert.equal(changes[0]?.repoRelativePath, "docs/logo/png/icon-16.png");
  assert.equal(changes[0]?.isUntracked, true);
  assert.equal(changes[0]?.section, "untracked");
  // 行数只用于展示：二进制文件保持 0/0，但条目本身必须存在。
  assert.equal(changes[0]?.added, 0);
  assert.equal(changes[0]?.removed, 0);
});

test("未跟踪的空文件、折叠目录与文本文件都进入未暂存变更", async () => {
  const service = createService(
    createSnapshot({
      entries: [
        entry({ path: "docs/logo/png/icon-16.png" }),
        entry({ path: "empty.txt" }),
        entry({ path: "build/" }),
        entry({ path: "notes.md" }),
        entry({ path: "src/app.ts", kind: "modified", x: ".", y: "M" }),
      ],
      unstagedStats: [["src/app.ts", stat(3, 1)]],
      untrackedStats: [
        ["docs/logo/png/icon-16.png", stat(0)],
        ["empty.txt", stat(0)],
        ["build/", stat(0)],
        ["notes.md", stat(5)],
      ],
    }),
  );

  const changes = await service.getChanges({ workspacePath: REPO_ROOT, sourceId: "unstaged" });
  assert.deepEqual(
    changes.map((change) => change.repoRelativePath).sort(),
    ["build/", "docs/logo/png/icon-16.png", "empty.txt", "notes.md", "src/app.ts"].sort(),
  );
  assert.equal(changes.find((change) => change.repoRelativePath === "notes.md")?.added, 5);
  assert.equal(changes.find((change) => change.repoRelativePath === "src/app.ts")?.added, 3);
});

test("refresh 与 getChanges 对未跟踪条目的口径一致，且不再与已暂存条目混淆", async () => {
  const snapshot = createSnapshot({
    entries: [
      entry({ path: "docs/logo/png/flick.ico" }),
      entry({ path: "src/staged.ts", kind: "modified", x: "M", y: "." }),
    ],
    stagedStats: [["src/staged.ts", stat(4, 0)]],
    untrackedStats: [["docs/logo/png/flick.ico", stat(0)]],
  });
  const service = createService(snapshot);

  const refreshed = await service.refresh({ workspacePath: REPO_ROOT, includeIdentity: false });
  const unstaged = await service.getChanges({ workspacePath: REPO_ROOT, sourceId: "unstaged" });
  const staged = await service.getChanges({ workspacePath: REPO_ROOT, sourceId: "staged" });

  assert.deepEqual(
    refreshed.unstagedChanges.map((change) => change.repoRelativePath),
    unstaged.map((change) => change.repoRelativePath),
  );
  assert.deepEqual(
    refreshed.unstagedChanges.map((change) => change.repoRelativePath),
    ["docs/logo/png/flick.ico"],
  );
  assert.deepEqual(
    staged.map((change) => change.repoRelativePath),
    ["src/staged.ts"],
  );
  assert.equal(refreshed.summary.isDirty, true);
});
