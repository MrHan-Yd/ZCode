import assert from "node:assert/strict";
import test from "node:test";
import type { GitBranchCommitPreviewFile } from "../src/git-branch-switcher/display.js";
import {
  collectCommitPreviewStagePaths,
  dedupeCommitPreviewFiles,
  excludeCommitPreviewFiles,
  resolveCommitPreviewSelectionState,
  shouldShowCommitFileList,
  splitCommitPreviewFilePath,
} from "../src/git-action-menu/display.js";

function previewFile(
  stagePath: string,
  overrides: Partial<GitBranchCommitPreviewFile> = {},
): GitBranchCommitPreviewFile {
  const repoRelativePath = overrides.repoRelativePath ?? stagePath;
  return {
    stagePath,
    repoRelativePath,
    workspaceRelativePath: overrides.workspaceRelativePath ?? repoRelativePath,
    kind: "modified",
    added: 1,
    removed: 0,
    ...overrides,
  };
}

test("同一文件的 staged 与 unstaged 记录合并为一行，且按 repo 相对路径排序", () => {
  const files = dedupeCommitPreviewFiles([
    previewFile("/repo/src/b.ts", { repoRelativePath: "src/b.ts", added: 4, removed: 1 }),
    previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
    // 同一路径在 unstaged 之后又出现在 staged：必须复用第一条，不能变成两行勾选。
    previewFile("/repo/src/b.ts", { repoRelativePath: "src/b.ts", section: "staged" }),
  ]);

  assert.deepEqual(
    files.map((file) => file.repoRelativePath),
    ["src/a.ts", "src/b.ts"],
  );
  assert.equal(files[1]?.added, 4);
});

test("取消勾选的文件不进入 stage paths，且不受同路径另一条记录影响", () => {
  const files = dedupeCommitPreviewFiles([
    previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
    previewFile("/repo/src/b.ts", { repoRelativePath: "src/b.ts" }),
  ]);

  const stagePaths = collectCommitPreviewStagePaths(
    excludeCommitPreviewFiles(files, new Set(["/repo/src/b.ts"])),
  );

  assert.deepEqual(stagePaths, ["/repo/src/a.ts"]);
});

test("全部取消勾选后 stage paths 为空", () => {
  const files = dedupeCommitPreviewFiles([
    previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
    previewFile("/repo/src/b.ts", { repoRelativePath: "src/b.ts" }),
  ]);

  const stagePaths = collectCommitPreviewStagePaths(
    excludeCommitPreviewFiles(files, new Set(["/repo/src/a.ts", "/repo/src/b.ts"])),
  );

  assert.deepEqual(stagePaths, []);
});

test("空排除集合不复制文件对象，保持原数组内容", () => {
  const files = [previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" })];
  const selected = excludeCommitPreviewFiles(files, new Set());

  assert.equal(selected.length, 1);
  assert.equal(selected[0], files[0]);
});

test("全选状态区分全选 / 部分选中 / 全不选", () => {
  const files = [
    previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
    previewFile("/repo/src/b.ts", { repoRelativePath: "src/b.ts" }),
  ];

  assert.equal(resolveCommitPreviewSelectionState(files, new Set()), "all");
  assert.equal(resolveCommitPreviewSelectionState(files, new Set(["/repo/src/a.ts"])), "partial");
  assert.equal(
    resolveCommitPreviewSelectionState(files, new Set(["/repo/src/a.ts", "/repo/src/b.ts"])),
    "none",
  );
  // 没有可提交文件时全选开关不应显示为选中。
  assert.equal(resolveCommitPreviewSelectionState([], new Set()), "none");
});

test("stage paths 对重复输入去重，避免 git 参数列表里出现重复路径", () => {
  const stagePaths = collectCommitPreviewStagePaths([
    previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
    previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts", section: "staged" }),
  ]);

  assert.deepEqual(stagePaths, ["/repo/src/a.ts"]);
});

// 清单是唯一展示待提交文件路径的地方：只有 1 个文件时也必须渲染，否则用户只能看到数量。
test("有可提交文件就渲染清单，只有 1 个文件时也渲染", () => {
  assert.equal(shouldShowCommitFileList([]), false);
  assert.equal(
    shouldShowCommitFileList([previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" })]),
    true,
  );
  assert.equal(
    shouldShowCommitFileList([
      previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
      previewFile("/repo/src/b.ts", { repoRelativePath: "src/b.ts" }),
    ]),
    true,
  );
});

test("路径拆成目录与文件名，保证长路径截断时文件名仍可见", () => {
  assert.deepEqual(splitCommitPreviewFilePath("packages/ui/src/git-action-menu/display.ts"), {
    directory: "packages/ui/src/git-action-menu",
    fileName: "display.ts",
  });
  // 反斜杠输入按 POSIX 归一化，避免 Windows 路径被当成整段文件名。
  assert.deepEqual(splitCommitPreviewFilePath("packages\\ui\\src\\a.ts"), {
    directory: "packages/ui/src",
    fileName: "a.ts",
  });
});

test("根目录文件没有目录段，不会被拆出前导斜杠", () => {
  assert.deepEqual(splitCommitPreviewFilePath("README.md"), {
    directory: "",
    fileName: "README.md",
  });
  assert.deepEqual(splitCommitPreviewFilePath("/repo/.gitignore"), {
    directory: "/repo",
    fileName: ".gitignore",
  });
});
