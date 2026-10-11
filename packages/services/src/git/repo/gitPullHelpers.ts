import type { GitPullIssueCode } from "@zcode/shared";
import type { GitLineStat } from "./gitCliTypes.js";

/**
 * 拉取失败的分类与文案。
 *
 * 放在纯函数里而不是内联在 repo 中，是因为这些模式串是这次改动里最容易回归的部分：
 * Git 的 stderr 文案随版本和场景变化，需要能直接对着样本断言。
 * 识别不出来的失败回落到 `unknown`，由 UI 展示原始 Git 输出。
 */
export type KnownGitPullIssueCode = Exclude<GitPullIssueCode, "unknown">;

export interface GitPullFailure {
  code: GitPullIssueCode;
  /** 面向用户的一句话说明（英文兜底；UI 按 code 覆盖为本地化文案）。 */
  message: string;
  /** 原始 Git 输出，放进错误详情供排查；没有输出时为空串。 */
  detail: string;
}

/** 非 `unknown` 的失败码到英文文案的映射。UI 只按 code 取本地化文案，这里只是无 UI 场景的兜底。 */
export const GIT_PULL_ISSUE_MESSAGES: Record<KnownGitPullIssueCode, string> = {
  "merge-conflict":
    "The pull stopped because of merge conflicts. Resolve the conflicts, then commit the merge.",
  "operation-in-progress":
    "Another Git merge or rebase is already in progress. Finish or abort it before pulling.",
  diverged:
    "The branch and its upstream have diverged. Configure a merge or rebase strategy (pull.rebase / pull.ff) or reconcile them manually.",
  "dirty-working-tree":
    "Local changes would be overwritten by the pull. Commit or stash them first.",
  "authentication-failed":
    "Authentication or permission was rejected by the remote. Check your credentials or SSH key.",
  "network-error":
    "Could not reach the remote repository. Check your network connection and try again.",
  // 超时在分类之前单独判定（命令 `timedOut` 时 stderr 往往是空的），
  // 但文案和其它失败码放在一起，避免两处维护。
  timeout: "The pull timed out. Check your network connection and try again.",
  // 覆盖两种情况：仓库没有任何 remote，或 remote 的 URL 指向一个不是 Git 仓库的位置
  // （Git 对后者同样报 "does not appear to be a git repository"）。
  "no-remote": "The repository has no usable Git remote, so there is nothing to pull from.",
  "no-upstream": "The current branch has no upstream tracking branch. Push it first to set one.",
  "detached-head": "Cannot pull while HEAD is detached.",
};

interface GitPullIssueRule {
  code: KnownGitPullIssueCode;
  pattern: RegExp;
}

/**
 * 匹配顺序即优先级：conflict 与 diverged 的提示里都可能带上 "merge"，
 * 但它们的处理动作完全不同，先判更具体的。
 */
const GIT_PULL_ISSUE_RULES: readonly GitPullIssueRule[] = [
  {
    code: "merge-conflict",
    // 第二次拉取时 Git 不再重复打 CONFLICT，而是直接说「有未合并的文件」——
    // 引导动作和首次冲突完全一样（解决冲突后提交），所以归到同一个码。
    pattern:
      /automatic merge failed|conflict \(|fix conflicts|merge conflict in|unmerged paths|unmerged files|unresolved conflict|pulling is not possible because you have unmerged/i,
  },
  {
    code: "operation-in-progress",
    pattern:
      /you have not concluded your merge|merge_head exists|rebase in progress|a cherry-pick or revert is already in progress|you are in the middle of/i,
  },
  {
    code: "diverged",
    pattern: /need to specify how to reconcile divergent branches|not possible to fast-forward/i,
  },
  {
    code: "dirty-working-tree",
    pattern:
      /local changes to the following files would be overwritten|commit your changes or stash them|cannot pull with rebase: you have unstaged changes|your local changes to the following files/i,
  },
  {
    code: "authentication-failed",
    pattern:
      /authentication failed|could not read username|could not read password|permission denied \(publickey\)|access denied|invalid username or password|terminal prompts disabled|the requested url returned error: 40[13]/i,
  },
  {
    code: "network-error",
    pattern:
      /could not resolve host|unable to access|couldn't connect|failed to connect|connection timed out|connection refused|operation timed out|network is unreachable|ssl certificate problem|rpc failed|early eof|proxy connect/i,
  },
  {
    code: "no-remote",
    pattern:
      /no remote repository specified|does not appear to be a git repository|no such remote/i,
  },
  {
    code: "no-upstream",
    pattern: /there is no tracking information|no upstream configured for branch/i,
  },
  {
    code: "detached-head",
    pattern: /you are not currently on a branch|detached head/i,
  },
];

function toRawOutput(stderr: string, stdout: string, exitCode: number | null): string {
  return stderr.trim() || stdout.trim() || `exitCode=${exitCode ?? "null"}`;
}

export function classifyGitPullFailure(input: {
  stderr: string;
  stdout: string;
  exitCode: number | null;
}): GitPullFailure {
  const haystack = `${input.stderr}\n${input.stdout}`;
  const detail = toRawOutput(input.stderr, input.stdout, input.exitCode);
  for (const rule of GIT_PULL_ISSUE_RULES) {
    if (rule.pattern.test(haystack)) {
      return { code: rule.code, message: GIT_PULL_ISSUE_MESSAGES[rule.code], detail };
    }
  }

  return { code: "unknown", message: "git pull failed.", detail };
}

/**
 * 错误正文 = 一句话说明 + 原始 Git 输出。
 * 只留那句话会丢掉 git 列出的冲突文件、被覆盖的路径等关键线索，
 * 而弹窗的「错误详情」是唯一能承载这些原始信息的地方。
 */
export function formatGitPullErrorMessage(failure: GitPullFailure): string {
  return failure.detail ? `${failure.message}\n\n${failure.detail}` : failure.message;
}

/**
 * 带 code 的错误。code 是 UI 选择本地化文案的唯一依据，必须随 Error 一起跨 RPC 传出去；
 * 本地（同进程）调用时也走同一条路径，不额外做分支。
 */
export function createGitPullError(code: GitPullIssueCode, message: string): Error {
  const error = new Error(message);
  error.name = "GitPullError";
  (error as Error & { code: GitPullIssueCode }).code = code;
  return error;
}

export interface GitPullDiffTotals {
  fileCount: number;
  added: number;
  removed: number;
}

/** 把 `diff --numstat` 的逐文件结果聚合成弹窗要展示的总量。 */
export function aggregateGitPullDiffTotals(stats: Map<string, GitLineStat>): GitPullDiffTotals {
  let added = 0;
  let removed = 0;
  for (const stat of stats.values()) {
    added += stat.added;
    removed += stat.removed;
  }

  return { fileCount: stats.size, added, removed };
}

/**
 * 本次 pull 是否真的改变了当前分支。用 HEAD 差集而不是远程跟踪引用：
 * 若调用前已经 fetch 过，跟踪引用不会再移动，但 pull 仍会快进 HEAD，
 * 只比跟踪引用会把这种情况误报成「已是最新」。
 */
export function isGitPullUpdated(headBefore: string | null, headAfter: string | null): boolean {
  return Boolean(headBefore && headAfter && headBefore !== headAfter);
}
