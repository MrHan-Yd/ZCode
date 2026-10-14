import type { GitFileChange, GitPullIssueCode, GitRepositorySummary } from "@zcode/shared";
import { isGitPullIssueCode } from "@zcode/shared";
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
  // 拉取不在这里：它在 Git 工具里是独立一行（GitPullAction），
  // 不需要藏在「提交或推送」这个按钮后面。
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

/** 行 key 只要 `stagePath`，所以选择/排除类纯函数对「行」和「预览文件」都成立。 */
interface CommitStagePathHolder {
  stagePath: string;
}

export function excludeCommitPreviewFiles<T extends CommitStagePathHolder>(
  files: readonly T[],
  excludedPaths: ReadonlySet<string>,
): T[] {
  if (excludedPaths.size === 0) {
    return [...files];
  }

  return files.filter((file) => !excludedPaths.has(file.stagePath));
}

export function collectCommitPreviewStagePaths(
  files: readonly CommitStagePathHolder[],
): string[] {
  // 与 GitCommitRequest.paths 同一坐标系；重复路径只会拉长 git 参数列表，这里统一去重。
  return Array.from(new Set(files.map((file) => file.stagePath)));
}

export function resolveCommitPreviewSelectionState(
  files: readonly CommitStagePathHolder[],
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
export function shouldShowCommitFileList(files: readonly CommitStagePathHolder[]): boolean {
  return files.length > 0;
}

export type GitCommitFileGroupId = "staged" | "changes" | "untracked";

/** 组间顺序固定：先看已暂存的，再看未暂存的已跟踪改动，最后是未跟踪文件。 */
const COMMIT_FILE_GROUP_ORDER: readonly GitCommitFileGroupId[] = [
  "staged",
  "changes",
  "untracked",
];

export interface GitCommitFileRow {
  stagePath: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  kind: GitFileChange["kind"];
  group: GitCommitFileGroupId;
  /**
   * 索引里已暂存、但工作区还有未纳入本次提交的改动。
   * 这类行只能按索引内容提交：一旦对它 `git add`，没勾选的余量也会被带进提交。
   */
  hasUnstagedRemainder: boolean;
  added: number;
  removed: number;
}

export interface GitCommitFileGroup {
  id: GitCommitFileGroupId;
  files: GitCommitFileRow[];
}

/**
 * 把两份 per-source 预览合成提交清单的行。
 *
 * 归属互斥（同一路径只占一行，不准在两处各出现一次）：**索引里有改动的文件只进
 * 「已暂存的更改」**，哪怕它同时还有未暂存的修改——那部分用 `hasUnstagedRemainder`
 * 标记，而不是再渲染一行。因为这个约束，未暂存的余量不会出现在清单里，只提交余量
 * 需要先在 Git 面板把它暂存。
 *
 * 判定"同一文件"用的是 `stagePath`：两份 per-source 预览由同一个 `git status` 条目
 * 派生（`toAbsolutePath(repoRoot, entry.path)`），所以同一文件的 staged / unstaged
 * 记录 `stagePath` 必然相同。
 *
 * 索引里没有改动的文件才按跟踪状态分流：未跟踪进「未进行版本管理的文件」，其余进「更改」。
 * 空组由 `groupCommitFileRows` 过滤；这里保证行按 repo 相对路径有序。
 */
export function buildCommitFileRows(options: {
  stagedFiles: readonly GitBranchCommitPreviewFile[];
  unstagedFiles: readonly GitBranchCommitPreviewFile[];
}): GitCommitFileRow[] {
  const stagedStagePaths = new Set(options.stagedFiles.map((file) => file.stagePath));
  const unstagedStagePaths = new Set(options.unstagedFiles.map((file) => file.stagePath));
  const rows: GitCommitFileRow[] = [];

  for (const file of options.stagedFiles) {
    rows.push({
      stagePath: file.stagePath,
      repoRelativePath: file.repoRelativePath,
      workspaceRelativePath: file.workspaceRelativePath,
      kind: file.kind,
      group: "staged",
      hasUnstagedRemainder: unstagedStagePaths.has(file.stagePath),
      added: file.added,
      removed: file.removed,
    });
  }

  for (const file of options.unstagedFiles) {
    if (stagedStagePaths.has(file.stagePath)) {
      continue;
    }

    rows.push({
      stagePath: file.stagePath,
      repoRelativePath: file.repoRelativePath,
      workspaceRelativePath: file.workspaceRelativePath,
      kind: file.kind,
      group: file.isUntracked ? "untracked" : "changes",
      hasUnstagedRemainder: false,
      added: file.added,
      removed: file.removed,
    });
  }

  return rows.sort((left, right) => left.repoRelativePath.localeCompare(right.repoRelativePath));
}

/**
 * 按固定顺序分组，空组直接过滤掉：出现一个点了没有任何内容的空表头比不显示更容易误导。
 * 组内顺序沿用入参顺序（`buildCommitFileRows` 已按 repo 相对路径排好），这里不再重排。
 */
export function groupCommitFileRows(rows: readonly GitCommitFileRow[]): GitCommitFileGroup[] {
  return COMMIT_FILE_GROUP_ORDER.map((id) => ({
    id,
    files: rows.filter((row) => row.group === id),
  })).filter((group) => group.files.length > 0);
}

export interface GitCommitRequestMode {
  /** 本次提交涉及的全部路径（`GitCommitRequest.paths`）。 */
  paths: string[];
  /** 需要先 `git add` 的路径：提交它们工作区当前的内容。 */
  worktreePaths: string[];
  /** 只提交索引里已暂存内容的路径；同时用于把生成消息的 diff 限制在已暂存那份。 */
  stagedPaths: string[];
  /** 是否走"只提交索引内容"的提交实现（`GitCommitRequest.stagedOnly`）。 */
  stagedOnly: boolean;
}

/**
 * 从勾选后的行推导提交请求参数。
 *
 * `paths` 每行一路径，所以天然去重。两种模式共存的可行性来自：`git add` 只作用于
 * `worktreePaths`，索引模式路径的索引内容原样保留，之后一次性提交这批路径。
 *
 * `stagedOnly` 的取值刻意保留快路径：没有任何部分暂存时 `worktreePaths` 非空且
 * `stagedPaths` 为空，落到普通 `git add` + pathspec 提交（与改动前一致）；只有在
 * "没有任何要 add 的路径"或"存在带余量的已暂存行"时才需要 plumbing。
 */
export function resolveCommitRequestMode(
  rows: readonly GitCommitFileRow[],
): GitCommitRequestMode {
  const worktreePaths = rows.filter((row) => row.group !== "staged").map((row) => row.stagePath);
  const stagedPaths = rows
    .filter((row) => row.group === "staged" && row.hasUnstagedRemainder)
    .map((row) => row.stagePath);

  return {
    paths: rows.map((row) => row.stagePath),
    worktreePaths,
    stagedPaths,
    stagedOnly: worktreePaths.length === 0 || stagedPaths.length > 0,
  };
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
