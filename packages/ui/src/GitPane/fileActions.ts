import type { GitChangeKind } from "@zcode/shared";

export interface GitPaneFileActionAvailability {
  stage: boolean;
  unstage: boolean;
  discard: boolean;
}

/**
 * 单个文件的 Git 写操作可用性。渲染与测试共用这一份规则，避免两边各写一套。
 *
 * - 只读来源（与分支比较 / 某轮会话快照的数据集）不提供任何写操作。
 * - `discard` 走 `git restore --worktree`，对未跟踪与不在 HEAD 里的新增文件会失败；
 *   而"撤销"一个未跟踪文件的实际语义是删除磁盘文件且不可恢复，属于另一套能力，一律禁用。
 *
 * 本模块刻意不引入任何运行时依赖（只用 type import），这样规则可以被单测直接加载。
 */
export function resolveGitPaneFileActions(options: {
  readonly: boolean;
  kind: GitChangeKind;
  isStaged: boolean;
  isUntracked: boolean;
  pending: boolean;
}): GitPaneFileActionAvailability {
  if (options.readonly || options.pending) {
    return { stage: false, unstage: false, discard: false };
  }

  const canDiscardUnstaged = !options.isUntracked && options.kind !== "added";
  return {
    stage: !options.isStaged,
    unstage: options.isStaged,
    discard: !options.isStaged && canDiscardUnstaged,
  };
}
