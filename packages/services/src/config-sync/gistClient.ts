import { describeRequestError } from "#src/http/describeRequestError.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { CONFIG_SYNC_MANIFEST_FILE_NAME, parseManifest } from "./manifest.js";
import type { ConfigSyncError, GistFilesPayload } from "./types.js";

/**
 * GitHub gist 的最小客户端：只实现本改动用到的 4 个路由，并统一注入鉴权头、代理感知传输与超时。
 *
 * `fetchImpl` 必须由 host 注入 `hostApiNetworkTransport.fetch`（undici 不认 http_proxy 环境变量，
 * 详见 specs/github-account-auth.md）；token 只作为参数进来，不出现在任何返回值与日志里。
 */

const log = createServiceLogger("configSync");

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const REQUEST_TIMEOUT_MS = 20_000;
/** 正常 GitHub 错误体只有几百字节；超过这个长度说明不是我们认识的错误体，不再解析。 */
const ERROR_BODY_MAX_CHARS = 64 * 1024;
const ERROR_MESSAGE_MAX_CHARS = 200;
const ERROR_DETAIL_MAX_ITEMS = 3;

export interface RemoteGist {
  readonly id: string;
  readonly htmlUrl: string;
  readonly description: string;
  readonly updatedAt: string;
  readonly files: Record<string, unknown>;
}

export type GistResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ConfigSyncError };

export interface GistClient {
  fetchGist(token: string, gistId: string): Promise<GistResult<RemoteGist>>;
  listGists(token: string): Promise<GistResult<RemoteGist[]>>;
  /** `files` 必须是 gist 的线上形状（见 `GistFilesPayload`）；本层只透传，不做转换。 */
  createGist(
    token: string,
    description: string,
    files: GistFilesPayload,
  ): Promise<GistResult<RemoteGist>>;
  /** `files` 里的 `null` 表示删除该文件。 */
  patchGist(
    token: string,
    gistId: string,
    files: GistFilesPayload,
  ): Promise<GistResult<RemoteGist>>;
}

export function createGistClient(fetchImpl: typeof fetch): GistClient {
  const requestGist = async (
    token: string,
    path: string,
    init: { method: string; body?: string },
  ): Promise<GistResult<unknown>> => {
    let response: Response;
    try {
      response = await fetchImpl(`${GITHUB_API_BASE}${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": GITHUB_API_VERSION,
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const detail = describeRequestError(error);
      const code = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
      log.warn(undefined, "github gist request failed", { code, detail });
      return { ok: false, error: { code, message: detail } };
    }
    if (!response.ok) {
      const error = await mapGithubError(response);
      log.warn(undefined, "github gist request rejected", {
        status: response.status,
        code: error.code,
      });
      return { ok: false, error };
    }
    try {
      return { ok: true, value: (await response.json()) as unknown };
    } catch {
      return {
        ok: false,
        error: { code: "unknown", message: `GitHub 响应不是合法 JSON（HTTP ${response.status}）` },
      };
    }
  };

  const single = async (
    token: string,
    path: string,
    init: { method: string; body?: string },
  ): Promise<GistResult<RemoteGist>> => {
    const response = await requestGist(token, path, init);
    if (!response.ok) return response;
    const gist = parseGist(response.value);
    if (!gist) {
      return { ok: false, error: { code: "unknown", message: "GitHub 响应缺少 gist 字段" } };
    }
    return { ok: true, value: gist };
  };

  return {
    fetchGist: (token, gistId) => single(token, `/gists/${gistId}`, { method: "GET" }),
    createGist: (token, description, files) =>
      single(token, "/gists", {
        method: "POST",
        body: JSON.stringify({ description, public: false, files }),
      }),
    patchGist: (token, gistId, files) =>
      single(token, `/gists/${gistId}`, { method: "PATCH", body: JSON.stringify({ files }) }),
    listGists: async (token) => {
      const response = await requestGist(token, "/gists?per_page=100", { method: "GET" });
      if (!response.ok) return response;
      if (!Array.isArray(response.value)) {
        return { ok: false, error: { code: "unknown", message: "GitHub 响应不是 gist 列表" } };
      }
      return {
        ok: true,
        value: response.value.flatMap((item) => parseGist(item) ?? []),
      };
    },
  };
}

export function gistHtmlUrl(gistId: string): string {
  return `https://gist.github.com/${gistId}`;
}

/** 远端 manifest 里的 revision；读不到就按 0 处理（本次上传即 revision 1）。 */
export function readGistRevision(gist: RemoteGist): number {
  const manifestFile = gist.files[CONFIG_SYNC_MANIFEST_FILE_NAME];
  const content =
    typeof manifestFile === "object" && manifestFile !== null
      ? (manifestFile as { content?: unknown }).content
      : undefined;
  if (typeof content !== "string") return 0;
  try {
    return parseManifest(JSON.parse(content) as unknown)?.revision ?? 0;
  } catch {
    return 0;
  }
}

function parseGist(raw: unknown): RemoteGist | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;
  const htmlUrl = typeof record.html_url === "string" ? record.html_url.trim() : "";
  const description = typeof record.description === "string" ? record.description : "";
  const updatedAt = typeof record.updated_at === "string" ? record.updated_at : "";
  const files =
    typeof record.files === "object" && record.files !== null && !Array.isArray(record.files)
      ? (record.files as Record<string, unknown>)
      : {};
  return { id, htmlUrl: htmlUrl || gistHtmlUrl(id), description, updatedAt, files };
}

async function mapGithubError(response: Response): Promise<ConfigSyncError> {
  const status = response.status;
  if (status === 401) {
    // 不删凭据：清理入口只有 GithubAuthService 的 signOut 与 GithubTokenProvider 的
    // compare-and-delete（bad_refresh_token 分支）；gist 401 仍按 unauthorized 返回。
    return { code: "unauthorized", message: "HTTP 401" };
  }
  if (status === 404) {
    return { code: "not_found", message: "HTTP 404" };
  }
  const rateLimitRemaining = response.headers.get("x-ratelimit-remaining");
  if (status === 429 || (status === 403 && rateLimitRemaining === "0")) {
    const retryAfter = response.headers.get("retry-after");
    return {
      code: "rate_limited",
      message: retryAfter ? `retry-after: ${retryAfter}s` : "HTTP 403 rate limited",
    };
  }
  if (status === 403) {
    const acceptedScopes = response.headers.get("x-accepted-oauth-scopes");
    return {
      code: "insufficient_scope",
      message: acceptedScopes ? `需要 ${acceptedScopes}` : "HTTP 403",
    };
  }
  // 未映射的状态码（422 等）只报状态码时无法定位原因，补上 GitHub 的校验摘要。
  return { code: "unknown", message: `HTTP ${status}${await describeGithubErrorBody(response)}` };
}

/**
 * 未映射状态码的补充诊断：把 GitHub 的校验摘要接在状态码后面（如 `HTTP 422 · Validation Failed；files: invalid`）。
 *
 * 只取顶层 `message` 的**首行**与 `errors[].field` / `errors[].code` 这类结构信息，**不取**
 * `errors[].message`、也不回显响应体原文：GitHub 的 schema 报错会把被拒绝的取值写进 message 的后续行
 * （形如 `For 'anyOf/0', 1 is not a boolean.`），透传就等于把待上传内容带进 `ConfigSyncError.message`
 * 和日志（约束见 types.ts 的 `message` 注释）。
 */
async function describeGithubErrorBody(response: Response): Promise<string> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return "";
  }
  if (raw.length === 0 || raw.length > ERROR_BODY_MAX_CHARS) return "";
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return "";
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) return "";
  const record = body as Record<string, unknown>;
  const parts: string[] = [];
  const message = firstLineOf(record.message);
  if (message) parts.push(message);
  const errors = Array.isArray(record.errors) ? record.errors : [];
  for (const entry of errors.slice(0, ERROR_DETAIL_MAX_ITEMS)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const detail = entry as Record<string, unknown>;
    const field = typeof detail.field === "string" ? detail.field.trim() : "";
    const code = typeof detail.code === "string" ? detail.code.trim() : "";
    const text = field && code ? `${field}: ${code}` : field || code;
    if (text) parts.push(text);
  }
  if (parts.length === 0) return "";
  return ` · ${parts.join("；")}`;
}

function firstLineOf(value: unknown): string {
  if (typeof value !== "string") return "";
  const line = value.split("\n", 1)[0]?.trim() ?? "";
  return line.length > ERROR_MESSAGE_MAX_CHARS ? `${line.slice(0, ERROR_MESSAGE_MAX_CHARS)}…` : line;
}
