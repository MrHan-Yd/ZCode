import type { GitRepositorySummary } from "@zcode/shared";

/**
 * 右上角 Git 工具入口是否显示。判据是「**真的无事可做**才隐藏」，而不是「工作区有没有未提交改动」。
 *
 * 起因：入口过去只看 worktree 的行级增减，提交之后工作区变干净，整块 Git 工具（含「推送」）就消失了 ——
 * 而这是全 UI 唯一的提交/推送入口，用户提交完反而无处推送。同理，纯二进制改动或有文件数但行数为 0
 * 的改动也会让入口消失，那时用户仍需要提交它们。
 *
 * 本模块刻意不含运行时依赖（只用 type import），便于单测直接加载；可推送性由调用方用
 * `canPushGitBranch` 算好传入，避免这里复制第二套判定。
 */
export function shouldShowGitToolsEntry(options: {
  gitSummary: Pick<GitRepositorySummary, "isGitAvailable" | "isRepository">;
  /** 未提交文件数（按 path 去重），覆盖行级增减为 0 的二进制/未跟踪改动。 */
  dirtyFileCount: number;
  added: number;
  removed: number;
  /** 是否还有可推送的提交，由调用方按 `canPushGitBranch` 判定。 */
  hasPushableCommits: boolean;
  behind: number;
}): boolean {
  if (!options.gitSummary.isGitAvailable || !options.gitSummary.isRepository) {
    return false;
  }

  const hasWorktreeChanges = options.dirtyFileCount > 0 || options.added + options.removed > 0;
  const hasRemoteWork = options.hasPushableCommits || options.behind > 0;
  return hasWorktreeChanges || hasRemoteWork;
}

/**
 * 收起态胶囊是否显示「远程待办」摘要（未推送提交 / 落后远端）。
 *
 * auto 形态在容器不足 1280px 时只显示胶囊，点胶囊才展开面板——而那正是唯一能点「推送」的地方。
 * 所以"干净但有待推送提交"时胶囊必须给出可点内容，否则入口等于不存在。
 * 工作区已有行级增减时由「+/- 变更」摘要表达，这里不重复。
 */
export function shouldShowGitRemoteSummary(options: {
  added: number;
  removed: number;
  hasPushableCommits: boolean;
  behind: number;
}): boolean {
  if (options.added + options.removed > 0) {
    return false;
  }

  return options.hasPushableCommits || options.behind > 0;
}
