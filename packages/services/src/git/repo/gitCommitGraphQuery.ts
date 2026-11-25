import type {
  GitCommitGraphFilterOptions,
  GitCommitGraphRequest,
  GitCommitGraphResult,
} from "@zcode/shared";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import {
  createGitGraphCursorState,
  decodeGitGraphCursor,
  encodeGitGraphCursor,
  gitGraphQueryFingerprint,
  gitGraphScope,
} from "./gitCommitGraphCursor.js";
import {
  createGitGraphBudget,
  GIT_GRAPH_BATCH_SIZE,
  GIT_GRAPH_MAX_HISTORY,
  gitGraphError,
  normalizeGitGraphPageSize,
  normalizeGitGraphSkip,
  type GitGraphBudget,
} from "./gitCommitGraphLimits.js";
import { createGitGraphMatcher } from "./gitCommitGraphMatcher.js";
import { GIT_GRAPH_LOG_FORMAT, parseGitGraphRecords } from "./gitCommitGraphParser.js";
import { readGitGraphRoots } from "./gitCommitGraphRoots.js";

async function* readBatches(
  provider: GitCommandProvider,
  repoRoot: string,
  roots: string[],
  budget: GitGraphBudget,
  startOffset = 0,
) {
  if (roots.length === 0) return;
  let offset = startOffset;
  while (true) {
    const size = Math.min(GIT_GRAPH_BATCH_SIZE, GIT_GRAPH_MAX_HISTORY - offset);
    if (size <= 0) throw gitGraphError("query-timeout");
    const result = await budget.run(provider, repoRoot, [
      "log",
      "--no-color",
      "--no-show-signature",
      "--no-use-mailmap",
      "--decorate=full",
      "--decorate-refs=HEAD",
      "--decorate-refs=refs/heads/*",
      "--decorate-refs=refs/remotes/*",
      "--decorate-refs=refs/tags/*",
      "--date-order",
      "--topo-order",
      `--skip=${offset}`,
      `--max-count=${size + 1}`,
      `--format=${GIT_GRAPH_LOG_FORMAT}`,
      ...roots,
      "--",
    ]);
    const records = parseGitGraphRecords(result.stdout);
    if (records.length > size + 1) throw gitGraphError("query-timeout");
    yield { records: records.slice(0, size), offset };
    if (records.length <= size) return;
    offset += size;
  }
}

export async function queryGitCommitGraph(
  provider: GitCommandProvider,
  repoRoot: string,
  request: GitCommitGraphRequest,
  startedAt = Date.now(),
): Promise<GitCommitGraphResult> {
  const budget = createGitGraphBudget(startedAt);
  const fingerprint = gitGraphQueryFingerprint(request.filters);
  const scope = gitGraphScope(request.workspacePath, repoRoot, request.workspaceIdentity);
  const resumed = request.cursor
    ? decodeGitGraphCursor(request.cursor, fingerprint, scope)
    : undefined;
  const matcher = await createGitGraphMatcher(request.filters, budget);
  try {
    const snapshot = resumed ? undefined : await readGitGraphRoots(provider, repoRoot, budget);
    const branchOid =
      resumed?.branchOid ??
      (request.filters?.branchRef
        ? snapshot?.branches.find((branch) => branch.ref === request.filters?.branchRef)?.oid
        : undefined);
    if (request.filters?.branchRef && !branchOid) throw gitGraphError("branch-not-found");
    const state =
      resumed ?? createGitGraphCursorState(snapshot!.roots, fingerprint, scope, branchOid);
    // 分支 tip 是用户可见 root，本次只遍历其可达历史，相当于 visible AND branch reachable。
    // cursor 固定该 OID，不在翻页时重新解析 ref，避免 ref 移动改变顺序或重复提交。
    const roots = state.branchOid ? [state.branchOid] : state.roots;
    const maxCount = normalizeGitGraphPageSize(request.maxCount);
    let skip = resumed ? 0 : normalizeGitGraphSkip(request.skip);
    const commits: GitCommitGraphResult["commits"] = [];
    for await (const batch of readBatches(provider, repoRoot, roots, budget, state.offset)) {
      const matches = await matcher.match(batch.records);
      for (let index = 0; index < batch.records.length; index += 1) {
        if (!matches[index]) continue;
        if (skip > 0) {
          skip -= 1;
          continue;
        }
        if (commits.length === maxCount) {
          // lookahead 只证明 hasMore，cursor 指向它本身而不是后一条；下一页不会丢首项。
          const cursor = encodeGitGraphCursor({ ...state, offset: batch.offset + index });
          return { commits, hasMore: true, cursor };
        }
        commits.push(batch.records[index]!.commit);
      }
    }
    return { commits, hasMore: false };
  } finally {
    // 包括 Git 异常、非法分支、regex 超时和正常返回都必须回收 worker。
    await matcher.close();
  }
}

export async function queryGitCommitGraphFilterOptions(
  provider: GitCommandProvider,
  repoRoot: string,
  startedAt = Date.now(),
): Promise<GitCommitGraphFilterOptions> {
  const budget = createGitGraphBudget(startedAt);
  const snapshot = await readGitGraphRoots(provider, repoRoot, budget);
  const authors = new Map<string, { name: string; email: string }>();
  for await (const batch of readBatches(provider, repoRoot, snapshot.roots, budget)) {
    for (const record of batch.records) {
      const author = {
        name: record.commit.authorName ?? "",
        email: record.commit.authorEmail ?? "",
      };
      authors.set(JSON.stringify([author.name, author.email]), author);
    }
  }
  return {
    branches: snapshot.branches.map(({ ref, name, kind }) => ({ ref, name, kind })),
    authors: [...authors.values()].sort(
      (left, right) => left.name.localeCompare(right.name) || left.email.localeCompare(right.email),
    ),
  };
}
