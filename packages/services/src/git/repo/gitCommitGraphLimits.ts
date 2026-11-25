import {
  gitCommitGraphQuerySchema,
  type GitCommitGraphFilterOptionsRequest,
  type GitCommitGraphRequest,
  type GitGraphIssueCode,
} from "@zcode/shared";
import { DEFAULT_GIT_OUTPUT_BYTES } from "../config.js";
import type {
  GitCommandExecutionResult,
  GitCommandProvider,
} from "../providers/gitCommandProvider.js";

export const GIT_GRAPH_BATCH_SIZE = 200;
export const GIT_GRAPH_MAX_ROOTS = 256;
export const GIT_GRAPH_MAX_REFS = 4096;
export const GIT_GRAPH_MAX_HISTORY = 250_000;
export const GIT_GRAPH_CURSOR_TTL_MS = 30 * 60_000;
const QUERY_BUDGET_MS = 15_000;
const QUERY_OUTPUT_BUDGET_BYTES = 32 * 1024 * 1024;

export function gitGraphError(code: GitGraphIssueCode): Error & { code: GitGraphIssueCode } {
  const messages: Record<GitGraphIssueCode, string> = {
    "invalid-query": "Invalid Git graph query.",
    "invalid-regex": "Invalid Git graph regular expression.",
    "invalid-cursor": "Invalid or expired Git graph cursor. Restart the query.",
    "branch-not-found": "Git graph branch was not found.",
    "query-timeout": "Git graph query exceeded its execution or resource limit.",
  };
  // 错误只暴露稳定分类，不把用户输入、邮箱或 Git 输出正文带入日志/RPC 错误。
  return Object.assign(new Error(messages[code]), { code });
}

export function validateGitGraphQuery(value: unknown): GitCommitGraphRequest {
  const parsed = gitCommitGraphQuerySchema.safeParse(value);
  if (parsed.success) return parsed.data;
  if (parsed.error.issues.some((entry) => entry.path[0] === "cursor")) {
    throw gitGraphError("invalid-cursor");
  }
  if (
    parsed.error.issues.some(
      (entry) => entry.path[1] === "branchRef" && entry.code === "invalid_format",
    )
  ) {
    throw gitGraphError("branch-not-found");
  }
  throw gitGraphError("invalid-query");
}

const optionsRequestSchema = gitCommitGraphQuerySchema.pick({
  workspacePath: true,
  workspaceIdentity: true,
});
export function validateGitGraphOptionsRequest(value: unknown): GitCommitGraphFilterOptionsRequest {
  const parsed = optionsRequestSchema.safeParse(value);
  if (!parsed.success) throw gitGraphError("invalid-query");
  return parsed.data;
}

export function ensureGitGraphCommandBudget(result: GitCommandExecutionResult): void {
  // 超时/截断必须先于 unborn HEAD 判断，否则真实失败会被错误地当成空仓库。
  if (result.timedOut || result.outputTruncated) throw gitGraphError("query-timeout");
}

export function createGitGraphBudget(startedAt = Date.now()) {
  const deadline = startedAt + QUERY_BUDGET_MS;
  let outputBytes = 0;
  function remainingMs(): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw gitGraphError("query-timeout");
    return remaining;
  }
  return {
    remainingMs,
    async run(
      commandProvider: GitCommandProvider,
      repoRoot: string,
      args: string[],
      allowedExitCodes = [0],
    ) {
      const result = await commandProvider.run({
        cwd: repoRoot,
        args,
        timeoutMs: remainingMs(),
        maxOutputBytes: DEFAULT_GIT_OUTPUT_BYTES,
        env: { GIT_NO_REPLACE_OBJECTS: "1" },
      });
      ensureGitGraphCommandBudget(result);
      outputBytes += Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      if (outputBytes > QUERY_OUTPUT_BUDGET_BYTES) throw gitGraphError("query-timeout");
      remainingMs();
      if (!allowedExitCodes.includes(result.exitCode ?? -1)) throw gitGraphError("invalid-query");
      return result;
    },
  };
}

export type GitGraphBudget = ReturnType<typeof createGitGraphBudget>;

export function normalizeGitGraphPageSize(value?: number): number {
  return Math.min(200, Math.max(1, Math.floor(value ?? 100)));
}
export function normalizeGitGraphSkip(value?: number): number {
  const skip = Math.max(0, Math.floor(value ?? 0));
  if (!Number.isSafeInteger(skip) || skip > GIT_GRAPH_MAX_HISTORY)
    throw gitGraphError("query-timeout");
  return skip;
}
