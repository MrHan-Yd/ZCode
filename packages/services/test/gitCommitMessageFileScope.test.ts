import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import type { GitFileChange } from "@zcode/shared";
import { filterCommitMessageFilesByCurrentSession } from "../src/git/commitMessageFileScope.js";

const WORKSPACE_PATH = "/tmp/repo/apps/web";
const REPO_ROOT = "/tmp/repo";
const WORKSPACE_IN_REPO_PATH = "apps/web";

function change(repoRelativePath: string): GitFileChange {
  return {
    path: `${REPO_ROOT}/${repoRelativePath}`,
    repoRelativePath,
    workspaceRelativePath: repoRelativePath.replace(/^apps\/web\//, ""),
    kind: "modified",
    section: "unstaged",
    added: 1,
    removed: 0,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
  };
}

function filterFiles(options: {
  files: GitFileChange[];
  currentSessionFilePaths?: string[];
  excludePaths?: string[];
}): string[] {
  return filterCommitMessageFilesByCurrentSession({
    files: options.files,
    workspacePath: WORKSPACE_PATH,
    repoRoot: REPO_ROOT,
    workspaceInRepoPath: WORKSPACE_IN_REPO_PATH,
    currentSessionFilePaths: options.currentSessionFilePaths,
    excludePaths: options.excludePaths,
  }).map((file) => file.repoRelativePath);
}

const files = [change("apps/web/src/a.ts"), change("apps/web/src/b.ts"), change("docs/readme.md")];

test("未传 excludePaths 时只按会话范围过滤，行为不变", () => {
  assert.deepEqual(filterFiles({ files, currentSessionFilePaths: ["apps/web/src/a.ts"] }), [
    "apps/web/src/a.ts",
  ]);
});

test("excludePaths 接收仓库绝对路径，剔除对应文件", () => {
  assert.deepEqual(filterFiles({ files, excludePaths: ["/tmp/repo/apps/web/src/a.ts"] }), [
    "apps/web/src/b.ts",
    "docs/readme.md",
  ]);
});

test("excludePaths 接收 workspace 相对路径，同样命中同一个文件", () => {
  assert.deepEqual(filterFiles({ files, excludePaths: ["src/b.ts"] }), [
    "apps/web/src/a.ts",
    "docs/readme.md",
  ]);
});

test("会话范围与排除集合叠加：先取交集，再去掉被排除项", () => {
  assert.deepEqual(
    filterFiles({
      files,
      currentSessionFilePaths: ["apps/web/src/a.ts", "apps/web/src/b.ts"],
      excludePaths: ["apps/web/src/b.ts"],
    }),
    ["apps/web/src/a.ts"],
  );
});

test("excludePaths 为空数组等同于不排除", () => {
  assert.deepEqual(filterFiles({ files, excludePaths: [] }).length, 3);
});

test("反斜杠写法与正斜杠写法指向同一文件，都会被排除", () => {
  // 提交弹窗传的 stagePath 与 git 状态路径在 Windows 上都是反斜杠，
  // 两侧都过 normalizeGitPath，所以分隔符差异不会让排除失效。
  assert.deepEqual(filterFiles({ files, excludePaths: ["apps\\web\\src\\a.ts"] }), [
    "apps/web/src/b.ts",
    "docs/readme.md",
  ]);
});

test("排除路径用本机绝对路径形式时命中（覆盖 Windows 反斜杠形态）", () => {
  const repoRoot = resolve("zcode-scope-test", "repo");
  const workspacePath = resolve(repoRoot, "apps", "web");
  // 与生产一致：GitFileChange.path 是 resolve(repoRoot, ...) 的结果。
  const filePath = resolve(workspacePath, "src", "a.ts");
  const platformFiles: GitFileChange[] = [
    {
      path: filePath,
      repoRelativePath: "apps/web/src/a.ts",
      workspaceRelativePath: "src/a.ts",
      kind: "modified",
      section: "unstaged",
      added: 1,
      removed: 0,
      isStaged: false,
      isUntracked: false,
      isConflicted: false,
    },
  ];

  assert.deepEqual(
    filterCommitMessageFilesByCurrentSession({
      files: platformFiles,
      workspacePath,
      repoRoot,
      workspaceInRepoPath: "apps/web",
      excludePaths: [filePath],
    }),
    [],
  );
});
