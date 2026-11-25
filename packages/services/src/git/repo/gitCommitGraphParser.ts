import type { GitCommitGraphCommit, GitCommitGraphRef } from "@zcode/shared";
import { gitGraphError } from "./gitCommitGraphLimits.js";

export const GIT_GRAPH_OID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export const GIT_GRAPH_LOG_FORMAT = "%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%D%x00%b%x00";
export interface GitGraphRecord {
  commit: GitCommitGraphCommit;
  body: string;
}

function parseDecoration(raw: string): GitCommitGraphRef | null {
  const ref = raw.startsWith("tag: ") ? raw.slice(5) : raw;
  if (ref === "HEAD") return { name: "HEAD", kind: "head" };
  if (ref.startsWith("refs/heads/")) return { name: ref.slice(11), kind: "branch" };
  if (ref.startsWith("refs/remotes/")) return { name: ref.slice(13), kind: "remote" };
  if (ref.startsWith("refs/tags/")) return { name: ref.slice(10), kind: "tag" };
  // --decorate=full 提供明确 namespace；不能用斜杠猜 remote，也不显示内部 refs。
  return null;
}

export function parseGitGraphRefs(decorations: string): GitCommitGraphRef[] {
  const refs: GitCommitGraphRef[] = [];
  const add = (value: GitCommitGraphRef | null) => {
    if (value && !refs.some((ref) => ref.name === value.name && ref.kind === value.kind))
      refs.push(value);
  };
  // Git ref 允许逗号但不允许空格；只拆 Git 固定的 ", " decoration 分隔符。
  for (const raw of decorations.split(", ")) {
    if (raw.startsWith("HEAD -> ")) {
      add({ name: "HEAD", kind: "head" });
      add(parseDecoration(raw.slice(8)));
    } else {
      add(parseDecoration(raw));
    }
  }
  return refs;
}

export function parseGitGraphRecords(stdout: string): GitGraphRecord[] {
  const fields = stdout.split("\0");
  const records: GitGraphRecord[] = [];
  // 固定字段数+NUL 边界保留正文中的换行、RS 和空白，不能用 record.trim()/RS 切用户正文。
  for (let index = 0; index < fields.length; index += 8) {
    const hash = (fields[index] ?? "").replace(/^[\r\n]+/u, "");
    if (!hash && index === fields.length - 1) break;
    if (!GIT_GRAPH_OID_PATTERN.test(hash) || index + 8 >= fields.length)
      throw gitGraphError("query-timeout");
    const parents = fields[index + 1]?.split(" ").filter(Boolean) ?? [];
    if (parents.some((parent) => !GIT_GRAPH_OID_PATTERN.test(parent)))
      throw gitGraphError("query-timeout");
    const seconds = fields[index + 4] ?? "";
    if (!/^-?\d+$/u.test(seconds) || !Number.isSafeInteger(Number(seconds) * 1000))
      throw gitGraphError("query-timeout");
    records.push({
      commit: {
        hash,
        parents,
        refs: parseGitGraphRefs(fields[index + 6] ?? ""),
        authorName: fields[index + 2] || null,
        authorEmail: fields[index + 3] || null,
        authoredAtMs: Number(seconds) * 1000,
        subject: fields[index + 5] ?? "",
      },
      body: fields[index + 7] ?? "",
    });
  }
  return records;
}
