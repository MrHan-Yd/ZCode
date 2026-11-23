import { createContext, useContext, type ReactNode } from "react";
import type { GitRepositoryRefresh } from "@/lib/gitRepositoryRefresh.js";

const GitRepositoryRefreshContext = createContext<GitRepositoryRefresh | null>(null);

export function GitRepositoryRefreshProvider({
  refresh,
  children,
}: {
  refresh: GitRepositoryRefresh;
  children: ReactNode;
}) {
  // Context 只传刷新能力；基线仍由 useGitRepository 唯一持有。
  return (
    <GitRepositoryRefreshContext.Provider value={refresh}>
      {children}
    </GitRepositoryRefreshContext.Provider>
  );
}

export function useGitRepositoryRefresh(): GitRepositoryRefresh {
  const refresh = useContext(GitRepositoryRefreshContext);
  if (!refresh) {
    throw new Error("useGitRepositoryRefresh 必须在 GitRepositoryRefreshProvider 内使用");
  }
  return refresh;
}
