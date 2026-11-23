import type { GitRepositorySummary, SystemInfo } from "@zcode/shared";

interface GitAutoRefreshWatchPath {
  path: string;
  recursive: boolean;
}

const GIT_AUTO_REFRESH_QUIET_MS = 350;
const GIT_AUTO_REFRESH_MAX_WAIT_MS = 2000;

export function createGitAutoRefreshScheduler(onRefresh: (path: string) => void): {
  schedule: (path: string) => void;
  dispose: () => void;
} {
  let disposed = false;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  let latestPath: string | null = null;

  const clearTimers = () => {
    if (quietTimer !== null) {
      clearTimeout(quietTimer);
      quietTimer = null;
    }
    if (maxWaitTimer !== null) {
      clearTimeout(maxWaitTimer);
      maxWaitTimer = null;
    }
  };

  const flush = () => {
    clearTimers();
    const path = latestPath;
    latestPath = null;
    if (!disposed && path !== null) {
      onRefresh(path);
    }
  };

  return {
    schedule(path) {
      if (disposed) {
        return;
      }
      latestPath = path;
      if (quietTimer !== null) {
        clearTimeout(quietTimer);
      }
      quietTimer = setTimeout(flush, GIT_AUTO_REFRESH_QUIET_MS);
      // 连续通知只延长静默窗口；最大等待固定从首次事件计时，不能被批量写文件饿死。
      if (maxWaitTimer === null) {
        maxWaitTimer = setTimeout(flush, GIT_AUTO_REFRESH_MAX_WAIT_MS);
      }
    },
    dispose() {
      disposed = true;
      latestPath = null;
      clearTimers();
    },
  };
}

export function shouldEnableGitAutoRefreshForWorkspace(params: {
  enabled: boolean;
  currentWorkspaceKey: string;
  summaryWorkspaceKey: string;
}): boolean {
  return params.enabled && params.currentWorkspaceKey === params.summaryWorkspaceKey;
}

function normalizeWatchPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/" || /^[A-Za-z]:[\\/]?$/.test(trimmed)) {
    return trimmed;
  }

  return trimmed.replace(/[\\/]+$/, "");
}

export function buildGitAutoRefreshWatchPaths(
  summary: Pick<
    GitRepositorySummary,
    "workspacePath" | "repoRoot" | "isGitAvailable" | "isRepository"
  > &
    Partial<Pick<GitRepositorySummary, "autoRefreshWatchPaths">>,
  systemInfo?: Pick<SystemInfo, "platform"> | null,
): GitAutoRefreshWatchPath[] {
  if (!summary.isGitAvailable || !summary.isRepository) {
    return [];
  }

  const workspacePath = normalizeWatchPath(summary.workspacePath || summary.repoRoot);
  const platform = systemInfo?.platform?.trim();
  const canWatchWorkspaceRecursively = Boolean(platform && platform !== "linux");
  const watchPaths: GitAutoRefreshWatchPath[] = [];
  if (workspacePath.length > 0 && canWatchWorkspaceRecursively) {
    watchPaths.push({
      path: workspacePath,
      recursive: true,
    });
  }

  for (const watchPath of summary.autoRefreshWatchPaths ?? []) {
    const path = normalizeWatchPath(watchPath.path);
    if (
      !path ||
      // 兼容旧 remote server：旧 summary 仍可能携带 workspacePath，Linux 下不能让
      // 这个历史字段重新绕过平台边界，触发慢速递归 watcher。
      (path === workspacePath && !canWatchWorkspaceRecursively) ||
      watchPaths.some((entry) => entry.path === path)
    ) {
      continue;
    }

    watchPaths.push({
      path,
      recursive: watchPath.recursive,
    });
  }

  return watchPaths;
}

export function stringifyGitAutoRefreshWatchPaths(
  watchPaths: readonly GitAutoRefreshWatchPath[],
): string {
  return JSON.stringify(watchPaths);
}

export function parseGitAutoRefreshWatchPaths(signature: string): GitAutoRefreshWatchPath[] {
  const parsed = JSON.parse(signature) as GitAutoRefreshWatchPath[];
  return parsed.map((watchPath) => ({
    path: watchPath.path,
    recursive: Boolean(watchPath.recursive),
  }));
}
