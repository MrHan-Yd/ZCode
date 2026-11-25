import type { GitRepositorySummary } from "@zcode/shared";

/** Git 图谱是只读仓库操作；有效仓库即保留入口，不因干净或 detached HEAD 隐藏。 */
export function shouldShowGitToolsEntry(options: {
  gitSummary: Pick<GitRepositorySummary, "isGitAvailable" | "isRepository">;
  /** 未提交文件数（按 path 去重），覆盖行级增减为 0 的二进制/未跟踪改动。 */
  dirtyFileCount: number;
  added: number;
  removed: number;
  /** 是否还有可推送的提交，由调用方按 `canPushGitBranch` 判定。 */
  hasPushableCommits: boolean;
  behind: number;
  /** 保留旧调用的摘要参数；图谱入口是否可见不再取决于远程计数。 */
  canPull: boolean;
}): boolean {
  return options.gitSummary.isGitAvailable && options.gitSummary.isRepository;
}
