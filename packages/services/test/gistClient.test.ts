import assert from "node:assert/strict";
import test from "node:test";
import { createGistClient } from "../src/config-sync/gistClient.js";
import type { ConfigSyncError, GistFilesPayload } from "../src/config-sync/types.js";

/**
 * gist 客户端是唯一跟 GitHub 说话的模块，请求体形状写错时线上只表现为「HTTP 422」，本地测试全绿。
 * 这里用注入的 fetch 断言真实请求（URL / method / 请求头 / 请求体），补上之前缺失的回归网。
 */

interface CapturedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

function stubFetch(response: Response): { fetchImpl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];
  // 用 fetch 自身的入参类型，避免依赖 lib 是否导出 RequestInfo（services 只开 es2025 lib）。
  const fetchImpl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requests.push({ url: String(input), init: init ?? {} });
    return response;
  }) as typeof fetch;
  return { fetchImpl, requests };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `GET /gists/{id}` 的成功响应：客户端只要求 `id`，其余字段缺省也有兜底。 */
function gistResponse(): unknown {
  return {
    id: "0123456789abcdef",
    html_url: "https://gist.github.com/0123456789abcdef",
    description: "zcode-subagents-config-sync",
    updated_at: "2026-10-19T00:00:00Z",
    files: { "manifest.json": { content: "{}", truncated: false } },
  };
}

function capturedRequest(requests: readonly CapturedRequest[]): CapturedRequest {
  const [request] = requests;
  if (!request) throw new Error("没有捕获到请求");
  return request;
}

function sentBody(request: CapturedRequest): Record<string, unknown> {
  return JSON.parse(String(request.init.body)) as Record<string, unknown>;
}

function sentHeaders(request: CapturedRequest): Record<string, string> {
  return (request.init.headers ?? {}) as Record<string, string>;
}

/** 走一次必然失败的请求，取回映射后的错误。 */
async function errorFor(response: Response): Promise<ConfigSyncError> {
  const { fetchImpl } = stubFetch(response);
  const result = await createGistClient(fetchImpl).fetchGist("tkn", "0123456789abcdef");
  if (result.ok) throw new Error("期望失败，但请求成功了");
  return result.error;
}

test("createGist：请求体是 gist 线上形状（每个文件是带 content 的对象）", async () => {
  const { fetchImpl, requests } = stubFetch(jsonResponse(gistResponse(), 201));
  const files: GistFilesPayload = {
    "agent.code-reviewer.md": { content: "---\nname: code-reviewer\n" },
    "state.json": { content: "{}\n" },
  };

  const result = await createGistClient(fetchImpl).createGist(
    "tkn",
    "zcode-subagents-config-sync",
    files,
  );
  assert.equal(result.ok, true);

  const request = capturedRequest(requests);
  assert.equal(request.url, "https://api.github.com/gists");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(sentHeaders(request), {
    authorization: "Bearer tkn",
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  });
  assert.deepEqual(sentBody(request), {
    description: "zcode-subagents-config-sync",
    public: false,
    files,
  });
  // 曾经这里发的是裸字符串（`files[name] = content`），GitHub 以 422 拒绝：值必须是对象。
  for (const value of Object.values(sentBody(request).files as Record<string, unknown>)) {
    assert.equal(typeof value, "object");
    assert.equal(typeof (value as { content?: unknown }).content, "string");
  }
});

test("patchGist：只发 files，null 保留为删除标记", async () => {
  const { fetchImpl, requests } = stubFetch(jsonResponse(gistResponse()));
  const files: GistFilesPayload = {
    "agent.keep.md": { content: "K" },
    "agent.gone.md": null,
  };

  const result = await createGistClient(fetchImpl).patchGist(
    "tkn",
    "0123456789abcdef",
    files,
  );
  assert.equal(result.ok, true);

  const request = capturedRequest(requests);
  assert.equal(request.url, "https://api.github.com/gists/0123456789abcdef");
  assert.equal(request.init.method, "PATCH");
  const body = sentBody(request);
  assert.deepEqual(body, { files });
  assert.equal("description" in body, false);
  assert.equal((body.files as Record<string, unknown>)["agent.gone.md"], null);
});

test("422：归为 unknown，message 带 GitHub 的校验摘要", async () => {
  const { fetchImpl } = stubFetch(
    jsonResponse(
      {
        message: "Validation Failed",
        errors: [{ resource: "Gist", field: "files", code: "invalid" }],
      },
      422,
    ),
  );

  const result = await createGistClient(fetchImpl).createGist("tkn", "d", {});
  if (result.ok) throw new Error("期望失败，但请求成功了");
  assert.equal(result.error.code, "unknown");
  assert.match(result.error.message, /HTTP 422/);
  assert.match(result.error.message, /Validation Failed/);
  assert.match(result.error.message, /files: invalid/);
});

test("422：schema 报错只取首行，不回显后续行里的取值", async () => {
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const { fetchImpl } = stubFetch(
    jsonResponse(
      {
        message: [
          "Invalid request.",
          "",
          'No subschema in "anyOf" matched.',
          `For 'anyOf/0', {"content": "${secret}"} is not an object.`,
        ].join("\n"),
      },
      422,
    ),
  );

  const result = await createGistClient(fetchImpl).createGist("tkn", "d", {});
  if (result.ok) throw new Error("期望失败，但请求成功了");
  assert.equal(result.error.message, "HTTP 422 · Invalid request.");
  assert.equal(result.error.message.includes(secret), false);
});

test("错误体不是 JSON 时只报状态码，不影响失败语义", async () => {
  const error = await errorFor(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
  assert.equal(error.code, "unknown");
  assert.equal(error.message, "HTTP 502");
});

test("状态码映射：401 / 404 / 403 限流 / 429 / 403 缺权限", async () => {
  assert.equal((await errorFor(jsonResponse({ message: "Requires authentication" }, 401))).code, "unauthorized");
  assert.equal((await errorFor(jsonResponse({ message: "Not Found" }, 404))).code, "not_found");

  const limited = await errorFor(
    new Response(JSON.stringify({ message: "rate limit" }), {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "retry-after": "60" },
    }),
  );
  assert.equal(limited.code, "rate_limited");
  assert.match(limited.message, /retry-after: 60s/);

  assert.equal((await errorFor(jsonResponse({ message: "rate limit" }, 429))).code, "rate_limited");

  const scoped = await errorFor(
    new Response(JSON.stringify({ message: "Forbidden" }), {
      status: 403,
      headers: { "x-accepted-oauth-scopes": "gist" },
    }),
  );
  assert.equal(scoped.code, "insufficient_scope");
  assert.match(scoped.message, /需要 gist/);
});
