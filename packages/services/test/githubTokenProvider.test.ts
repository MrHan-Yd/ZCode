import assert from "node:assert/strict";
import test from "node:test";
import {
  createGithubTokenProvider,
  GITHUB_TOKEN_SET_CREDENTIAL_KEY,
  REFRESH_SKEW_MS,
  type GithubTokenSession,
} from "../src/github/githubTokenProvider.js";
import { GITHUB_OAUTH_CLIENT_ID } from "../src/github/githubAuth.js";

const LEGACY_TOKEN_KEY = "github:oauth:access_token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFakeCredentialService(
  options: { failSaveKeys?: ReadonlySet<string>; failDeleteKeys?: ReadonlySet<string> } = {},
) {
  const store = new Map<string, string>();
  return {
    store,
    load: async (key: string) => store.get(key) ?? null,
    save: async (key: string, value: string) => {
      if (options.failSaveKeys?.has(key)) {
        throw new Error(`save failed for ${key}`);
      }
      store.set(key, value);
    },
    delete: async (key: string) => {
      if (options.failDeleteKeys?.has(key)) {
        throw new Error(`delete failed for ${key}`);
      }
      store.delete(key);
    },
    // 模拟 host 内部 compare-and-delete（真实实现把读取、解密、断言、删除放在同一文件锁内）。
    deleteIf: async (key: string, predicate: (plaintext: string) => boolean) => {
      const current = store.get(key);
      if (current === undefined) return false;
      if (!predicate(current)) return false;
      store.delete(key);
      return true;
    },
  };
}

/** 去掉 deleteIf：模拟只有 load/save/delete 的注入（测试 fake / 未实现该原语的宿主）。 */
function withoutDeleteIf(
  credentials: ReturnType<typeof createFakeCredentialService>,
): Pick<ReturnType<typeof createFakeCredentialService>, "store" | "load" | "save" | "delete"> {
  return {
    store: credentials.store,
    load: credentials.load,
    save: credentials.save,
    delete: credentials.delete,
  };
}

function writeSession(
  credentials: ReturnType<typeof createFakeCredentialService>,
  session: GithubTokenSession,
): Promise<void> {
  return credentials.save(GITHUB_TOKEN_SET_CREDENTIAL_KEY, JSON.stringify(session));
}

function readStoredSession(credentials: ReturnType<typeof createFakeCredentialService>) {
  const raw = credentials.store.get(GITHUB_TOKEN_SET_CREDENTIAL_KEY);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

interface FetchCall {
  readonly body: string;
  readonly headers: Headers;
}

interface FetchMockOptions {
  readonly responses?: readonly unknown[];
  readonly failWith?: Error;
  readonly onRequest?: (call: FetchCall, index: number) => void;
}

/** 刷新 token 端点的 fetch mock：记录请求体/头，返回 responses 队列中对应项。 */
function createRefreshFetch(options: FetchMockOptions = {}): {
  fetchImpl: typeof fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      body: typeof init?.body === "string" ? init.body : "",
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const current = index;
    index += 1;
    options.onRequest?.(call, current);
    if (options.failWith) throw options.failWith;
    const queue = options.responses ?? [];
    const body = queue[current] ?? queue[queue.length - 1] ?? {};
    return jsonResponse(body);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** 捕获 console 输出，用于断言日志里没有 token。 */
async function withCapturedConsole<T>(
  run: () => Promise<T>,
): Promise<{ result: T; output: string }> {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const chunks: string[] = [];
  const record = (...args: unknown[]) => {
    chunks.push(args.map(stringifyArg).join(" "));
  };
  console.log = record as typeof console.log;
  console.warn = record as typeof console.warn;
  console.error = record as typeof console.error;
  try {
    const result = await run();
    return { result, output: chunks.join("\n") };
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
}

test("未过期不刷新：距过期超过 5 分钟时不请求 token 端点", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + REFRESH_SKEW_MS + 1,
  });
  const mock = createRefreshFetch();
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_old",
    refreshed: false,
  });
  assert.equal(mock.calls.length, 0);
});

test("进入 5 分钟窗口刷新：轮换 token 落盘，下一次刷新使用新 refresh token", async () => {
  let now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
    refreshTokenExpiresAt: now + 15897600_000,
  });
  const mock = createRefreshFetch({
    responses: [
      {
        access_token: "gho_new",
        refresh_token: "ghr_new",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
      },
      {
        access_token: "gho_newer",
        refresh_token: "ghr_newer",
        expires_in: 28800,
        refresh_token_expires_in: 15897600,
      },
    ],
  });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_new",
    refreshed: true,
  });
  assert.equal(mock.calls.length, 1);

  const firstBody = new URLSearchParams(mock.calls[0]?.body ?? "");
  // 刷新请求体只有三个字段：不带 client_secret（设备码流程签发的 token 不需要）。
  assert.deepEqual([...firstBody.keys()].sort(), ["client_id", "grant_type", "refresh_token"]);
  assert.equal(firstBody.get("grant_type"), "refresh_token");
  assert.equal(firstBody.get("refresh_token"), "ghr_old");

  const stored = readStoredSession(credentials);
  assert.equal(stored?.accessToken, "gho_new");
  assert.equal(stored?.refreshToken, "ghr_new");
  assert.equal(stored?.accessTokenExpiresAt, now + 28800_000);
  assert.equal(stored?.refreshTokenExpiresAt, now + 15897600_000);
  assert.equal(credentials.store.has(LEGACY_TOKEN_KEY), false);

  // 把时钟推到新 token 的刷新窗口：第二次请求必须使用轮换后的 refresh token。
  now = (stored?.accessTokenExpiresAt as number) - REFRESH_SKEW_MS;
  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_newer",
    refreshed: true,
  });
  const secondBody = new URLSearchParams(mock.calls[1]?.body ?? "");
  assert.equal(secondBody.get("refresh_token"), "ghr_new");
});

test("并发刷新单飞：只产生一次 token 请求，两个调用拿到同一个新 token", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
  });
  const mock = createRefreshFetch({
    responses: [{ access_token: "gho_new", refresh_token: "ghr_new", expires_in: 28800 }],
  });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  const [first, second] = await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
  assert.deepEqual(first, { status: "ok", token: "gho_new", refreshed: true });
  assert.deepEqual(second, { status: "ok", token: "gho_new", refreshed: true });
  assert.equal(mock.calls.length, 1);
});

test("401 后强制刷新：本地未临近过期也会立即轮换", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_rejected",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + 3600_000,
  });
  const mock = createRefreshFetch({
    responses: [{ access_token: "gho_new", refresh_token: "ghr_new", expires_in: 28800 }],
  });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await provider.refreshAfterRejectedToken("gho_rejected"), {
    status: "ok",
    token: "gho_new",
    refreshed: true,
  });
  assert.equal(mock.calls.length, 1);
  assert.equal(new URLSearchParams(mock.calls[0]?.body ?? "").get("refresh_token"), "ghr_old");
});

test("refreshAfterRejectedToken：凭据已被其它调用换成新 token 时直接复用", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_new",
    refreshToken: "ghr_new",
    accessTokenExpiresAt: now + 3600_000,
  });
  const mock = createRefreshFetch();
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await provider.refreshAfterRejectedToken("gho_rejected"), {
    status: "ok",
    token: "gho_new",
    // 复用的是凭据库里的 token（可能是别的 provider 刚写入的），不是本次刷新产物。
    refreshed: false,
  });
  assert.equal(mock.calls.length, 0);
});

test("bad_refresh_token 且重读仍是旧值：清理凭据并要求重新授权", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
  });
  const mock = createRefreshFetch({ responses: [{ error: "bad_refresh_token" }] });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await provider.getAccessToken(), { status: "reauth_required" });
  assert.equal(mock.calls.length, 1);
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), false);
  assert.equal(credentials.store.has(LEGACY_TOKEN_KEY), false);
});

test("bad_refresh_token 且另一 host 已轮换：复用有效新 token，不清理凭据", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
  });
  const mock = createRefreshFetch({
    responses: [{ error: "bad_refresh_token" }],
    onRequest: () => {
      // 模拟另一个 host 在本次刷新失败前已经完成轮换。
      credentials.store.set(
        GITHUB_TOKEN_SET_CREDENTIAL_KEY,
        JSON.stringify({ accessToken: "gho_other", accessTokenExpiresAt: now + 3600_000 }),
      );
    },
  });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_other",
    refreshed: false,
  });
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), true);
});

test("旧 key 迁移：仅 legacy token 时按长期 token 直接返回，不请求刷新", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(LEGACY_TOKEN_KEY, "gho_legacy");
  const mock = createRefreshFetch();
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
  });

  assert.deepEqual(await provider.getSession(), { accessToken: "gho_legacy" });
  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_legacy",
    refreshed: false,
  });
  assert.equal(mock.calls.length, 0);
});

test("网络失败：未过期用旧 token；已过期返回 temporarily_unavailable 且保留凭据", async () => {
  const now = 1_000_000;
  const failWith = new Error("fetch failed");

  const stillValid = createFakeCredentialService();
  await writeSession(stillValid, {
    accessToken: "gho_still_valid",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + 60_000,
  });
  const unexpiredMock = createRefreshFetch({ failWith });
  const unexpiredProvider = createGithubTokenProvider({
    credentialService: stillValid,
    fetchImpl: unexpiredMock.fetchImpl,
    now: () => now,
  });
  assert.deepEqual(await unexpiredProvider.getAccessToken(), {
    status: "ok",
    token: "gho_still_valid",
    refreshed: false,
  });

  const expired = createFakeCredentialService();
  await writeSession(expired, {
    accessToken: "gho_expired",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now - 1,
  });
  const expiredMock = createRefreshFetch({ failWith });
  const expiredProvider = createGithubTokenProvider({
    credentialService: expired,
    fetchImpl: expiredMock.fetchImpl,
    now: () => now,
  });
  const expiredResult = await expiredProvider.getAccessToken();
  assert.deepEqual(expiredResult, { status: "temporarily_unavailable", reason: "network" });
  // 失败结果不得带出 token（成功结果按契约返回 token，不在此断言）。
  assert.equal(JSON.stringify(expiredResult).includes("gho_expired"), false);
  assert.equal(expired.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), true);
});

test("本地 refreshTokenExpiresAt 已过：不发刷新请求，直接要求重新授权", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
    refreshTokenExpiresAt: now - 1,
  });
  const mock = createRefreshFetch();
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await provider.getAccessToken(), { status: "reauth_required" });
  assert.equal(mock.calls.length, 0);
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), false);
});

test("日志不含 access / refresh token", async () => {
  const now = 1_000_000;
  const accessSentinel = "gho_SECRET_SENTINEL_ACCESS";
  const refreshSentinel = "ghr_SECRET_SENTINEL_REFRESH";
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: accessSentinel,
    refreshToken: refreshSentinel,
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
  });
  const mock = createRefreshFetch({
    responses: [
      { access_token: "gho_NEW_SECRET", refresh_token: "ghr_NEW_SECRET", expires_in: 28800 },
    ],
  });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  const { output } = await withCapturedConsole(() => provider.getAccessToken());
  assert.equal(output.includes(accessSentinel), false);
  assert.equal(output.includes(refreshSentinel), false);
  assert.equal(output.includes("gho_NEW_SECRET"), false);
  assert.equal(output.includes("ghr_NEW_SECRET"), false);
});

test("刷新写盘失败：仍返回新 token，但记录 error 且不泄漏 token", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService({
    failSaveKeys: new Set([GITHUB_TOKEN_SET_CREDENTIAL_KEY]),
  });
  // 直接 seed：该 fake 对 token_set 的所有写入都会失败，用于验证刷新结果的持久化失败分支。
  credentials.store.set(
    GITHUB_TOKEN_SET_CREDENTIAL_KEY,
    JSON.stringify({
      accessToken: "gho_old",
      refreshToken: "ghr_old",
      accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
    }),
  );
  const mock = createRefreshFetch({
    responses: [
      { access_token: "gho_NEW_SECRET", refresh_token: "ghr_NEW_SECRET", expires_in: 28800 },
    ],
  });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  const { result, output } = await withCapturedConsole(() => provider.getAccessToken());
  assert.deepEqual(result, { status: "ok", token: "gho_NEW_SECRET", refreshed: true });
  assert.ok(output.includes("could not be persisted"));
  assert.ok(output.includes(GITHUB_TOKEN_SET_CREDENTIAL_KEY));
  assert.equal(output.includes("gho_NEW_SECRET"), false);
  assert.equal(output.includes("ghr_NEW_SECRET"), false);
});

test("saveSession 写入 token set 并删除旧 key；clearSession 删除两个 key", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(LEGACY_TOKEN_KEY, "gho_legacy");
  const mock = createRefreshFetch();
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
  });

  await provider.saveSession({ accessToken: "gho_new", refreshToken: "ghr_new" });
  assert.equal(credentials.store.has(LEGACY_TOKEN_KEY), false);
  assert.deepEqual(readStoredSession(credentials), {
    accessToken: "gho_new",
    refreshToken: "ghr_new",
  });

  await provider.clearSession();
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), false);
  assert.equal(credentials.store.has(LEGACY_TOKEN_KEY), false);
});

test("clearSession：任一 key 删除失败就抛错（仍尝试两个 key），错误不含 token", async () => {
  const credentials = createFakeCredentialService({
    failDeleteKeys: new Set([GITHUB_TOKEN_SET_CREDENTIAL_KEY]),
  });
  await credentials.save(
    GITHUB_TOKEN_SET_CREDENTIAL_KEY,
    JSON.stringify({ accessToken: "gho_SECRET" }),
  );
  await credentials.save(LEGACY_TOKEN_KEY, "gho_legacy");
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: createRefreshFetch().fetchImpl,
  });

  await assert.rejects(provider.clearSession(), (error: Error) => {
    assert.ok(error.message.includes(GITHUB_TOKEN_SET_CREDENTIAL_KEY));
    // 错误只带 key 名，绝不带 token。
    assert.equal(error.message.includes("gho_SECRET"), false);
    return true;
  });
  // 第一个 key 失败不能阻止第二个 key 的删除尝试。
  assert.equal(credentials.store.has(LEGACY_TOKEN_KEY), false);
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), true);
});

test("内部自动清理失败：仍返回 reauth_required，不把清理异常抛给调用方", async () => {
  const now = 1_000_000;
  const cases: ReadonlyArray<{ readonly name: string; readonly session: GithubTokenSession }> = [
    {
      name: "缺少 refresh token",
      session: { accessToken: "gho_old", accessTokenExpiresAt: now - 1 },
    },
    {
      name: "refresh token 本地已过期",
      session: {
        accessToken: "gho_old",
        refreshToken: "ghr_old",
        accessTokenExpiresAt: now - 1,
        refreshTokenExpiresAt: now - 1,
      },
    },
  ];

  for (const { name, session } of cases) {
    const credentials = createFakeCredentialService({
      failDeleteKeys: new Set([GITHUB_TOKEN_SET_CREDENTIAL_KEY, LEGACY_TOKEN_KEY]),
    });
    await writeSession(credentials, session);
    const mock = createRefreshFetch();
    const provider = createGithubTokenProvider({
      credentialService: credentials,
      fetchImpl: mock.fetchImpl,
      now: () => now,
    });

    assert.deepEqual(await provider.getAccessToken(), { status: "reauth_required" }, name);
    // 清理失败时凭据可能残留，但语义仍是「需要重新授权」，且不发刷新请求。
    assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), true, name);
    assert.equal(mock.calls.length, 0, name);
  }
});

// ===== 凭据损坏与新旧 key 迁移边界 =====

test("token_set 不是合法 JSON：按不存在处理、不删除，并回退旧 key", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(GITHUB_TOKEN_SET_CREDENTIAL_KEY, "{ not json");
  await credentials.save(LEGACY_TOKEN_KEY, "gho_legacy");
  const mock = createRefreshFetch();
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
  });

  assert.deepEqual(await provider.getSession(), { accessToken: "gho_legacy" });
  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_legacy",
    refreshed: false,
  });
  assert.equal(mock.calls.length, 0);
  // 只告警、不自动删除：删除会丢掉可诊断现场，而且登录时本来就会覆盖。
  assert.equal(credentials.store.get(GITHUB_TOKEN_SET_CREDENTIAL_KEY), "{ not json");
});

test("token_set 缺 accessToken / 过期时间非法 / 形状非法：按不存在处理、不删除，回退旧 key", async () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly raw: string }> = [
    { name: "缺少 accessToken", raw: JSON.stringify({ refreshToken: "ghr_x" }) },
    { name: "accessToken 为空串", raw: JSON.stringify({ accessToken: "   " }) },
    {
      name: "accessTokenExpiresAt 非法",
      raw: JSON.stringify({ accessToken: "gho_bad", accessTokenExpiresAt: "tomorrow" }),
    },
    {
      name: "refreshTokenExpiresAt 非法",
      raw: JSON.stringify({ accessToken: "gho_bad", refreshTokenExpiresAt: -1 }),
    },
    { name: "JSON 数组", raw: JSON.stringify(["gho_bad"]) },
    { name: "JSON null", raw: "null" },
  ];

  for (const { name, raw } of cases) {
    const credentials = createFakeCredentialService();
    await credentials.save(GITHUB_TOKEN_SET_CREDENTIAL_KEY, raw);
    await credentials.save(LEGACY_TOKEN_KEY, "gho_legacy");
    const mock = createRefreshFetch();
    const provider = createGithubTokenProvider({
      credentialService: credentials,
      fetchImpl: mock.fetchImpl,
    });

    assert.deepEqual(await provider.getSession(), { accessToken: "gho_legacy" }, name);
    assert.deepEqual(
      await provider.getAccessToken(),
      { status: "ok", token: "gho_legacy", refreshed: false },
      name,
    );
    assert.equal(mock.calls.length, 0, name);
    assert.equal(credentials.store.get(GITHUB_TOKEN_SET_CREDENTIAL_KEY), raw, name);
  }
});

test("新旧 key 同时存在：始终以 token_set 为准，旧 key 不参与", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_new",
    refreshToken: "ghr_new",
    accessTokenExpiresAt: now + 3600_000,
  });
  await credentials.save(LEGACY_TOKEN_KEY, "gho_legacy");
  const mock = createRefreshFetch();
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await provider.getSession(), {
    accessToken: "gho_new",
    refreshToken: "ghr_new",
    accessTokenExpiresAt: now + 3600_000,
  });
  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_new",
    refreshed: false,
  });
  assert.equal(mock.calls.length, 0);
});

test("旧 key 删除失败不影响 saveSession：新 token set 已落盘，只告警不抛错", async () => {
  const credentials = createFakeCredentialService({
    failDeleteKeys: new Set([LEGACY_TOKEN_KEY]),
  });
  await credentials.save(LEGACY_TOKEN_KEY, "gho_legacy");
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: createRefreshFetch().fetchImpl,
  });

  const { output } = await withCapturedConsole(() =>
    provider.saveSession({ accessToken: "gho_new", refreshToken: "ghr_new" }),
  );
  assert.deepEqual(readStoredSession(credentials), {
    accessToken: "gho_new",
    refreshToken: "ghr_new",
  });
  // 旧 key 残留只是无效副本，不影响登录态；但必须留下可诊断的告警。
  assert.equal(credentials.store.get(LEGACY_TOKEN_KEY), "gho_legacy");
  assert.ok(output.includes("could not be removed"));
  assert.equal(output.includes("gho_new"), false);
});

// ===== 刷新轮换的字段边界 =====

test("刷新成功但未返回 refresh_token：新 token set 不保留已作废的旧 refresh token", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
    refreshTokenExpiresAt: now + 15897600_000,
  });
  const mock = createRefreshFetch({
    responses: [{ access_token: "gho_new", expires_in: 28800 }],
  });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_new",
    refreshed: true,
  });
  const stored = readStoredSession(credentials);
  assert.deepEqual(stored, {
    accessToken: "gho_new",
    accessTokenExpiresAt: now + 28800_000,
  });
  // GitHub 刷新即轮换，旧 refresh token 已作废，不能留在新 token set 里。
  assert.equal("refreshToken" in (stored ?? {}), false);
});

test("refresh_token_expires_in 缺失：新 token set 不写 refreshTokenExpiresAt", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
    refreshTokenExpiresAt: now + 15897600_000,
  });
  const mock = createRefreshFetch({
    responses: [{ access_token: "gho_new", refresh_token: "ghr_new", expires_in: 28800 }],
  });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_new",
    refreshed: true,
  });
  const stored = readStoredSession(credentials);
  assert.equal(stored?.accessToken, "gho_new");
  assert.equal(stored?.refreshToken, "ghr_new");
  assert.equal(stored?.accessTokenExpiresAt, now + 28800_000);
  // 新 refresh token 的寿命未知：不能沿用旧 token 的过期时间。
  assert.equal("refreshTokenExpiresAt" in (stored ?? {}), false);
});

// ===== 刷新失败语义 =====

test("强制刷新遇到网络失败：返回 temporarily_unavailable，绝不返回被拒旧 token", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_rejected",
    refreshToken: "ghr_old",
    // 本地仍未过期，但 GitHub 已明确 401：强制刷新不允许回退到同一个 token。
    accessTokenExpiresAt: now + 3600_000,
  });
  const mock = createRefreshFetch({ failWith: new Error("fetch failed") });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  const { result, output } = await withCapturedConsole(() =>
    provider.refreshAfterRejectedToken("gho_rejected"),
  );
  assert.deepEqual(result, { status: "temporarily_unavailable", reason: "network" });
  assert.equal(JSON.stringify(result).includes("gho_rejected"), false);
  assert.equal(mock.calls.length, 1);
  // 凭据保留：网络问题是可恢复的，不能引导用户重新登录。
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), true);
  assert.equal(output.includes("gho_rejected"), false);
  assert.equal(output.includes("ghr_old"), false);
});

test("强制刷新返回其它 GitHub 错误：temporarily_unavailable 且保留凭据，日志只记错误码", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_rejected",
    refreshToken: "ghr_SECRET",
    accessTokenExpiresAt: now + 3600_000,
  });
  const mock = createRefreshFetch({
    responses: [{ error: "incorrect_client_credentials" }],
  });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  const { result, output } = await withCapturedConsole(() =>
    provider.refreshAfterRejectedToken("gho_rejected"),
  );
  assert.deepEqual(result, {
    status: "temporarily_unavailable",
    reason: "configuration",
  });
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), true);
  assert.ok(output.includes("incorrect_client_credentials"));
  assert.equal(output.includes("gho_rejected"), false);
  assert.equal(output.includes("ghr_SECRET"), false);
});

test("单飞复用普通刷新兜底结果时：被 401 拒绝的旧 token 不得当成功返回", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_rejected",
    refreshToken: "ghr_old",
    // 已进入刷新窗口但尚未过期：普通刷新网络失败会回退到当前 token。
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
  });

  let releaseFetch!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    await gate;
    throw new Error("fetch failed");
  }) as typeof fetch;
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl,
    now: () => now,
  });

  const normal = provider.getAccessToken();
  // 让普通刷新成功进入单飞位置（fetch 被 gate 挂起）。
  await new Promise((resolve) => setTimeout(resolve, 0));
  const forced = provider.refreshAfterRejectedToken("gho_rejected");
  releaseFetch();
  const [normalResult, forcedResult] = await Promise.all([normal, forced]);

  // 普通调用可以回退到未过期 token；强制调用不能复用这个兜底结果。
  assert.deepEqual(normalResult, { status: "ok", token: "gho_rejected", refreshed: false });
  assert.deepEqual(forcedResult, { status: "temporarily_unavailable", reason: "network" });
  assert.equal(calls, 1);
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), true);
});

// ===== 刷新请求形状（无 client secret） =====

test("刷新请求体：只有 client_id / grant_type / refresh_token，绝不含 client_secret", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
  });
  const mock = createRefreshFetch({
    responses: [{ access_token: "gho_new", refresh_token: "ghr_new", expires_in: 28800 }],
  });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    clientId: GITHUB_OAUTH_CLIENT_ID,
    now: () => now,
  });

  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_new",
    refreshed: true,
  });
  const body = mock.calls[0]?.body ?? "";
  const params = new URLSearchParams(body);
  assert.deepEqual([...params.keys()].sort(), ["client_id", "grant_type", "refresh_token"]);
  assert.equal(params.get("client_id"), GITHUB_OAUTH_CLIENT_ID);
  assert.equal(params.has("client_secret"), false);
  // 设备码流程签发的 token 刷新不需要 secret；出现即说明有人“补”上了它。
  assert.equal(body.includes("client_secret"), false);
});

// ===== 登出压过在飞刷新（会话代际） =====

test("登出压过在飞刷新：clearSession 后到达的刷新成功结果不写回，返回 none", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
  });

  let releaseFetch!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const fetchImpl = (async () => {
    await gate;
    return jsonResponse({ access_token: "gho_new", refresh_token: "ghr_new", expires_in: 28800 });
  }) as typeof fetch;
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl,
    now: () => now,
  });

  const pending = provider.getAccessToken();
  // 让刷新请求进入在飞状态（fetch 被 gate 挂起）。
  await new Promise((resolve) => setTimeout(resolve, 0));
  await provider.clearSession();
  releaseFetch();

  // 代际已变：结果必须丢弃，不能把凭据写回。
  assert.deepEqual(await pending, { status: "none" });
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), false);
  assert.equal(credentials.store.has(LEGACY_TOKEN_KEY), false);
  // 后续调用同样读到“未登录”。
  assert.deepEqual(await provider.getAccessToken(), { status: "none" });
});

test("登出压过在飞刷新：网络失败也不回退到已删除的旧 token", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_still_valid",
    refreshToken: "ghr_old",
    // 本地仍未过期：若没有代际判断，网络失败会回退成 ok + 旧 token。
    accessTokenExpiresAt: now + 60_000,
  });

  let releaseFetch!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });
  const fetchImpl = (async () => {
    await gate;
    throw new Error("fetch failed");
  }) as typeof fetch;
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl,
    now: () => now,
  });

  const pending = provider.refreshAfterRejectedToken("gho_still_valid");
  await new Promise((resolve) => setTimeout(resolve, 0));
  await provider.clearSession();
  releaseFetch();

  assert.deepEqual(await pending, { status: "none" });
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), false);
});

// ===== 跨 provider / 跨 Host 竞争：compare-and-delete =====

test("跨 provider 竞争：A 已轮换成功，B 用旧 RT 收到 bad_refresh_token → 复用 A 的 token 且不删凭据", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
  });

  // B 先读到旧 session 并进入刷新（请求被 gate 挂起）。
  let releaseB!: () => void;
  const gateB = new Promise<void>((resolve) => {
    releaseB = resolve;
  });
  const fetchB = (async () => {
    await gateB;
    return jsonResponse({ error: "bad_refresh_token" });
  }) as typeof fetch;
  const providerB = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: fetchB,
    now: () => now,
  });
  const pendingB = providerB.getAccessToken();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // A（另一个 provider / Host）用同一个旧 refresh token 抢先完成轮换。
  const fetchA = createRefreshFetch({
    responses: [{ access_token: "gho_a", refresh_token: "ghr_a", expires_in: 28800 }],
  });
  const providerA = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: fetchA.fetchImpl,
    now: () => now,
  });
  assert.deepEqual(await providerA.getAccessToken(), {
    status: "ok",
    token: "gho_a",
    refreshed: true,
  });

  // B 的失败响应此刻才到：重读看到 A 的新值，直接复用，不删除。
  releaseB();
  assert.deepEqual(await pendingB, { status: "ok", token: "gho_a", refreshed: false });
  assert.equal(readStoredSession(credentials)?.accessToken, "gho_a");
});

test("bad_refresh_token 的删除是 compare-and-delete：判断时值已被替换则不删（谓词不匹配）", async () => {
  const now = 1_000_000;
  const base = createFakeCredentialService();
  await writeSession(base, {
    accessToken: "gho_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
  });

  let replaceBeforeDelete: (() => void) | null = null;
  const credentials = {
    ...base,
    // 模拟 TOCTOU：B 的 deleteIf 已进入文件锁，但真正删除前 A 完成了轮换写入。
    deleteIf: async (key: string, predicate: (plaintext: string) => boolean) => {
      if (replaceBeforeDelete) {
        const replace = replaceBeforeDelete;
        replaceBeforeDelete = null;
        replace();
      }
      const current = base.store.get(key);
      if (current === undefined) return false;
      if (!predicate(current)) return false;
      base.store.delete(key);
      return true;
    },
  };
  const mock = createRefreshFetch({ responses: [{ error: "bad_refresh_token" }] });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });
  replaceBeforeDelete = () => {
    base.store.set(
      GITHUB_TOKEN_SET_CREDENTIAL_KEY,
      JSON.stringify({
        accessToken: "gho_a",
        refreshToken: "ghr_a",
        accessTokenExpiresAt: now + 3600_000,
      }),
    );
  };

  // 谓词基于「本次失败的旧值」，与 A 新写入的值不匹配：不能删，并复用新值。
  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_a",
    refreshed: false,
  });
  assert.equal(readStoredSession(base)?.accessToken, "gho_a");
});

test("没有 deleteIf 的注入：bad_refresh_token 不删除凭据（保守路径）", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService();
  await writeSession(credentials, {
    accessToken: "gho_old",
    refreshToken: "ghr_old",
    accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
  });
  const mock = createRefreshFetch({ responses: [{ error: "bad_refresh_token" }] });
  const provider = createGithubTokenProvider({
    credentialService: withoutDeleteIf(credentials),
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await provider.getAccessToken(), { status: "reauth_required" });
  // 不具备 compare-and-delete 时宁可保留一条失效凭据，也不能误删别处写入的新值。
  assert.equal(credentials.store.has(GITHUB_TOKEN_SET_CREDENTIAL_KEY), true);
});

// ===== 写盘失败后的同进程内存兜底 =====

test("写盘失败后同进程继续使用新 token：不重读旧 RT、不触发 reauth_required", async () => {
  const now = 1_000_000;
  const credentials = createFakeCredentialService({
    failSaveKeys: new Set([GITHUB_TOKEN_SET_CREDENTIAL_KEY]),
  });
  credentials.store.set(
    GITHUB_TOKEN_SET_CREDENTIAL_KEY,
    JSON.stringify({
      accessToken: "gho_old",
      refreshToken: "ghr_old",
      accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
    }),
  );
  const mock = createRefreshFetch({
    responses: [{ access_token: "gho_new", refresh_token: "ghr_new", expires_in: 28800 }],
  });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_new",
    refreshed: true,
  });
  // 第二次调用必须命中内存兜底，而不是重读磁盘上已作废的旧 refresh token。
  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_new",
    refreshed: false,
  });
  assert.equal(mock.calls.length, 1);
  // 磁盘仍是旧值（写盘失败），但同进程内不会再逼用户重新登录。
  assert.equal(readStoredSession(credentials)?.accessToken, "gho_old");
});

test("写盘失败后被外部登录覆盖：外部 saveSession 成功即清空内存兜底", async () => {
  const now = 1_000_000;
  let failSave = true;
  const store = new Map<string, string>();
  const credentials = {
    store,
    load: async (key: string) => store.get(key) ?? null,
    save: async (key: string, value: string) => {
      if (key === GITHUB_TOKEN_SET_CREDENTIAL_KEY && failSave) {
        throw new Error("save failed");
      }
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    deleteIf: async (key: string, predicate: (plaintext: string) => boolean) => {
      const current = store.get(key);
      if (current === undefined || !predicate(current)) return false;
      store.delete(key);
      return true;
    },
  };
  store.set(
    GITHUB_TOKEN_SET_CREDENTIAL_KEY,
    JSON.stringify({
      accessToken: "gho_old",
      refreshToken: "ghr_old",
      accessTokenExpiresAt: now + REFRESH_SKEW_MS - 1,
    }),
  );
  const mock = createRefreshFetch({
    responses: [
      { access_token: "gho_refreshed", refresh_token: "ghr_refreshed", expires_in: 28800 },
    ],
  });
  const provider = createGithubTokenProvider({
    credentialService: credentials,
    fetchImpl: mock.fetchImpl,
    now: () => now,
  });

  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_refreshed",
    refreshed: true,
  });
  // 模拟用户在另一个窗口重新登录：此时写盘恢复成功。
  failSave = false;
  await provider.saveSession({ accessToken: "gho_login", refreshToken: "ghr_login" });
  assert.deepEqual(await provider.getSession(), {
    accessToken: "gho_login",
    refreshToken: "ghr_login",
  });
  assert.deepEqual(await provider.getAccessToken(), {
    status: "ok",
    token: "gho_login",
    refreshed: false,
  });
  assert.equal(mock.calls.length, 1);
});
