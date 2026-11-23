import type { GitRefreshRequest, GitRefreshResult } from "@zcode/shared";

export type GitRepositoryRefreshFlags = Pick<
  GitRefreshRequest,
  "includeIdentity" | "includeBranchComparison"
>;

export type GitRepositoryRefresh = (flags?: GitRepositoryRefreshFlags) => Promise<GitRefreshResult>;

export class GitRepositoryRefreshInvalidatedError extends Error {
  constructor() {
    super("Git repository refresh scope is no longer active");
    this.name = "GitRepositoryRefreshInvalidatedError";
  }
}

interface GitRepositoryRefreshCoordinatorOptions {
  workspacePath: string;
  read: (request: GitRefreshRequest) => Promise<GitRefreshResult>;
  publish: (result: GitRefreshResult, sequence: number) => void;
  isCurrent?: () => boolean;
  initialSequence?: number;
  onStart?: (sequence: number) => void;
  onError?: (error: unknown, sequence: number) => void;
}

interface RefreshIntent {
  flags: Required<GitRepositoryRefreshFlags>;
  completion: ReturnType<typeof Promise.withResolvers<GitRefreshResult>>;
}

function createRefreshIntent(flags: GitRepositoryRefreshFlags = {}): RefreshIntent {
  return {
    flags: {
      includeIdentity: Boolean(flags.includeIdentity),
      includeBranchComparison: Boolean(flags.includeBranchComparison),
    },
    completion: Promise.withResolvers<GitRefreshResult>(),
  };
}

export function createGitRepositoryRefreshCoordinator(
  options: GitRepositoryRefreshCoordinatorOptions,
): { refresh: GitRepositoryRefresh; dispose: () => void } {
  let disposed = false;
  let sequence = options.initialSequence ?? 0;
  let inflight: RefreshIntent | null = null;
  let pending: RefreshIntent | null = null;

  const isCurrent = () => !disposed && (options.isCurrent?.() ?? true);

  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    const error = new GitRepositoryRefreshInvalidatedError();
    // 作用域失效时 await 也必须结束，不能只丢弃发布而把弹窗永久留在 loading。
    inflight?.completion.reject(error);
    pending?.completion.reject(error);
    inflight = null;
    pending = null;
  };

  const launch = async (intent: RefreshIntent) => {
    inflight = intent;
    // 序号只随真正的读取推进；排队不作废正在返回的有效快照，避免连续事件饿死发布。
    const requestSequence = ++sequence;
    try {
      options.onStart?.(requestSequence);
      const result = await options.read({ workspacePath: options.workspacePath, ...intent.flags });
      if (!isCurrent()) {
        dispose();
        return;
      }
      options.publish(result, requestSequence);
      intent.completion.resolve(result);
    } catch (error: unknown) {
      if (!isCurrent()) {
        dispose();
        return;
      }
      intent.completion.reject(error);
      options.onError?.(error, requestSequence);
    } finally {
      if (inflight === intent) {
        inflight = null;
      }
      if (!isCurrent()) {
        dispose();
      } else if (pending) {
        const next = pending;
        pending = null;
        void launch(next);
      }
    }
  };

  const refresh: GitRepositoryRefresh = (flags = {}) => {
    if (!isCurrent()) {
      dispose();
      return Promise.reject(new GitRepositoryRefreshInvalidatedError());
    }

    if (inflight) {
      // 读取发出后的意图必须进入下一次读取，不能复用操作前已在途的 snapshot。
      if (pending) {
        pending.flags.includeIdentity ||= Boolean(flags.includeIdentity);
        pending.flags.includeBranchComparison ||= Boolean(flags.includeBranchComparison);
      } else {
        pending = createRefreshIntent(flags);
      }
      return pending.completion.promise;
    }

    const intent = createRefreshIntent(flags);
    void launch(intent);
    return intent.completion.promise;
  };

  return { refresh, dispose };
}
