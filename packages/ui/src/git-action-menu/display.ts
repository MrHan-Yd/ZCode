import type { GitRepositorySummary } from "@zcode/shared";
import type { GitBranchCommitPreviewFile } from "@/git-branch-switcher/display.js";

type GitActionMenuPrimaryActionId = "commit" | "push";

export function canUseGitActionMenu(
  summary: Pick<GitRepositorySummary, "isGitAvailable" | "isRepository">,
): boolean {
  return summary.isGitAvailable && summary.isRepository;
}

export function resolveGitActionMenuPrimaryAction(options: {
  actionAvailable: boolean;
  commitEnabled: boolean;
  pushEnabled: boolean;
}): GitActionMenuPrimaryActionId | null {
  // 关键业务逻辑：主按钮只承载提交或推送；创建分支保留在下拉菜单里。
  // 这样干净仓库仍可通过菜单创建分支，但不会把“提交或推送”误触发为创建分支。
  if (options.actionAvailable && options.commitEnabled) {
    return "commit";
  }

  if (options.actionAvailable && options.pushEnabled) {
    return "push";
  }

  return null;
}

export function canPushGitBranch(
  summary: Pick<
    GitRepositorySummary,
    "headRefType" | "branchName" | "trackingBranchName" | "ahead"
  >,
): boolean {
  const branchName = summary.branchName?.trim() ?? "";
  if (summary.headRefType !== "branch" || branchName.length === 0) {
    return false;
  }

  return !summary.trackingBranchName || summary.ahead > 0;
}

/**
 * 同一个文件可能同时出现在 staged 与 unstaged。提交弹窗按 `stagePath` 去重，
 * 否则同一路径会渲染两行勾选，取消其中一行后另一行仍会把它带回提交范围。
 */
export function dedupeCommitPreviewFiles(
  files: readonly GitBranchCommitPreviewFile[],
): GitBranchCommitPreviewFile[] {
  const fileByStagePath = new Map<string, GitBranchCommitPreviewFile>();
  for (const file of files) {
    if (!fileByStagePath.has(file.stagePath)) {
      fileByStagePath.set(file.stagePath, file);
    }
  }

  return Array.from(fileByStagePath.values()).sort((left, right) =>
    left.repoRelativePath.localeCompare(right.repoRelativePath),
  );
}

export function excludeCommitPreviewFiles(
  files: readonly GitBranchCommitPreviewFile[],
  excludedPaths: ReadonlySet<string>,
): GitBranchCommitPreviewFile[] {
  if (excludedPaths.size === 0) {
    return [...files];
  }

  return files.filter((file) => !excludedPaths.has(file.stagePath));
}

export function collectCommitPreviewStagePaths(
  files: readonly GitBranchCommitPreviewFile[],
): string[] {
  // 与 GitCommitRequest.paths 同一坐标系；重复路径只会拉长 git 参数列表，这里统一去重。
  return Array.from(new Set(files.map((file) => file.stagePath)));
}

export function resolveCommitPreviewSelectionState(
  files: readonly GitBranchCommitPreviewFile[],
  excludedPaths: ReadonlySet<string>,
): "all" | "partial" | "none" {
  const selectedCount = files.reduce(
    (count, file) => (excludedPaths.has(file.stagePath) ? count : count + 1),
    0,
  );

  if (selectedCount === 0) {
    return "none";
  }

  return selectedCount === files.length ? "all" : "partial";
}

/**
 * 提交弹窗行宽有限，长路径必须能被截断，但**文件名不能被截掉**——同名文件分布在不同目录时，
 * 文件名才是区分依据。所以把路径拆成「目录（可截断）+ 文件名（优先保留）」两段渲染。
 */
export function splitCommitPreviewFilePath(repoRelativePath: string): {
  directory: string;
  fileName: string;
} {
  const normalizedPath = repoRelativePath.replace(/\\/g, "/");
  const lastSeparatorIndex = normalizedPath.lastIndexOf("/");
  if (lastSeparatorIndex < 0) {
    return { directory: "", fileName: normalizedPath };
  }

  return {
    directory: normalizedPath.slice(0, lastSeparatorIndex),
    fileName: normalizedPath.slice(lastSeparatorIndex + 1),
  };
}
