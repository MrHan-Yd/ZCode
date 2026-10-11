import type { GitPullIssueCode, GitRepositorySummary } from "@zcode/shared";
import { isGitPullIssueCode } from "@zcode/shared";
import type { GitBranchCommitPreviewFile } from "@/git-branch-switcher/display.js";

type GitActionMenuPrimaryActionId = "commit" | "push" | "pull";

export function canUseGitActionMenu(
  summary: Pick<GitRepositorySummary, "isGitAvailable" | "isRepository">,
): boolean {
  return summary.isGitAvailable && summary.isRepository;
}

export function resolveGitActionMenuPrimaryAction(options: {
  actionAvailable: boolean;
  commitEnabled: boolean;
  pushEnabled: boolean;
  pullEnabled: boolean;
}): GitActionMenuPrimaryActionId | null {
  // 关键业务逻辑：主按钮只承载提交或推送；创建分支保留在下拉菜单里。
  // 这样干净仓库仍可通过菜单创建分支，但不会把“提交或推送”误触发为创建分支。
  if (options.actionAvailable && options.commitEnabled) {
    return "commit";
  }

  if (options.actionAvailable && options.pushEnabled) {
    return "push";
  }

  // 干净工作区 + 落后远端时既选不出提交也选不出推送。这里补上拉取，
  // 否则主按钮会置灰，而"落后远端"正是唯一该做的事。
  if (options.actionAvailable && options.pullEnabled) {
    return "pull";
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
 * 能否拉取。要求当前分支存在上游分支——没有上游就无法确定拉取目标。
 *
 * 刻意不看 `behind`：它来自上一次 fetch 的本地快照，可能已经过期；真正有没有东西
 * 要拉，以 `git pull` 的结果为准（无更新会返回 `updated: false`）。
 */
export function canPullGitBranch(
  summary: Pick<GitRepositorySummary, "headRefType" | "branchName" | "trackingBranchName">,
): boolean {
  const branchName = summary.branchName?.trim() ?? "";
  const trackingBranchName = summary.trackingBranchName?.trim() ?? "";
  return summary.headRefType === "branch" && branchName.length > 0 && trackingBranchName.length > 0;
}

/** 从跨 RPC 传回的异常上读拉取失败码。读不到或不是已知码时返回 null，由调用方回落到原始信息。 */
export function readGitPullIssueCode(error: unknown): GitPullIssueCode | null {
  const code = (error as { code?: unknown } | null)?.code;
  return isGitPullIssueCode(code) ? code : null;
}

/**
 * 拉取失败码到本地化文案 key 的映射。`unknown` 没有对应文案，
 * 由调用方展示原始 Git 输出（比一句笼统的"拉取失败"更有诊断价值）。
 */
export function resolveGitPullErrorMessageId(code: GitPullIssueCode | null): string | null {
  switch (code) {
    case "no-remote":
      return "git.actionMenu.pullDialog.error.noRemote";
    case "no-upstream":
      return "git.actionMenu.pullDialog.error.noUpstream";
    case "detached-head":
      return "git.actionMenu.pullDialog.error.detachedHead";
    case "dirty-working-tree":
      return "git.actionMenu.pullDialog.error.dirtyWorkingTree";
    case "merge-conflict":
      return "git.actionMenu.pullDialog.error.mergeConflict";
    case "diverged":
      return "git.actionMenu.pullDialog.error.diverged";
    case "authentication-failed":
      return "git.actionMenu.pullDialog.error.authenticationFailed";
    case "network-error":
      return "git.actionMenu.pullDialog.error.networkError";
    case "timeout":
      return "git.actionMenu.pullDialog.error.timeout";
    case "operation-in-progress":
      return "git.actionMenu.pullDialog.error.operationInProgress";
    case "upstream-branch-missing":
      return "git.actionMenu.pullDialog.error.upstreamBranchMissing";
    default:
      return null;
  }
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
 * 清单是唯一展示待提交文件路径的地方：只要还有可提交文件就必须渲染，只有 1 个文件时也不例外。
 * 曾经按「多于 1 个文件」隐藏清单，导致单文件场景下用户只能看到数量、看不到文件名。
 */
export function shouldShowCommitFileList(files: readonly GitBranchCommitPreviewFile[]): boolean {
  return files.length > 0;
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
