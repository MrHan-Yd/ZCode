import type { GitCommitGraphFilterBranch } from "@zcode/shared";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import {
  GIT_GRAPH_MAX_REFS,
  GIT_GRAPH_MAX_ROOTS,
  gitGraphError,
  type GitGraphBudget,
} from "./gitCommitGraphLimits.js";
import { GIT_GRAPH_OID_PATTERN } from "./gitCommitGraphParser.js";

export interface GitGraphRoots {
  roots: string[];
  branches: Array<GitCommitGraphFilterBranch & { oid: string }>;
}

export async function readGitGraphRoots(
  commandProvider: GitCommandProvider,
  repoRoot: string,
  budget: GitGraphBudget,
): Promise<GitGraphRoots> {
  const result = await budget.run(commandProvider, repoRoot, [
    "for-each-ref",
    "--sort=refname",
    "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)%00",
    "refs/heads/",
    "refs/remotes/",
    "refs/tags/",
  ]);
  const branches: GitGraphRoots["branches"] = [];
  const roots = new Set<string>();
  const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
  if (lines.length > GIT_GRAPH_MAX_REFS) throw gitGraphError("query-timeout");
  for (const line of lines) {
    const [ref, objectOid, objectType, peeledOid, peeledType, symbolic] = line.split("\0");
    if (!ref || !objectOid || !GIT_GRAPH_OID_PATTERN.test(objectOid))
      throw gitGraphError("query-timeout");
    const local = ref.startsWith("refs/heads/");
    const remote = ref.startsWith("refs/remotes/");
    if (!local && !remote && !ref.startsWith("refs/tags/")) continue;
    // remote HEAD 是符号别名，不是可选择的远程分支；既不列候选也不当独立 root。
    if (remote && symbolic) continue;
    let oid = objectType === "commit" ? objectOid : peeledType === "commit" ? peeledOid : undefined;
    if (!oid && objectType === "tag" && peeledType === "tag") {
      const peeled = await budget.run(
        commandProvider,
        repoRoot,
        ["rev-parse", "--verify", "--quiet", "--end-of-options", `${objectOid}^{commit}`],
        [0, 1],
      );
      oid = peeled.exitCode === 0 ? peeled.stdout.trim() : undefined;
    }
    // 指向 tree/blob 的 tag 不提供提交历史；Git 同样不会把它们作为 commit 遍历。
    if (!oid) continue;
    if (!GIT_GRAPH_OID_PATTERN.test(oid)) throw gitGraphError("query-timeout");
    roots.add(oid);
    if (local || remote)
      branches.push({
        ref,
        name: ref.slice(local ? 11 : 13),
        kind: local ? "branch" : "remote",
        oid,
      });
  }
  const head = await budget.run(
    commandProvider,
    repoRoot,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", "HEAD^{commit}"],
    [0, 1],
  );
  if (head.exitCode === 0) {
    const oid = head.stdout.trim();
    if (!GIT_GRAPH_OID_PATTERN.test(oid)) throw gitGraphError("query-timeout");
    roots.add(oid);
  }
  if (roots.size > GIT_GRAPH_MAX_ROOTS) throw gitGraphError("query-timeout");
  return { roots: [...roots].sort(), branches };
}
