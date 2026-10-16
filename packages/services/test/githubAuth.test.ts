import assert from "node:assert/strict";
import test from "node:test";
import { createGithubAuthService } from "../src/github/githubAuthService.js";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const TOKEN_KEY = "github:oauth:access_token";

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
  };
}

interface FetchMockOptions {
  readonly deviceCode?: unknown;
  readonly deviceCodeRaw?: string;
  readonly failDeviceCodeWith?: Error;
  readonly tokenQueue?: readonly unknown[];
  readonly user?: unknown;
  readonly userStatus?: number;
  readonly calls?: string[];
  readonly failTokenWith?: Error;
}

/** 按 URL 路由的 fetch mock；token 端点按 tokenQueue 顺序消费，耗尽后复用最后一项。 */
function createFetchMock(options: FetchMockOptions): typeof fetch {
  let tokenIndex = 0;
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
async function withCapturedConsole<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
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
      { access_token: SECRET_TOKEN, token_type: "bearer", scope: "gist read:user" },
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
    const second = await service.pollDeviceAuth({ deviceCode: "device-1", interval: first.interval });
    assert.deepEqual(second, { status: "pending", interval: 5 });

    const done = await service.pollDeviceAuth({ deviceCode: "device-1" });
    assert.equal(done.status, "success");
    assert.equal(done.account?.login, "octocat");
    assert.equal(done.account?.name, "The Octocat");
    assert.equal(done.account?.avatarUrl, "https://avatars.test/u/1");

    // token 确实写进凭据服务。
    assert.equal(credentials.store.get(TOKEN_KEY), SECRET_TOKEN);

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

test("getAccount：token 失效（401）时清理凭据并返回未连接", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(TOKEN_KEY, SECRET_TOKEN);
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({ userStatus: 401 }),
  });
  const account = await service.getAccount();
  assert.deepEqual(account, { connected: false });
  assert.equal(credentials.store.has(TOKEN_KEY), false);
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

test("signOut 删除凭据", async () => {
  const credentials = createFakeCredentialService();
  await credentials.save(TOKEN_KEY, SECRET_TOKEN);
  const service = createGithubAuthService({
    credentialService: credentials,
    fetchImpl: createFetchMock({}),
  });
  await service.signOut();
  assert.equal(credentials.store.has(TOKEN_KEY), false);
});
