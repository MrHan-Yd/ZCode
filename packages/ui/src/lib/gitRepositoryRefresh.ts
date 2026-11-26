import type { GitRefreshRequest, GitRefreshResult, GitRepositorySummary } from "@zcode/shared";

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

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  // RPC 在部分通道上以裸对象拒绝（PromiseErrorObj），只认 Error 会漏掉这类超时。
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

/**
 * 只有 Git 命令超时属于「本机瞬时负载」：冷启动、杀毒扫描或磁盘抖动会把单条
 * `git diff --numstat` 拖过 15s 上限。这类失败短暂退避后重读一次即可恢复；
 * 权限、路径失效、仓库损坏等错误重试只会拖慢报错，因此不在这里重试。
 */
export function isGitRefreshTimeoutError(error: unknown): boolean {
  return /timed out after \d+ms/i.test(readErrorMessage(error));
}

/**
 * 读取失败时能否沿用上一次成功快照。
 *
 * 失败不代表「不是仓库」：保留 summary 才能让标题栏 Git 入口、徽标与面板数据
 * 不因一次超时消失（见 `specs/git-tools-entry-visibility.md` 规则 10）。
 */
export function shouldKeepGitRepositorySnapshot(
  summary: Pick<GitRepositorySummary, "isGitAvailable" | "isRepository">,
): boolean {
  return summary.isGitAvailable && summary.isRepository;
}

export interface GitRepositoryRefreshRetryPolicy {
  /** 第 n 次失败后等待多久再重试；长度即最大重试次数（不含首次尝试）。 */
  delaysMs: readonly number[];
  /**
   * 是否重试该错误。必填：默认放行所有错误会把权限、仓库损坏等长期失败
   * 一起拖进重试循环，调用方必须显式声明哪些错误属于瞬时失败。
   */
  isRetryable: (error: unknown) => boolean;
}

interface GitRepositoryRefreshCoordinatorOptions {
  workspacePath: string;
  read: (request: GitRefreshRequest) => Promise<GitRefreshResult>;
  publish: (result: GitRefreshResult, sequence: number) => void;
  isCurrent?: () => boolean;
  initialSequence?: number;
  onStart?: (sequence: number) => void;
  onError?: (error: unknown, sequence: number) => void;
  retry?: GitRepositoryRefreshRetryPolicy;
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
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let releaseRetryWait: (() => void) | null = null;

  const isCurrent = () => !disposed && (options.isCurrent?.() ?? true);

  // 退避等待必须可被 dispose 立即打断：scope 切换后不能因为旧定时器再发一次 Git 读取，
  // 也不能把测试或切换流程拖到退避结束。
  const clearRetryWait = () => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    const release = releaseRetryWait;
    releaseRetryWait = null;
    release?.();
  };

  const waitForRetry = (delayMs: number) =>
    new Promise<void>((resolve) => {
      releaseRetryWait = resolve;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        releaseRetryWait = null;
        resolve();
      }, delayMs);
    });

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
    clearRetryWait();
  };

  const launch = async (intent: RefreshIntent) => {
    inflight = intent;
    const retryDelays = options.retry?.delaysMs ?? [];
    const isRetryable = options.retry?.isRetryable;
    for (let attempt = 0; ; attempt += 1) {
      // 序号只随真正的读取推进；排队不作废正在返回的有效快照，避免连续事件饿死发布。
      const requestSequence = ++sequence;
      try {
        options.onStart?.(requestSequence);
        const result = await options.read({
          workspacePath: options.workspacePath,
          ...intent.flags,
        });
        if (!isCurrent()) {
          dispose();
          return;
        }
        options.publish(result, requestSequence);
        intent.completion.resolve(result);
        break;
      } catch (error: unknown) {
        if (!isCurrent()) {
          dispose();
          return;
        }
        const delayMs = retryDelays[attempt];
        if (delayMs === undefined || !isRetryable?.(error)) {
          intent.completion.reject(error);
          options.onError?.(error, requestSequence);
          break;
        }
        // 一次瞬时失败不能把 Git 入口永久藏掉（只能切 workspace 才能恢复）。
        await waitForRetry(delayMs);
        if (!isCurrent()) {
          dispose();
          return;
        }
      }
    }
    if (!isCurrent()) {
      dispose();
      return;
    }
    if (inflight === intent) {
      inflight = null;
    }
    if (pending) {
      const next = pending;
      pending = null;
      void launch(next);
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
