import { isAbsolute, relative } from "node:path";
import type { GitFileChange } from "@zcode/shared";
import { normalizeGitPath, normalizeWorkspaceInRepoPath } from "./config.js";

function normalizeCommitMessageScopePath(path: string): string {
  return normalizeGitPath(path.trim())
    .replace(/^\.?\//, "")
    .replace(/\/+$/, "");
}

function isRelativePathInsideScope(path: string): boolean {
  const normalizedPath = normalizeGitPath(path);
  return (
    normalizedPath.length > 0 &&
    normalizedPath !== ".." &&
    !normalizedPath.startsWith("../") &&
    !isAbsolute(normalizedPath)
  );
}

function addCommitMessageScopeCandidate(scope: Set<string>, path: string): void {
  const normalizedPath = normalizeCommitMessageScopePath(path);
  if (!normalizedPath) {
    return;
  }
  scope.add(normalizedPath);
}

function buildCommitMessageFileScope(params: {
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  currentSessionFilePaths?: readonly string[];
}): Set<string> | null {
  const sourcePaths = params.currentSessionFilePaths
    ?.map((path) => path.trim())
    .filter((path) => path.length > 0);
  if (!sourcePaths || sourcePaths.length === 0) {
    return null;
  }

  const scope = new Set<string>();
  const normalizedWorkspaceInRepoPath = normalizeWorkspaceInRepoPath(params.workspaceInRepoPath);

  for (const path of sourcePaths) {
    addCommitMessageScopeCandidate(scope, path);

    if (isAbsolute(path)) {
      const repoRelativePath = relative(params.repoRoot, path);
      if (isRelativePathInsideScope(repoRelativePath)) {
        addCommitMessageScopeCandidate(scope, repoRelativePath);
      }

      const workspaceRelativePath = relative(params.workspacePath, path);
      if (isRelativePathInsideScope(workspaceRelativePath)) {
        addCommitMessageScopeCandidate(scope, workspaceRelativePath);
      }
      continue;
    }

    const normalizedPath = normalizeCommitMessageScopePath(path);
    if (
      normalizedWorkspaceInRepoPath !== "." &&
      !normalizedPath.startsWith(`${normalizedWorkspaceInRepoPath}/`)
    ) {
      addCommitMessageScopeCandidate(scope, `${normalizedWorkspaceInRepoPath}/${normalizedPath}`);
    }
  }

  return scope.size > 0 ? scope : null;
}

function isCommitMessageFileInScope(file: GitFileChange, scope: Set<string> | null): boolean {
  if (!scope) {
    return true;
  }

  return [file.path, file.repoRelativePath, file.workspaceRelativePath].some((path) =>
    scope.has(normalizeCommitMessageScopePath(path)),
  );
}

export function filterCommitMessageFilesByCurrentSession(params: {
  files: readonly GitFileChange[];
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  currentSessionFilePaths?: readonly string[];
  excludePaths?: readonly string[];
}): GitFileChange[] {
  const scope = buildCommitMessageFileScope({
    workspacePath: params.workspacePath,
    repoRoot: params.repoRoot,
    workspaceInRepoPath: params.workspaceInRepoPath,
    currentSessionFilePaths: params.currentSessionFilePaths,
  });
  // 用户取消勾选的文件不参与提交，也不能出现在提交消息里。复用同一套路径归一化，
  // 因此调用方传绝对路径或 workspace / repo 相对路径都能命中；scope 为 null 表示不排除任何文件。
  const excludedScope = buildCommitMessageFileScope({
    workspacePath: params.workspacePath,
    repoRoot: params.repoRoot,
    workspaceInRepoPath: params.workspaceInRepoPath,
    currentSessionFilePaths: params.excludePaths,
  });

  return params.files.filter((file) => {
    if (!isCommitMessageFileInScope(file, scope)) {
      return false;
    }
    return excludedScope === null || !isCommitMessageFileInScope(file, excludedScope);
  });
}
