import assert from "node:assert/strict";
import test from "node:test";
import { createConfigSync, type ConfigSyncAdapter } from "../src/config-sync/orchestrator.js";
import { createConfigSyncTokenAccess } from "../src/config-sync/tokenAccess.js";
import type { ConfigSyncMetadata, ConfigSyncProfile } from "../src/config-sync/types.js";
import { GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY } from "../src/github/githubAuth.js";
import { GITHUB_TOKEN_SET_CREDENTIAL_KEY } from "../src/github/githubTokenProvider.js";

/**
 * config-sync 取 token 入口：`getStatus()` 只读本地凭据（不刷新、不出网），
 * 同步操作则把 provider 的失败状态映射为稳定的 config-sync 错误码。
 */

const TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
const SENTINEL_ACCESS = "gho_SECRET_SENTINEL_ACCESS";
const SENTINEL_REFRESH = "ghr_SECRET_SENTINEL_REFRESH";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface FetchCall {
  readonly url: string;
  readonly body: string;
}

/** 计数型 fetch mock：路由到 token 端点，可返回固定响应或抛错。 */
function createCountingFetch(options: { response?: unknown; failWith?: Error } = {}): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, body: typeof init?.body === "string" ? init.body : "" });
    if (options.failWith) throw options.failWith;
    return jsonResponse(options.response ?? {});
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function createFakeCredentialService(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    load: async (key: string) => store.get(key) ?? null,
    save: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    // host 内部的 compare-and-delete：bad_refresh_token 只有值仍是本次失败值才删除。
    deleteIf: async (key: string, predicate: (plaintext: string) => boolean) => {
      const current = store.get(key);
      if (current === undefined || !predicate(current)) return false;
      store.delete(key);
      return true;
    },
  };
}

const PROFILE: ConfigSyncProfile = {
  fileNameFor: (name) => `item.${name}.json`,
  nameFromFileName: (fileName) =>
    fileName.startsWith("item.") && fileName.endsWith(".json")
      ? fileName.slice("item.".length, -".json".length)
      : null,
  isValidContent: () => true,
  extraFileNames: [],
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};

/** 最小适配器：只用于 getStatus，不触碰任何真实文件。 */
function createMinimalAdapter(): ConfigSyncAdapter {
  return {
    gistDescription: "zcode-test-config-sync",
    profile: PROFILE,
    metadata: {
      read: async () => ({}),
      write: async () => {},
    },
    backup: {
      create: async () => "",
      restore: async () => true,
      list: async () => ({ backupRoot: "", backups: [] }),
    },
    collectSnapshot: async () => ({ items: [], extras: [], skippedLocalFiles: [] }),
    apply: async () => {},
    countBackupItems: async () => 0,
  };
}

function createSync(
  credentials: ReturnType<typeof createFakeCredentialService>,
  fetchImpl: typeof fetch,
) {
  return createConfigSync({
    adapter: createMinimalAdapter(),
    credentialService: credentials,
    fetchImpl,
    enqueueWrite: async (run) => run(),
  });
}

function writeTokenSet(
  credentials: ReturnType<typeof createFakeCredentialService>,
  session: Record<string, unknown>,
): void {
  credentials.store.set(GITHUB_TOKEN_SET_CREDENTIAL_KEY, JSON.stringify(session));
}

test("getStatus：存在未过期 token 时 connected=true，且完全不发起网络请求", async () => {
  const credentials = createFakeCredentialService();
  writeTokenSet(credentials, {
    accessToken: SENTINEL_ACCESS,
    refreshToken: SENTINEL_REFRESH,
    accessTokenExpiresAt: Date.now() + 3600_000,
  });
  const mock = createCountingFetch({ response: { access_token: "gho_should_not_be_used" } });
  const sync = createSync(credentials, mock.fetchImpl);

  const status = await sync.getStatus();
  assert.equal(status.connected, true);
  // getStatus 是纯本地读取：不刷新、不出网。
  assert.equal(mock.calls.length, 0);
});

test("getStatus：凭据已过期也不触发刷新（仍算已连接）且零网络请求", async () => {
  const credentials = createFakeCredentialService();
  writeTokenSet(credentials, {
    accessToken: SENTINEL_ACCESS,
    refreshToken: SENTINEL_REFRESH,
    accessTokenExpiresAt: Date.now() - 1,
    refreshTokenExpiresAt: Date.now() + 3600_000,
  });
  const mock = createCountingFetch({ response: { access_token: "gho_should_not_be_used" } });
  const sync = createSync(credentials, mock.fetchImpl);

  const status = await sync.getStatus();
  assert.equal(status.connected, true);
  assert.equal(mock.calls.length, 0);
});

test("getStatus：旧 key 迁移场景也算已连接，零网络请求", async () => {
  const credentials = createFakeCredentialService({
    [GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY]: SENTINEL_ACCESS,
  });
  const mock = createCountingFetch({ response: { access_token: "gho_should_not_be_used" } });
  const sync = createSync(credentials, mock.fetchImpl);

  const status = await sync.getStatus();
  assert.equal(status.connected, true);
  assert.equal(mock.calls.length, 0);
});

test("getStatus：无凭据时 connected=false，零网络请求", async () => {
  const credentials = createFakeCredentialService();
  const mock = createCountingFetch({ response: { access_token: "gho_should_not_be_used" } });
  const sync = createSync(credentials, mock.fetchImpl);

  const status = await sync.getStatus();
  assert.equal(status.connected, false);
  assert.equal(mock.calls.length, 0);
});

test("resolveAccessToken：未过期直接复用本地 token，零网络请求", async () => {
  const credentials = createFakeCredentialService();
  writeTokenSet(credentials, {
    accessToken: SENTINEL_ACCESS,
    refreshToken: SENTINEL_REFRESH,
    accessTokenExpiresAt: Date.now() + 3600_000,
  });
  const mock = createCountingFetch({ response: { access_token: "gho_should_not_be_used" } });
  const tokens = createConfigSyncTokenAccess({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
  });

  assert.deepEqual(await tokens.resolveAccessToken(), { ok: true, token: SENTINEL_ACCESS });
  assert.equal(mock.calls.length, 0);
});

test("resolveAccessToken：旧 key 迁移按长期 token 可用，不刷新", async () => {
  const credentials = createFakeCredentialService({
    [GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY]: SENTINEL_ACCESS,
  });
  const mock = createCountingFetch({ response: { access_token: "gho_should_not_be_used" } });
  const tokens = createConfigSyncTokenAccess({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
  });

  assert.deepEqual(await tokens.resolveAccessToken(), { ok: true, token: SENTINEL_ACCESS });
  assert.equal(mock.calls.length, 0);
});

test("resolveAccessToken：refresh token 失效（reauth_required）映射为 not_authenticated", async () => {
  const credentials = createFakeCredentialService();
  writeTokenSet(credentials, {
    accessToken: SENTINEL_ACCESS,
    refreshToken: SENTINEL_REFRESH,
    accessTokenExpiresAt: Date.now() - 1,
    refreshTokenExpiresAt: Date.now() + 3600_000,
  });
  const mock = createCountingFetch({ response: { error: "bad_refresh_token" } });
  const tokens = createConfigSyncTokenAccess({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
  });

  const result = await tokens.resolveAccessToken();
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.equal(result.error.code, "not_authenticated");
  assert.ok(result.error.message.includes("授权已过期"));
  assert.equal(JSON.stringify(result).includes(SENTINEL_ACCESS), false);
  assert.equal(JSON.stringify(result).includes(SENTINEL_REFRESH), false);
  // refresh token 已作废：provider 会清掉凭据，避免每次都发无效刷新。
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), false);
  // 只有 token 端点被请求一次，且请求体不含 client_secret。
  assert.equal(mock.calls.length, 1);
  const body = new URLSearchParams(mock.calls[0]?.body ?? "");
  assert.deepEqual([...body.keys()].sort(), ["client_id", "grant_type", "refresh_token"]);
});

test("resolveAccessToken：无 refresh token 且 access token 过期 → not_authenticated", async () => {
  const credentials = createFakeCredentialService();
  writeTokenSet(credentials, {
    accessToken: SENTINEL_ACCESS,
    accessTokenExpiresAt: Date.now() - 1,
  });
  const mock = createCountingFetch({ response: { access_token: "gho_should_not_be_used" } });
  const tokens = createConfigSyncTokenAccess({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
  });

  const result = await tokens.resolveAccessToken();
  assert.ok(!result.ok);
  assert.equal(result.error.code, "not_authenticated");
  assert.equal(mock.calls.length, 0);
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), false);
});

test("resolveAccessToken：刷新网络失败（temporarily_unavailable）映射为 network 且保留凭据", async () => {
  const credentials = createFakeCredentialService();
  writeTokenSet(credentials, {
    accessToken: SENTINEL_ACCESS,
    refreshToken: SENTINEL_REFRESH,
    accessTokenExpiresAt: Date.now() - 1,
    refreshTokenExpiresAt: Date.now() + 3600_000,
  });
  const mock = createCountingFetch({ failWith: new Error("fetch failed") });
  const tokens = createConfigSyncTokenAccess({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
  });

  const result = await tokens.resolveAccessToken();
  assert.ok(!result.ok);
  assert.equal(result.error.code, "network");
  assert.equal(JSON.stringify(result).includes(SENTINEL_ACCESS), false);
  // 网络问题可恢复：凭据必须保留，稍后重试。
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), true);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0]?.url, TOKEN_ENDPOINT);
});

test("resolveAccessToken：刷新返回配置类错误 → unknown 且保留凭据（重试无效，提示检查配置）", async () => {
  const credentials = createFakeCredentialService();
  writeTokenSet(credentials, {
    accessToken: SENTINEL_ACCESS,
    refreshToken: SENTINEL_REFRESH,
    accessTokenExpiresAt: Date.now() - 1,
    refreshTokenExpiresAt: Date.now() + 3600_000,
  });
  const mock = createCountingFetch({ response: { error: "incorrect_client_credentials" } });
  const tokens = createConfigSyncTokenAccess({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
  });

  const result = await tokens.resolveAccessToken();
  assert.ok(!result.ok);
  // 配置类错误不是网络问题：不能提示「稍后重试」，要提示检查 OAuth App 配置。
  assert.equal(result.error.code, "unknown");
  assert.ok(result.error.message.includes("OAuth App"));
  assert.equal(JSON.stringify(result).includes(SENTINEL_ACCESS), false);
  assert.equal(JSON.stringify(result).includes(SENTINEL_REFRESH), false);
  // 配置问题不删凭据：修好配置后刷新即可恢复。
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), true);
  assert.equal(mock.calls.length, 1);
});

test("resolveAccessToken：从未登录 → not_authenticated 且零网络请求", async () => {
  const credentials = createFakeCredentialService();
  const mock = createCountingFetch({ response: { access_token: "gho_should_not_be_used" } });
  const tokens = createConfigSyncTokenAccess({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
  });

  const result = await tokens.resolveAccessToken();
  assert.ok(!result.ok);
  assert.equal(result.error.code, "not_authenticated");
  assert.ok(result.error.message.includes("未登录"));
  assert.equal(mock.calls.length, 0);
});

test("resolveAccessToken：未注入 credentialService 时 not_authenticated，零网络请求", async () => {
  const mock = createCountingFetch({ response: { access_token: "gho_should_not_be_used" } });
  const tokens = createConfigSyncTokenAccess({ fetchImpl: mock.fetchImpl });

  const result = await tokens.resolveAccessToken();
  assert.ok(!result.ok);
  assert.equal(result.error.code, "not_authenticated");
  assert.equal(await tokens.readSession(), null);
  assert.equal(mock.calls.length, 0);
});

test("upload：临近过期时先刷新，再用刷新后的 token 请求 gist（provider 是唯一 token 入口）", async () => {
  const credentials = createFakeCredentialService();
  writeTokenSet(credentials, {
    accessToken: SENTINEL_ACCESS,
    refreshToken: SENTINEL_REFRESH,
    // 距过期只剩 1 分钟：进入 5 分钟刷新窗口。
    accessTokenExpiresAt: Date.now() + 60_000,
    refreshTokenExpiresAt: Date.now() + 15897600_000,
  });

  const calls: { url: string; method: string; authorization: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, authorization: new Headers(init?.headers).get("authorization") });
    if (url === TOKEN_ENDPOINT) {
      return jsonResponse({
        access_token: "gho_refreshed",
        refresh_token: "ghr_rotated",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
      });
    }
    if (url === "https://api.github.com/gists?per_page=100") return jsonResponse([]);
    if (url === "https://api.github.com/gists" && method === "POST") {
      return jsonResponse(
        {
          id: "gist01234567",
          html_url: "https://gist.github.com/gist01234567",
          description: "zcode-test-config-sync",
          updated_at: "2026-10-27T00:00:00.000Z",
          files: {},
        },
        201,
      );
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const captured: { metadata: ConfigSyncMetadata | null } = { metadata: null };
  const adapter: ConfigSyncAdapter = {
    ...createMinimalAdapter(),
    collectSnapshot: async () => ({
      items: [{ name: "alpha", content: JSON.stringify({ name: "alpha" }) }],
      extras: [],
      skippedLocalFiles: [],
    }),
    metadata: {
      read: async () => ({}),
      write: async (next) => {
        captured.metadata = next;
      },
    },
  };

  const sync = createConfigSync({
    adapter,
    credentialService: credentials,
    fetchImpl,
    enqueueWrite: async (run) => run(),
  });

  const result = await sync.upload();
  assert.equal(result.status, "ok");
  assert.equal(JSON.stringify(result).includes(SENTINEL_ACCESS), false);
  assert.equal(JSON.stringify(result).includes("gho_refreshed"), false);

  // 刷新发生在 gist 请求之前，且 gist 用的是刷新后的 token。
  const tokenCalls = calls.filter((call) => call.url === TOKEN_ENDPOINT);
  assert.equal(tokenCalls.length, 1);
  const gistCalls = calls.filter((call) => call.url.startsWith("https://api.github.com/gists"));
  assert.ok(gistCalls.length > 0);
  for (const call of gistCalls) {
    assert.equal(call.authorization, "Bearer gho_refreshed");
  }

  const stored = JSON.parse(
    credentials.store.get(GITHUB_TOKEN_SET_CREDENTIAL_KEY) ?? "{}",
  ) as Record<string, unknown>;
  assert.equal(stored.accessToken, "gho_refreshed");
  assert.equal(stored.refreshToken, "ghr_rotated");
  assert.equal(captured.metadata?.gistId, "gist01234567");
});
