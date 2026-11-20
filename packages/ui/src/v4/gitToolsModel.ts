import type { GitRepositorySummary } from "@zcode/shared";
import { canPullGitBranch, canPushGitBranch } from "@/git-action-menu/display.js";
import { shouldShowGitToolsEntry } from "@/v4/gitToolsEntryVisibility.js";

/**
 * Git 工具的单一模型。
 *
 * 标题栏 Git 图标、徽标与浮层必须读同一份事实：入口是否出现、主按钮是否可推/可拉、
 * 徽标选哪一条摘要，都从这里派生，避免多处各算一次可见性。
 * 该模型由 `WorkspaceShellLayout` 调用一次 `buildGitToolsModel` 生成。
 */
export interface GitToolsModel {
  /** 供分支切换/提交/拉取复用；不再从状态面板模型透传。 */
  summary: GitRepositorySummary;
  dirtyFileCount: number;
  added: number;
  removed: number;
  /** 与「推送」项启用条件同一判据（canPushGitBranch）。 */
  hasPushableCommits: boolean;
  /** 与「拉取」项启用条件同一判据（canPullGitBranch）。 */
  canPull: boolean;
  isClean: boolean;
}

/**
 * 构建 Git 工具模型；不可见时返回 null。
 *
 * 可见性判据完全复用 `shouldShowGitToolsEntry`，可推送/可拉取分别由
 * `canPushGitBranch` / `canPullGitBranch` 计算后传入，UI 不复制判定。
 * Office 模式不产出 Git 工具（标题栏图标、徽标与浮层同时消失）。
 */
export function buildGitToolsModel(input: {
  isOfficeMode?: boolean;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
}): GitToolsModel | null {
  if (input.isOfficeMode) {
    return null;
  }
  const summary = input.gitSummary;
  if (!summary) {
    return null;
  }

  const dirtyFileCount = input.gitDirtyFileCount ?? 0;
  const added = input.gitWorktreeChangeSummary?.added ?? 0;
  const removed = input.gitWorktreeChangeSummary?.removed ?? 0;
  const hasPushableCommits = canPushGitBranch(summary);
  const canPull = canPullGitBranch(summary);
  const shouldShow = shouldShowGitToolsEntry({
    gitSummary: summary,
    dirtyFileCount,
    added,
    removed,
    hasPushableCommits,
    behind: summary.behind,
    canPull,
  });
  if (!shouldShow) {
    return null;
  }

  const isClean =
    !summary.isDirty && dirtyFileCount === 0 && added === 0 && removed === 0 && summary.ahead === 0;

  return {
    summary,
    dirtyFileCount,
    added,
    removed,
    hasPushableCommits,
    canPull,
    isClean,
  };
}

export type GitToolsBadgeKind = "changes" | "pushable" | "behind" | "synced";

export interface GitToolsBadge {
  kind: GitToolsBadgeKind;
  /** changes: dirtyFileCount；pushable: ahead；behind: behind；synced: null。 */
  count: number | null;
}

/**
 * 标题栏 Git 图标徽标的唯一摘要实现，按优先级命中即停止：
 * changes → pushable → behind → synced。
 *
 * 徽标只承担「有事可做、有多少」：`changes` 用未提交文件数（纯二进制/0 行改动也算），
 * 不再展示 `+N -M`；行级增减去浮层内看。不可见时返回 null。
 */
export function resolveGitToolsBadge(model: GitToolsModel | null): GitToolsBadge | null {
  if (!model) {
    return null;
  }
  if (model.dirtyFileCount > 0 || model.added + model.removed > 0) {
    return { kind: "changes", count: model.dirtyFileCount };
  }
  if (model.hasPushableCommits) {
    return { kind: "pushable", count: model.summary.ahead };
  }
  if (model.summary.behind > 0) {
    return { kind: "behind", count: model.summary.behind };
  }
  if (model.canPull) {
    return { kind: "synced", count: null };
  }
  return null;
}
