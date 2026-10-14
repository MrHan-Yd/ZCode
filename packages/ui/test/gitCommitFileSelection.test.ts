import assert from "node:assert/strict";
import test from "node:test";
import type { GitFileChange } from "@zcode/shared";
import {
  buildGitBranchCommitPreviewFiles,
  type GitBranchCommitPreviewFile,
} from "../src/git-branch-switcher/display.js";
import {
  buildCommitFileRows,
  collectCommitPreviewStagePaths,
  excludeCommitPreviewFiles,
  groupCommitFileRows,
  resolveCommitPreviewSelectionState,
  resolveCommitRequestMode,
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
    isUntracked: false,
    added: 1,
    removed: 0,
    ...overrides,
  };
}

function gitFileChange(overrides: Partial<GitFileChange> = {}): GitFileChange {
  const repoRelativePath = overrides.repoRelativePath ?? "src/a.ts";
  return {
    path: overrides.path ?? `/repo/${repoRelativePath}`,
    repoRelativePath,
    workspaceRelativePath: repoRelativePath,
    kind: "modified",
    section: "unstaged",
    added: 1,
    removed: 0,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
    ...overrides,
  };
}

test("同一文件的 staged 与 unstaged 记录只占一行，不会再出现两条勾选", () => {
  const rows = buildCommitFileRows({
    stagedFiles: [previewFile("/repo/src/b.ts", { repoRelativePath: "src/b.ts", added: 3 })],
    unstagedFiles: [previewFile("/repo/src/b.ts", { repoRelativePath: "src/b.ts", added: 5 })],
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.stagePath, "/repo/src/b.ts");
});

test("有已暂存内容的文件只进「已暂存的更改」，并标记还有未暂存余量", () => {
  const rows = buildCommitFileRows({
    stagedFiles: [previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts", added: 3 })],
    unstagedFiles: [previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts", added: 5 })],
  });

  assert.equal(rows[0]?.group, "staged");
  assert.equal(rows[0]?.hasUnstagedRemainder, true);
  // 行内展示的是索引里的行数，不是索引 + 工作区的合计。
  assert.equal(rows[0]?.added, 3);
});

test("已暂存但工作区没有余量的文件不进 stagedPaths 语义（hasUnstagedRemainder 为假）", () => {
  const rows = buildCommitFileRows({
    stagedFiles: [previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" })],
    unstagedFiles: [],
  });

  assert.equal(rows[0]?.group, "staged");
  assert.equal(rows[0]?.hasUnstagedRemainder, false);
});

test("索引里没有改动的文件按跟踪状态分流，并按 repo 相对路径排序", () => {
  const rows = buildCommitFileRows({
    stagedFiles: [],
    unstagedFiles: [
      previewFile("/repo/src/z.ts", { repoRelativePath: "src/z.ts" }),
      previewFile("/repo/docs/new.md", { repoRelativePath: "docs/new.md", isUntracked: true }),
      previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
    ],
  });

  assert.deepEqual(
    rows.map((row) => [row.repoRelativePath, row.group]),
    [
      ["docs/new.md", "untracked"],
      ["src/a.ts", "changes"],
      ["src/z.ts", "changes"],
    ],
  );
});

// 归属规则保证一行一路径：同一路径不会既有 staged 行又有 unstaged 行。
test("归属互斥：同一路径在清单里只出现一次", () => {
  const rows = buildCommitFileRows({
    stagedFiles: [
      previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
      previewFile("/repo/src/b.ts", { repoRelativePath: "src/b.ts" }),
    ],
    unstagedFiles: [
      previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
      previewFile("/repo/src/b.ts", { repoRelativePath: "src/b.ts" }),
      previewFile("/repo/src/c.ts", { repoRelativePath: "src/c.ts" }),
    ],
  });

  const stagePaths = rows.map((row) => row.stagePath);
  assert.deepEqual(new Set(stagePaths).size, stagePaths.length);
  assert.equal(rows.length, 3);
});

test("分组顺序固定为 已暂存的更改 → 更改 → 未进行版本管理的文件", () => {
  const groups = groupCommitFileRows(
    buildCommitFileRows({
      stagedFiles: [previewFile("/repo/src/s.ts", { repoRelativePath: "src/s.ts" })],
      unstagedFiles: [
        previewFile("/repo/src/m.ts", { repoRelativePath: "src/m.ts" }),
        previewFile("/repo/src/n.ts", { repoRelativePath: "src/n.ts", isUntracked: true }),
      ],
    }),
  );

  assert.deepEqual(
    groups.map((group) => group.id),
    ["staged", "changes", "untracked"],
  );
});

// 用户最常遇到的状态：什么都没暂存 → 不出现空的「已暂存的更改」表头。
test("没有任何已暂存内容时只出「更改」与「未进行版本管理的文件」两组", () => {
  const groups = groupCommitFileRows(
    buildCommitFileRows({
      stagedFiles: [],
      unstagedFiles: [
        previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
        previewFile("/repo/src/n.ts", { repoRelativePath: "src/n.ts", isUntracked: true }),
      ],
    }),
  );

  assert.deepEqual(
    groups.map((group) => group.id),
    ["changes", "untracked"],
  );
});

test("只有一个分组时也渲染，没有可提交行时没有分组", () => {
  const singleGroup = groupCommitFileRows(
    buildCommitFileRows({
      stagedFiles: [],
      unstagedFiles: [previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" })],
    }),
  );

  assert.deepEqual(
    singleGroup.map((group) => group.id),
    ["changes"],
  );
  assert.deepEqual(groupCommitFileRows([]), []);
});

// 快路径：没有部分暂存时不该退化成"只提交索引内容"，否则每次提交都会走临时 index plumbing。
test("默认全选：全部路径进 worktreePaths，stagedOnly 为假", () => {
  const rows = buildCommitFileRows({
    stagedFiles: [previewFile("/repo/src/s.ts", { repoRelativePath: "src/s.ts" })],
    unstagedFiles: [
      previewFile("/repo/src/m.ts", { repoRelativePath: "src/m.ts" }),
      previewFile("/repo/src/n.ts", { repoRelativePath: "src/n.ts", isUntracked: true }),
    ],
  });

  const mode = resolveCommitRequestMode(rows);

  assert.deepEqual(mode.paths, ["/repo/src/m.ts", "/repo/src/n.ts", "/repo/src/s.ts"]);
  assert.deepEqual(mode.worktreePaths, ["/repo/src/m.ts", "/repo/src/n.ts"]);
  assert.deepEqual(mode.stagedPaths, []);
  assert.equal(mode.stagedOnly, false);
});

test("只勾「已暂存的更改」：没有要 add 的路径，走索引提交", () => {
  const rows = buildCommitFileRows({
    stagedFiles: [previewFile("/repo/src/s.ts", { repoRelativePath: "src/s.ts" })],
    unstagedFiles: [previewFile("/repo/src/m.ts", { repoRelativePath: "src/m.ts" })],
  });

  const stagedRows = rows.filter((row) => row.group === "staged");
  assert.equal(stagedRows.length, 1);

  const mode = resolveCommitRequestMode(stagedRows);

  assert.deepEqual(mode.paths, ["/repo/src/s.ts"]);
  assert.deepEqual(mode.worktreePaths, []);
  assert.equal(mode.stagedOnly, true);
});

// 混合选择是本次改动的核心：一部分路径按工作区内容提交，另一部分只提交索引内容。
test("混合选择：带余量的已暂存路径进 stagedPaths，其余仍走工作区", () => {
  const rows = buildCommitFileRows({
    stagedFiles: [previewFile("/repo/src/partial.ts", { repoRelativePath: "src/partial.ts" })],
    unstagedFiles: [
      previewFile("/repo/src/partial.ts", { repoRelativePath: "src/partial.ts" }),
      previewFile("/repo/src/other.ts", { repoRelativePath: "src/other.ts" }),
    ],
  });

  const mode = resolveCommitRequestMode(rows);

  assert.deepEqual(mode.paths, ["/repo/src/other.ts", "/repo/src/partial.ts"]);
  assert.deepEqual(mode.worktreePaths, ["/repo/src/other.ts"]);
  assert.deepEqual(mode.stagedPaths, ["/repo/src/partial.ts"]);
  assert.equal(mode.stagedOnly, true);
});

test("已暂存但没有余量的路径不进 stagedPaths，不影响快路径", () => {
  const rows = buildCommitFileRows({
    stagedFiles: [previewFile("/repo/src/s.ts", { repoRelativePath: "src/s.ts" })],
    unstagedFiles: [previewFile("/repo/src/m.ts", { repoRelativePath: "src/m.ts" })],
  });

  const mode = resolveCommitRequestMode(rows);

  assert.deepEqual(mode.stagedPaths, []);
  assert.equal(mode.stagedOnly, false);
});

test("取消勾选的文件不进入提交路径，且不受其他行影响", () => {
  const rows = buildCommitFileRows({
    stagedFiles: [],
    unstagedFiles: [
      previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
      previewFile("/repo/src/b.ts", { repoRelativePath: "src/b.ts" }),
    ],
  });

  const mode = resolveCommitRequestMode(
    excludeCommitPreviewFiles(rows, new Set(["/repo/src/b.ts"])),
  );

  assert.deepEqual(mode.paths, ["/repo/src/a.ts"]);
});

test("全部取消勾选后提交路径为空", () => {
  const rows = buildCommitFileRows({
    stagedFiles: [],
    unstagedFiles: [
      previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
      previewFile("/repo/src/b.ts", { repoRelativePath: "src/b.ts" }),
    ],
  });

  const mode = resolveCommitRequestMode(
    excludeCommitPreviewFiles(rows, new Set(["/repo/src/a.ts", "/repo/src/b.ts"])),
  );

  assert.deepEqual(mode.paths, []);
  // 空选择下没有要 add 的路径，按定义 stagedOnly 为真；提交入口以 paths.length === 0
  // 直接拦截，不会因为这一点走索引提交。
  assert.equal(mode.stagedOnly, true);
});

test("空排除集合不复制行对象，保持原数组内容", () => {
  const rows = buildCommitFileRows({
    stagedFiles: [],
    unstagedFiles: [previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" })],
  });
  const selected = excludeCommitPreviewFiles(rows, new Set());

  assert.equal(selected.length, 1);
  assert.equal(selected[0], rows[0]);
});

test("stage paths 对重复输入去重，避免 git 参数列表里出现重复路径", () => {
  const stagePaths = collectCommitPreviewStagePaths([
    previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
    previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
  ]);

  assert.deepEqual(stagePaths, ["/repo/src/a.ts"]);
});

test("全选状态区分全选 / 部分选中 / 全不选", () => {
  const rows = [
    previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" }),
    previewFile("/repo/src/b.ts", { repoRelativePath: "src/b.ts" }),
  ];

  assert.equal(resolveCommitPreviewSelectionState(rows, new Set()), "all");
  assert.equal(resolveCommitPreviewSelectionState(rows, new Set(["/repo/src/a.ts"])), "partial");
  assert.equal(
    resolveCommitPreviewSelectionState(rows, new Set(["/repo/src/a.ts", "/repo/src/b.ts"])),
    "none",
  );
  // 没有可提交文件时全选开关不应显示为选中。
  assert.equal(resolveCommitPreviewSelectionState([], new Set()), "none");
});

// 清单是唯一展示待提交文件路径的地方：只有 1 个文件时也必须渲染，否则用户只能看到数量。
test("有可提交行就渲染清单，只有 1 个文件时也渲染", () => {
  assert.equal(shouldShowCommitFileList([]), false);
  assert.equal(
    shouldShowCommitFileList([previewFile("/repo/src/a.ts", { repoRelativePath: "src/a.ts" })]),
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

test("预览文件保留 isUntracked，未跟踪与已暂存同路径时按已跟踪处理", () => {
  const [untrackedPreview] = buildGitBranchCommitPreviewFiles([
    gitFileChange({ repoRelativePath: "src/new.ts", section: "untracked", isUntracked: true }),
  ]);
  assert.equal(untrackedPreview?.isUntracked, true);

  // `??` 只可能来自 unstaged 源；一旦同一路径也出现在 staged 源，说明文件已进入版本管理。
  const [mergedPreview] = buildGitBranchCommitPreviewFiles([
    gitFileChange({ repoRelativePath: "src/new.ts", section: "untracked", isUntracked: true }),
    gitFileChange({ repoRelativePath: "src/new.ts", section: "staged", isStaged: true }),
  ]);
  assert.equal(mergedPreview?.isUntracked, false);
  assert.equal(mergedPreview?.added, 2);
});
