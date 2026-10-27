import assert from "node:assert/strict";
import test from "node:test";
import { createGithubAuthService } from "../src/github/githubAuthService.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const TOKEN_KEY = "github:oauth:access_token";
const TOKEN_SET_KEY = "github:oauth:token_set";

// 一个能被断言“未泄漏”的哨兵 token；测试会检查它不出现在返回值与日志里。
const SECRET_TOKEN = "gho_SECRET_SENTINEL_1234567890";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createFakeCredentialService() {
  const store = new Map<string, string>();
  return {
    store,
    load: async (key: string) => store.get(key) ?? null,
    save: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
    // 与 host 内部原语同形状：bad_refresh_token 的 compare-and-delete 依赖它。
    deleteIf: async (key: string, predicate: (plaintext: string) => boolean) => {
      const current = store.get(key);
      if (current === undefined || !predicate(current)) return false;
      store.delete(key);
      return true;
    },
  };
}

interface FetchMockOptions {
  readonly deviceCode?: unknown;
  readonly deviceCodeRaw?: string;
  readonly failDeviceCodeWith?: Error;
  readonly tokenQueue?: readonly unknown[];
  readonly user?: unknown;
  readonly userStatus?: number;
  /** `/user` 请求直接抛错（网络异常），用于「已连接但账号名暂不可得」。 */
  readonly failUserWith?: Error;
  /** 按顺序消费的 /user 响应；用于「401 → 刷新 → 重试 200」场景。 */
  readonly userQueue?: readonly { readonly body: unknown; readonly status?: number }[];
  readonly calls?: string[];
  readonly failTokenWith?: Error;
}

/** 按 URL 路由的 fetch mock；token 端点按 tokenQueue 顺序消费，耗尽后复用最后一项。 */
function createFetchMock(options: FetchMockOptions): typeof fetch {
  let tokenIndex = 0;
  let userIndex = 0;
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    options.calls?.push(url);
    if (url === DEVICE_CODE_URL) {
      if (options.failDeviceCodeWith) throw options.failDeviceCodeWith;
      if (options.deviceCodeRaw !== undefined) {
        return new Response(options.deviceCodeRaw, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return jsonResponse(options.deviceCode ?? {});
    }
    if (url === ACCESS_TOKEN_URL) {
      if (options.failTokenWith) throw options.failTokenWith;
      const queue = options.tokenQueue ?? [];
      const body = queue[tokenIndex] ?? queue[queue.length - 1] ?? {};
      tokenIndex += 1;
      return jsonResponse(body);
    }
    if (url === USER_URL) {
      if (options.failUserWith) throw options.failUserWith;
      const queue = options.userQueue;
      if (queue && queue.length > 0) {
        const entry = queue[userIndex] ?? queue[queue.length - 1];
        userIndex += 1;
        return jsonResponse(entry?.body ?? {}, entry?.status ?? 200);
      }
      return jsonResponse(options.user ?? {}, options.userStatus ?? 200);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
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

test("begin 成功 → 连续 authorization_pending → 成功，token 落盘且 getAccount 可读", async () => {
  const credentials = createFakeCredentialService();
  // 旧版本只写过旧 key：登录成功后应被删除，避免残留失效副本。
  await credentials.save(TOKEN_KEY, "gho_legacy");
  const calls: string[] = [];
  const fetchImpl = createFetchMock({
    deviceCode: {
      device_code: "device-1",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    },
    tokenQueue: [
      { error: "authorization_pending" },
      { error: "authorization_pending" },
      {
        access_token: SECRET_TOKEN,
        token_type: "bearer",
        scope: "gist read:user",
        expires_in: 28800,
        refresh_token: "ghr_SECRET_SENTINEL_1234567890",
        refresh_token_expires_in: 15897600,
      },
    ],
    user: { login: "octocat", name: "The Octocat", avatar_url: "https://avatars.test/u/1" },
    calls,
  });

  const service = createGithubAuthService({ credentialService: credentials, fetchImpl });
  const { output } = await withCapturedConsole(async () => {
    const begin = await service.beginDeviceAuth();
    assert.equal(begin.status, "ok");
    if (begin.status !== "ok") throw new Error("expected ok");
    // 判别联合：ok 时这些字段全部必填（类型层面堵掉「ok 却没设备码」的洞）。
    assert.equal(begin.deviceCode, "device-1");
    assert.equal(begin.userCode, "ABCD-1234");
    assert.equal(begin.verificationUri, "https://github.com/login/device");
    assert.equal(begin.interval, 5);
    assert.ok(begin.expiresAt > Date.now());

    const first = await service.pollDeviceAuth({ deviceCode: "device-1" });
    assert.deepEqual(first, { status: "pending", interval: 5 });

    // UI 把上次间隔回传；authorization_pending 保持当前节奏。
    const second = await service.pollDeviceAuth({
      deviceCode: "device-1",
      interval: first.interval,
    });
    assert.deepEqual(second, { status: "pending", interval: 5 });

    const done = await service.pollDeviceAuth({ deviceCode: "device-1" });
    assert.equal(done.status, "success");
    assert.equal(done.account?.login, "octocat");
    assert.equal(done.account?.name, "The Octocat");
    assert.equal(done.account?.avatarUrl, "https://avatars.test/u/1");

    // token set 确实写进凭据服务；旧 key 被删除。
    const stored = JSON.parse(credentials.store.get(TOKEN_SET_KEY) ?? "{}") as Record<
      string,
      unknown
    >;
    assert.equal(stored.accessToken, SECRET_TOKEN);
    assert.equal(stored.refreshToken, "ghr_SECRET_SENTINEL_1234567890");
    assert.equal(typeof stored.accessTokenExpiresAt, "number");
    assert.equal(typeof stored.refreshTokenExpiresAt, "number");
    assert.equal(credentials.store.has(TOKEN_KEY), false);

    const account = await service.getAccount();
    assert.deepEqual(account, {
      connected: true,
      login: "octocat",
      name: "The Octocat",
      avatarUrl: "https://avatars.test/u/1",
    });

    // 返回值不含 access_token 字段，也不含 token 明文。
    assert.equal("access_token" in done, false);
    assert.equal(JSON.stringify(done).includes(SECRET_TOKEN), false);
    assert.equal(JSON.stringify(account).includes(SECRET_TOKEN), false);
    return done;
  });

  // 日志绝不带出 token。
  assert.equal(output.includes(SECRET_TOKEN), false);
  assert.ok(calls.includes(DEVICE_CODE_URL));
  assert.ok(calls.includes(USER_URL));
});

test("slow_down 返回 pending 且在入参 interval 上 +5 递进（缺省 5→10）", async () => {
  const credentials = createFakeCredentialService();
  const fetchImpl = createFetchMock({ tokenQueue: [{ error: "slow_down" }] });
  const service = createGithubAuthService({ credentialService: credentials, fetchImpl });

  // 缺省调用：按默认 5 处理 → 10。
  const defaultPoll = await service.pollDeviceAuth({ deviceCode: "device-1" });
  assert.deepEqual(defaultPoll, { status: "pending", interval: 10 });

  // UI 回传上次的 10 → 15，实现无状态递进。
  const progressed = await service.pollDeviceAuth({ deviceCode: "device-1", interval: 10 });
  assert.deepEqual(progressed, { status: "pending", interval: 15 });
});

test("expired_token / access_denied / device_flow_disabled 分别映射", async () => {
  const cases: ReadonlyArray<{ error: string; status: string }> = [
    { error: "expired_token", status: "expired" },
    { error: "access_denied", status: "denied" },
    { error: "device_flow_disabled", status: "device_flow_disabled" },
  ];
  for (const { error, status } of cases) {
    const credentials = createFakeCredentialService();
    const fetchImpl = createFetchMock({ tokenQueue: [{ error }] });
    const service = createGithubAuthService({ credentialService: credentials, fetchImpl });
    const poll = await service.pollDeviceAuth({ deviceCode: "device-1" });
    assert.equal(poll.status, status, `error=${error}`);
  }
});

test("未知 error / 网络异常 → error 且 message 不含 token", async () => {
  const credentials = createFakeCredentialService();
  const unknownError = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({ tokenQueue: [{ error: "incorrect_device_code" }] }),
  });
  const unknown = await unknownError.pollDeviceAuth({ deviceCode: "device-1" });
  assert.equal(unknown.status, "error");
  assert.ok(unknown.message && unknown.message.includes("incorrect_device_code"));

  const networkFail = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({ failTokenWith: new Error("socket hang up") }),
  });
  const failed = await networkFail.pollDeviceAuth({ deviceCode: "device-1" });
  assert.equal(failed.status, "error");
  assert.ok(failed.message?.includes("网络异常"));
  assert.equal(JSON.stringify(failed).includes("access_token"), false);
});

test("网络异常带上 cause 链：undici 只报 fetch failed，真因在 cause 上", async () => {
  const credentials = createFakeCredentialService();
  // 复刻真实形态：fetch 抛 "fetch failed"，底层原因挂在 cause 上
  // （例如未配置代理时直连 github.com 的连接超时）。
  const cause = Object.assign(
    new Error("Connect Timeout Error (attempted address: github.com:443)"),
    { code: "UND_ERR_CONNECT_TIMEOUT" },
  );
  const fetchFailed = Object.assign(new Error("fetch failed"), { cause });
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({ failTokenWith: fetchFailed }),
  });
  const result = await service.pollDeviceAuth({ deviceCode: "device-1" });
  assert.equal(result.status, "error");
  // 只报 "fetch failed" 无法定位问题；必须带出底层 code。
  assert.ok(result.message?.includes("UND_ERR_CONNECT_TIMEOUT"));
  assert.ok(result.message?.includes("fetch failed"));
  assert.equal(JSON.stringify(result).includes("access_token"), false);
});

test("client id 未配置时 begin 返回 not_configured 且不发请求", async () => {
  const credentials = createFakeCredentialService();
  const calls: string[] = [];
  const service = createGithubAuthService({
    credentialService: credentials,
    clientId: "",
    fetchImpl: createFetchMock({ calls }),
  });
  const begin = await service.beginDeviceAuth();
  assert.deepEqual(begin, { status: "not_configured" });
  assert.equal(calls.length, 0);
});

test("begin：device_flow_disabled 单独成状态，不抛异常", async () => {
  const credentials = createFakeCredentialService();
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({ deviceCode: { error: "device_flow_disabled" } }),
  });
  assert.deepEqual(await service.beginDeviceAuth(), { status: "device_flow_disabled" });
});

test("begin：未知 error / 缺 device_code / 非法响应 → status error（不抛）", async () => {
  const credentials = createFakeCredentialService();

  const unknownError = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({ deviceCode: { error: "incorrect_client_credentials" } }),
  });
  const unknown = await unknownError.beginDeviceAuth();
  assert.equal(unknown.status, "error");
  assert.ok(unknown.message?.includes("incorrect_client_credentials"));

  const missingCode = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({ deviceCode: { user_code: "ABCD-1234" } }),
  });
  const missing = await missingCode.beginDeviceAuth();
  assert.equal(missing.status, "error");
  assert.ok(missing.message?.includes("missing_device_code"));

  // 有 device_code 但缺 user_code / verification_uri：落到 error 并点明缺哪个字段，不硬凑空串让 ok 成立。
  const missingUserCode = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({
      deviceCode: { device_code: "d", verification_uri: "https://github.com/login/device" },
    }),
  });
  const noUserCode = await missingUserCode.beginDeviceAuth();
  assert.equal(noUserCode.status, "error");
  assert.ok(noUserCode.message?.includes("user_code"));

  const missingUri = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({ deviceCode: { device_code: "d", user_code: "ABCD-1234" } }),
  });
  const noUri = await missingUri.beginDeviceAuth();
  assert.equal(noUri.status, "error");
  assert.ok(noUri.message?.includes("verification_uri"));

  const invalidResponse = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({ deviceCodeRaw: "{ not json" }),
  });
  const invalid = await invalidResponse.beginDeviceAuth();
  assert.equal(invalid.status, "error");
  assert.ok(invalid.message?.includes("合法 JSON"));
});

test("begin：网络异常仍抛异常（真正的意外）", async () => {
  const credentials = createFakeCredentialService();
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({ failDeviceCodeWith: new Error("socket hang up") }),
  });
  await assert.rejects(service.beginDeviceAuth());
});

test("getAccount：/user 401 → 刷新成功 → 重试 200，凭据不删除且 token set 轮换", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(
    TOKEN_SET_KEY,
    JSON.stringify({
      accessToken: SECRET_TOKEN,
      refreshToken: "ghr_old",
      accessTokenExpiresAt: Date.now() + 3600_000,
      refreshTokenExpiresAt: Date.now() + 15897600_000,
    }),
  );
  const calls: string[] = [];
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({
      calls,
      // 第一次 /user 401，刷新后重试返回账号。
      userQueue: [
        { status: 401, body: { message: "Bad credentials" } },
        { status: 200, body: { login: "octocat", name: "The Octocat" } },
      ],
      tokenQueue: [
        {
          access_token: "gho_NEW_SECRET",
          refresh_token: "ghr_new",
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
        },
      ],
    }),
  });

  const account = await service.getAccount();
  assert.deepEqual(account, { connected: true, login: "octocat", name: "The Octocat" });

  const stored = JSON.parse(credentials.store.get(TOKEN_SET_KEY) ?? "{}") as Record<
    string,
    unknown
  >;
  assert.equal(stored.accessToken, "gho_NEW_SECRET");
  assert.equal(stored.refreshToken, "ghr_new");
  assert.equal(calls.filter((url) => url === ACCESS_TOKEN_URL).length, 1);
  assert.equal(calls.filter((url) => url === USER_URL).length, 2);
});

test("getAccount：401 后刷新失败（bad_refresh_token）→ 清理凭据并返回 reauth_required", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(
    TOKEN_SET_KEY,
    JSON.stringify({
      accessToken: SECRET_TOKEN,
      refreshToken: "ghr_old",
      accessTokenExpiresAt: Date.now() + 3600_000,
    }),
  );
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({
      userStatus: 401,
      // 只有 GitHub 自己的 Bad credentials 才算授权撤销（代理 401 不算）。
      user: { message: "Bad credentials" },
      tokenQueue: [{ error: "bad_refresh_token" }],
    }),
  });

  const account = await service.getAccount();
  assert.deepEqual(account, { connected: false, reason: "reauth_required" });
  assert.equal(credentials.store.has(TOKEN_SET_KEY), false);
  assert.equal(credentials.store.has(TOKEN_KEY), false);
});

test("getAccount：401 后刷新网络失败 → connected true + unverified，凭据保留", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(
    TOKEN_SET_KEY,
    JSON.stringify({
      accessToken: SECRET_TOKEN,
      refreshToken: "ghr_old",
      accessTokenExpiresAt: Date.now() + 3600_000,
    }),
  );
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({
      userStatus: 401,
      user: { message: "Bad credentials" },
      failTokenWith: new Error("fetch failed"),
    }),
  });

  assert.deepEqual(await service.getAccount(), { connected: true, reason: "unverified" });
  assert.equal(credentials.store.has(TOKEN_SET_KEY), true);
});

test("getAccount：无 token 时为未连接，不请求 /user", async () => {
  const credentials = createFakeCredentialService();
  const calls: string[] = [];
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({ calls }),
  });
  assert.deepEqual(await service.getAccount(), { connected: false });
  assert.equal(calls.includes(USER_URL), false);
});

test("signOut 删除凭据（token set 与旧 key）", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(TOKEN_KEY, SECRET_TOKEN);
  await credentials.save(
    TOKEN_SET_KEY,
    JSON.stringify({ accessToken: SECRET_TOKEN, refreshToken: "ghr_old" }),
  );
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({}),
  });
  await service.signOut();
  assert.equal(credentials.store.has(TOKEN_KEY), false);
  assert.equal(credentials.store.has(TOKEN_SET_KEY), false);
});

test("signOut：删除任一 key 失败时上抛（不宣称已退出），仍尝试两个 key 且错误不含 token", async () => {
  const base = createFakeCredentialService();
  await base.save(TOKEN_KEY, SECRET_TOKEN);
  await base.save(
    TOKEN_SET_KEY,
    JSON.stringify({ accessToken: SECRET_TOKEN, refreshToken: "ghr_old" }),
  );
  const credentials = {
    ...base,
    // 只有 token_set 删除失败；旧 key 删除必须照常执行。
    delete: async (key: string) => {
      if (key === TOKEN_SET_KEY) throw new Error(`delete failed for ${key}`);
      base.store.delete(key);
    },
  };
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({}),
  });

  await assert.rejects(service.signOut(), (error: Error) => {
    assert.ok(error.message.includes(TOKEN_SET_KEY));
    assert.equal(error.message.includes(SECRET_TOKEN), false);
    return true;
  });
  // 第一个 key 失败不能跳过第二个：旧 key 已被删除。
  assert.equal(base.store.has(TOKEN_KEY), false);
  assert.equal(base.store.has(TOKEN_SET_KEY), true);
});

test("getAccount：/user 网络失败 → connected true + unverified，凭据保留且不重试刷新", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(
    TOKEN_SET_KEY,
    JSON.stringify({
      accessToken: SECRET_TOKEN,
      refreshToken: "ghr_old",
      // 未过期：不触发刷新，直接请求 /user。
      accessTokenExpiresAt: Date.now() + 3600_000,
    }),
  );
  const calls: string[] = [];
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({
      calls,
      failUserWith: new Error("fetch failed"),
      tokenQueue: [{ access_token: "gho_SHOULD_NOT_BE_USED", expires_in: 28800 }],
    }),
  });

  const account = await service.getAccount();
  assert.deepEqual(account, { connected: true, reason: "unverified" });
  assert.equal(JSON.stringify(account).includes(SECRET_TOKEN), false);
  // 网络失败不等于授权失效：不清凭据、也不触发刷新。
  assert.equal(credentials.store.has(TOKEN_SET_KEY), true);
  assert.equal(calls.filter((url) => url === USER_URL).length, 1);
  assert.equal(calls.filter((url) => url === ACCESS_TOKEN_URL).length, 0);
});

test("getAccount：401 → 刷新成功但重试 /user 仍 401 → 清理凭据并返回 reauth_required", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(TOKEN_KEY, "gho_legacy");
  await credentials.save(
    TOKEN_SET_KEY,
    JSON.stringify({
      accessToken: SECRET_TOKEN,
      refreshToken: "ghr_old",
      accessTokenExpiresAt: Date.now() + 3600_000,
    }),
  );
  const calls: string[] = [];
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({
      calls,
      // 刷新后的新 token 仍被拒：此时才判定授权失效。
      userQueue: [
        { status: 401, body: { message: "Bad credentials" } },
        { status: 401, body: { message: "Bad credentials" } },
      ],
      tokenQueue: [
        {
          access_token: "gho_NEW_SECRET",
          refresh_token: "ghr_new",
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
        },
      ],
    }),
  });

  const account = await service.getAccount();
  assert.deepEqual(account, { connected: false, reason: "reauth_required" });
  assert.equal(JSON.stringify(account).includes(SECRET_TOKEN), false);
  assert.equal(credentials.store.has(TOKEN_SET_KEY), false);
  assert.equal(credentials.store.has(TOKEN_KEY), false);
  assert.equal(calls.filter((url) => url === ACCESS_TOKEN_URL).length, 1);
  assert.equal(calls.filter((url) => url === USER_URL).length, 2);
});

test("getAccount：二次 401 但复用的是别的 provider 写入的 token → unverified 且保留凭据", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(
    TOKEN_SET_KEY,
    JSON.stringify({
      accessToken: SECRET_TOKEN,
      refreshToken: "ghr_old",
      accessTokenExpiresAt: Date.now() + 3600_000,
    }),
  );
  const calls: string[] = [];
  let userCalls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url !== USER_URL) {
      return jsonResponse({});
    }
    userCalls += 1;
    if (userCalls === 1) {
      // 第一次 /user 返回 401 的同时，另一个 provider / Host 抢先写入了新 token。
      credentials.store.set(
        TOKEN_SET_KEY,
        JSON.stringify({
          accessToken: "gho_other",
          refreshToken: "ghr_other",
          accessTokenExpiresAt: Date.now() + 3600_000,
        }),
      );
    }
    return jsonResponse({ message: "Bad credentials" }, 401);
  }) as typeof fetch;
  const service = createGithubAuthService({ credentialService: credentials, fetchImpl });

  // 复用的 token 不是本次真实刷新产物：不能据此判定授权失效。
  assert.deepEqual(await service.getAccount(), { connected: true, reason: "unverified" });
  assert.equal(credentials.store.has(TOKEN_SET_KEY), true);
  assert.equal(calls.filter((url) => url === ACCESS_TOKEN_URL).length, 0);
  assert.equal(calls.filter((url) => url === USER_URL).length, 2);
});

test("getAccount：二次 401 清理失败时仍返回 reauth_required（不抛 RPC 异常）", async () => {
  const base = createFakeCredentialService();
  await base.save(
    TOKEN_SET_KEY,
    JSON.stringify({
      accessToken: SECRET_TOKEN,
      refreshToken: "ghr_old",
      accessTokenExpiresAt: Date.now() + 3600_000,
    }),
  );
  // 模拟文件被锁 / 只读：两个 key 都删不掉。
  const credentials = {
    ...base,
    delete: async (key: string) => {
      throw new Error(`delete failed for ${key}`);
    },
  };
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({
      // 刷新拿到新 token，但重试仍被拒：真实刷新后的 401 才判定授权失效。
      userQueue: [
        { status: 401, body: { message: "Bad credentials" } },
        { status: 401, body: { message: "Bad credentials" } },
      ],
      tokenQueue: [
        {
          access_token: "gho_NEW_SECRET",
          refresh_token: "ghr_new",
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
        },
      ],
    }),
  });

  const { result, output } = await withCapturedConsole(() => service.getAccount());
  // 清理失败不能让 RPC 变成异常：仍按 reauth_required 语义返回。
  assert.deepEqual(result, { connected: false, reason: "reauth_required" });
  assert.ok(output.includes("cleanup failed"));
  // 删除失败时凭据可能残留，但语义仍是需要重新授权。
  assert.equal(base.store.has(TOKEN_SET_KEY), true);
});

test("getAccount：access token 已过期且刷新网络失败 → unverified，不请求 /user 且保留凭据", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(
    TOKEN_SET_KEY,
    JSON.stringify({
      accessToken: SECRET_TOKEN,
      refreshToken: "ghr_old",
      accessTokenExpiresAt: Date.now() - 1,
    }),
  );
  const calls: string[] = [];
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({
      calls,
      failTokenWith: new Error("fetch failed"),
    }),
  });

  const account = await service.getAccount();
  assert.deepEqual(account, { connected: true, reason: "unverified" });
  assert.equal(credentials.store.has(TOKEN_SET_KEY), true);
  assert.equal(calls.filter((url) => url === ACCESS_TOKEN_URL).length, 1);
  // token 不可用时不拿它去请求 /user，避免把网络问题误判成 401。
  assert.equal(calls.filter((url) => url === USER_URL).length, 0);
});

test("poll 成功但 GitHub 未返回 refresh_token / expires_in：只落 accessToken（长期 token）", async () => {
  const credentials = createFakeCredentialService();
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({
      tokenQueue: [{ access_token: SECRET_TOKEN, token_type: "bearer", scope: "gist read:user" }],
      user: { login: "octocat" },
    }),
  });

  const result = await service.pollDeviceAuth({ deviceCode: "device-1" });
  assert.equal(result.status, "success");
  assert.equal(result.account?.login, "octocat");

  const stored = JSON.parse(credentials.store.get(TOKEN_SET_KEY) ?? "{}") as Record<
    string,
    unknown
  >;
  // GitHub 没给 refresh_token / 过期时间时不硬凑字段：按长期 token 使用。
  assert.deepEqual(stored, { accessToken: SECRET_TOKEN });
});

// ===== 代理 401 不得误判为授权撤销 =====

test("getAccount：401 但响应体不是 GitHub 的 Bad credentials（代理 HTML）→ unverified 且保留凭据", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(
    TOKEN_SET_KEY,
    JSON.stringify({
      accessToken: SECRET_TOKEN,
      refreshToken: "ghr_old",
      accessTokenExpiresAt: Date.now() + 3600_000,
    }),
  );
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (url === USER_URL) {
      // 企业网关 / 代理常返回 HTML 401 页面；不能当成 token 被撤销。
      return new Response("<html><body>proxy login required</body></html>", {
        status: 401,
        headers: { "content-type": "text/html" },
      });
    }
    return jsonResponse({});
  }) as typeof fetch;
  const service = createGithubAuthService({ credentialService: credentials, fetchImpl });

  const account = await service.getAccount();
  assert.deepEqual(account, { connected: true, reason: "unverified" });
  // 不是 GitHub 的撤销响应：不清凭据、不触发刷新、也不重试。
  assert.equal(credentials.store.has(TOKEN_SET_KEY), true);
  assert.equal(calls.filter((url) => url === ACCESS_TOKEN_URL).length, 0);
  assert.equal(calls.filter((url) => url === USER_URL).length, 1);
});

test("getAccount：401 + JSON 但 message 不是 Bad credentials（代理 JSON）→ unverified 且保留凭据", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(
    TOKEN_SET_KEY,
    JSON.stringify({
      accessToken: SECRET_TOKEN,
      refreshToken: "ghr_old",
      accessTokenExpiresAt: Date.now() + 3600_000,
    }),
  );
  const calls: string[] = [];
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({
      calls,
      user: { message: "Proxy authentication required" },
      userStatus: 401,
    }),
  });

  assert.deepEqual(await service.getAccount(), { connected: true, reason: "unverified" });
  assert.equal(credentials.store.has(TOKEN_SET_KEY), true);
  assert.equal(calls.filter((url) => url === ACCESS_TOKEN_URL).length, 0);
});

// ===== poll 非法响应不得落成永久 pending =====

test("poll 非法响应：空对象 / 数组 / {message} 都返回 error，不停在 pending", async () => {
  const cases: ReadonlyArray<{ name: string; body: unknown }> = [
    { name: "空对象", body: {} },
    { name: "数组", body: [] },
    { name: "只有 message", body: { message: "something went wrong" } },
  ];
  for (const { name, body } of cases) {
    const credentials = createFakeCredentialService();
    const service = createGithubAuthService({
      credentialService: credentials,
      fetchImpl: createFetchMock({ tokenQueue: [body] }),
    });
    const result = await service.pollDeviceAuth({ deviceCode: "device-1" });
    assert.equal(result.status, "error", name);
    assert.equal(result.status === "error" && typeof result.message === "string", true, name);
    assert.equal(JSON.stringify(result).includes("access_token"), false, name);
    // 未登录、也未写任何凭据。
    assert.equal(credentials.store.size, 0, name);
  }
});
