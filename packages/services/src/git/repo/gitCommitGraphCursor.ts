import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GIT_GRAPH_CURSOR_MAX_LENGTH, type GitCommitGraphFilters } from "@zcode/shared";
import {
  GIT_GRAPH_CURSOR_TTL_MS,
  GIT_GRAPH_MAX_HISTORY,
  GIT_GRAPH_MAX_ROOTS,
  gitGraphError,
} from "./gitCommitGraphLimits.js";
import { GIT_GRAPH_OID_PATTERN } from "./gitCommitGraphParser.js";

// 只有签名密钥是进程级安全状态；root/offset 等查询状态全部由受签名 token 携带，无业务缓存。
const signingKey = randomBytes(32);
export interface GitGraphCursorState {
  version: 1;
  roots: string[];
  branchOid?: string;
  fingerprint: string;
  scope: string;
  offset: number;
  expiresAt: number;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function gitGraphQueryFingerprint(filters?: GitCommitGraphFilters): string {
  // 固定键序和默认值，不把对象属性插入顺序当成不同查询；空条件与“全部”共享语义。
  return hash({
    search: filters?.search?.value
      ? {
          value: filters.search.value,
          mode: filters.search.mode,
          caseSensitive: filters.search.caseSensitive ?? false,
        }
      : null,
    branchRef: filters?.branchRef ?? null,
    author: filters?.author ? { name: filters.author.name, email: filters.author.email } : null,
    date:
      filters?.date?.fromMs !== undefined || filters?.date?.toMs !== undefined
        ? { fromMs: filters.date.fromMs ?? null, toMs: filters.date.toMs ?? null }
        : null,
  });
}

export function gitGraphScope(
  workspacePath: string,
  repoRoot: string,
  workspaceIdentity?: string,
): string {
  return hash([workspaceIdentity?.trim() || workspacePath, repoRoot]);
}

export function createGitGraphCursorState(
  roots: string[],
  fingerprint: string,
  scope: string,
  branchOid?: string,
): GitGraphCursorState {
  return {
    version: 1,
    roots,
    ...(branchOid ? { branchOid } : {}),
    fingerprint,
    scope,
    offset: 0,
    expiresAt: Date.now() + GIT_GRAPH_CURSOR_TTL_MS,
  };
}

export function encodeGitGraphCursor(state: GitGraphCursorState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const signature = createHmac("sha256", signingKey).update(payload).digest("base64url");
  const token = `${payload}.${signature}`;
  if (token.length > GIT_GRAPH_CURSOR_MAX_LENGTH) throw gitGraphError("query-timeout");
  return token;
}

export function decodeGitGraphCursor(
  token: string,
  fingerprint: string,
  scope: string,
): GitGraphCursorState {
  try {
    if (token.length > GIT_GRAPH_CURSOR_MAX_LENGTH) throw new Error();
    const [payload, signature, extra] = token.split(".");
    if (
      !payload ||
      !signature ||
      extra !== undefined ||
      !/^[A-Za-z0-9_-]+$/u.test(payload) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(signature)
    )
      throw new Error();
    const actual = Buffer.from(signature, "base64url");
    const expected = createHmac("sha256", signingKey).update(payload).digest();
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected) ||
      actual.toString("base64url") !== signature
    )
      throw new Error();
    const state: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!state || typeof state !== "object") throw new Error();
    const candidate = state as Partial<GitGraphCursorState>;
    const roots = candidate.roots;
    if (
      candidate.version !== 1 ||
      candidate.fingerprint !== fingerprint ||
      candidate.scope !== scope ||
      !Number.isSafeInteger(candidate.offset) ||
      (candidate.offset ?? -1) < 0 ||
      (candidate.offset ?? Infinity) >= GIT_GRAPH_MAX_HISTORY ||
      !Number.isSafeInteger(candidate.expiresAt) ||
      (candidate.expiresAt ?? 0) <= Date.now() ||
      (candidate.expiresAt ?? Infinity) > Date.now() + GIT_GRAPH_CURSOR_TTL_MS ||
      !Array.isArray(roots) ||
      roots.length === 0 ||
      roots.length > GIT_GRAPH_MAX_ROOTS ||
      roots.some((root) => typeof root !== "string" || !GIT_GRAPH_OID_PATTERN.test(root)) ||
      new Set(roots).size !== roots.length ||
      (candidate.branchOid !== undefined && !roots.includes(candidate.branchOid))
    )
      throw new Error();
    return candidate as GitGraphCursorState;
  } catch {
    throw gitGraphError("invalid-cursor");
  }
}
