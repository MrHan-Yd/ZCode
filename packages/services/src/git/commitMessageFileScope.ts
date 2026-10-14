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

/**
 * 只提交索引内容的路径（提交侧对它们不做 `git add`）：丢掉同一路径"未暂存"那条记录。
 *
 * `files` 里一个部分暂存的文件会同时有 staged 与 unstaged 两条记录，且路径相同。
 * 如果只提交索引里那半段，另一条必须从消息的取材范围里去掉，否则消息会描述并未提交的余量。
 * 归一化与 excludePaths 共用，绝对 / workspace 相对 / repo 相对都能命中。
 */
export function filterCommitMessageFilesForStagedOnly(params: {
  files: readonly GitFileChange[];
  workspacePath: string;
  repoRoot: string;
  workspaceInRepoPath: string;
  stagedOnlyPaths?: readonly string[];
}): GitFileChange[] {
  const stagedOnlyScope = buildCommitMessageFileScope({
    workspacePath: params.workspacePath,
    repoRoot: params.repoRoot,
    workspaceInRepoPath: params.workspaceInRepoPath,
    currentSessionFilePaths: params.stagedOnlyPaths,
  });
  if (stagedOnlyScope === null) {
    return [...params.files];
  }

  return params.files.filter(
    (file) => file.section === "staged" || !isCommitMessageFileInScope(file, stagedOnlyScope),
  );
}
