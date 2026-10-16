import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGithubAuthPollRequest,
  DEFAULT_POLL_INTERVAL_SECONDS,
  githubAuthAccountLabel,
  githubAuthFlowReducer,
  githubAuthRemainingSeconds,
  INITIAL_GITHUB_AUTH_FLOW_STATE,
  normalizePollIntervalSeconds,
  resolvePollIntervalSeconds,
  shouldPollGithubAuth,
  type GithubAuthFlowState,
} from "../src/settings/githubAuthFlowModel.js";

/**
 * GitHub Device Flow 状态机的差分测试。
 *
 * 这里钉的是三条容易回归的规则：
 * 1. 轮询间隔必须回传上次值，否则 host 的 slow_down 递进失效；
 * 2. 每种终止状态都要落到对应 phase，不能停在 authorizing 继续发包；
 * 3. 「已连接但没有账号名」（getAccount 在 GitHub API 不可达时只给 connected）不能被当成有名字。
 */

function begin(overrides: Partial<{ intervalSeconds: number; expiresAt: number }> = {}) {
  return githubAuthFlowReducer(INITIAL_GITHUB_AUTH_FLOW_STATE, {
    type: "beginSucceeded",
    deviceCode: "device-1",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresAt: 1_000_000,
    ...overrides,
  });
}

function pending(state: GithubAuthFlowState, interval: number | undefined) {
  return githubAuthFlowReducer(state, { type: "pollResult", result: { status: "pending", interval } });
}

test("未登录 → 授权中 → 已登录：状态迁移与轮询开关同步", () => {
  const idle = INITIAL_GITHUB_AUTH_FLOW_STATE;
  assert.equal(idle.phase, "idle");
  assert.equal(shouldPollGithubAuth(idle), false);
  assert.equal(buildGithubAuthPollRequest(idle), null);

  const authorizing = begin();
  assert.equal(authorizing.phase, "authorizing");
  assert.equal(shouldPollGithubAuth(authorizing), true);
  assert.deepEqual(buildGithubAuthPollRequest(authorizing), {
    deviceCode: "device-1",
    interval: DEFAULT_POLL_INTERVAL_SECONDS,
  });

  const connected = githubAuthFlowReducer(authorizing, {
    type: "pollResult",
    result: { status: "success", account: { login: "octocat", name: "Mona" } },
  });
  assert.equal(connected.phase, "connected");
  assert.equal(shouldPollGithubAuth(connected), false);
  assert.equal(connected.account?.login, "octocat");
  // 成功后必须丢掉设备码，避免把过期设备码留在内存里继续被引用。
  assert.equal(connected.deviceCode, undefined);
});

test("slow_down 递进：服务端 pending 回传的新间隔被采纳并原样带回下一次请求", () => {
  let state = begin(); // 默认 5s
  assert.equal(buildGithubAuthPollRequest(state)?.interval, 5);

  state = pending(state, 10);
  assert.equal(state.phase, "authorizing");
  assert.equal(state.intervalSeconds, 10);
  assert.equal(buildGithubAuthPollRequest(state)?.interval, 10);

  state = pending(state, 15);
  assert.equal(state.intervalSeconds, 15);

  // pending 不带 interval（例如非 slow_down 的普通 pending）时沿用上次值，不能回落到默认值。
  state = pending(state, undefined);
  assert.equal(state.intervalSeconds, 15);
  assert.equal(buildGithubAuthPollRequest(state)?.interval, 15);
});

test("间隔收敛：0/负数向上取到 1 秒，缺失/NaN/Infinity 回落到默认值", () => {
  assert.equal(normalizePollIntervalSeconds(0), 1);
  assert.equal(normalizePollIntervalSeconds(-3), 1);
  assert.equal(normalizePollIntervalSeconds(4.9), 4);
  assert.equal(normalizePollIntervalSeconds(undefined), DEFAULT_POLL_INTERVAL_SECONDS);
  assert.equal(normalizePollIntervalSeconds(Number.NaN), DEFAULT_POLL_INTERVAL_SECONDS);
  assert.equal(normalizePollIntervalSeconds(Number.POSITIVE_INFINITY), DEFAULT_POLL_INTERVAL_SECONDS);
  assert.equal(resolvePollIntervalSeconds(7, undefined), 7);
  assert.equal(resolvePollIntervalSeconds(7, 12), 12);
});

test("终止态：denied / expired / device_flow_disabled / error 各自停下并保留原因", () => {
  const cases = ["denied", "expired", "device_flow_disabled", "error"] as const;
  for (const status of cases) {
    const state = githubAuthFlowReducer(begin(), {
      type: "pollResult",
      result: { status, message: `${status}-reason` },
    });
    assert.equal(state.phase, status);
    assert.equal(state.message, `${status}-reason`);
    assert.equal(shouldPollGithubAuth(state), false);
    assert.equal(buildGithubAuthPollRequest(state), null);
  }
});

test("迟到的轮询结果不覆盖新状态（用户已取消或已成功）", () => {
  const cancelled = githubAuthFlowReducer(begin(), { type: "cancelled" });
  const late = githubAuthFlowReducer(cancelled, {
    type: "pollResult",
    result: { status: "success", account: { login: "octocat" } },
  });
  assert.equal(late.phase, "idle");
  assert.equal(late.account, undefined);

  const connected = githubAuthFlowReducer(begin(), {
    type: "pollResult",
    result: { status: "success", account: { login: "octocat" } },
  });
  const lateFailure = githubAuthFlowReducer(connected, {
    type: "pollResult",
    result: { status: "expired" },
  });
  assert.equal(lateFailure.phase, "connected");
  assert.equal(lateFailure.account?.login, "octocat");
});

test("取消回到未登录：设备码与间隔一起清空", () => {
  const state = githubAuthFlowReducer(pending(begin(), 10), { type: "cancelled" });
  assert.deepEqual(state, INITIAL_GITHUB_AUTH_FLOW_STATE);
});

test("发起阶段的非 ok 结果：not_configured 与 device_flow_disabled 不提供重试入口", () => {
  const notConfigured = githubAuthFlowReducer(INITIAL_GITHUB_AUTH_FLOW_STATE, {
    type: "beginFailed",
    reason: "not_configured",
  });
  assert.equal(notConfigured.phase, "not_configured");
  assert.equal(shouldPollGithubAuth(notConfigured), false);

  const disabled = githubAuthFlowReducer(INITIAL_GITHUB_AUTH_FLOW_STATE, {
    type: "beginFailed",
    reason: "device_flow_disabled",
  });
  assert.equal(disabled.phase, "device_flow_disabled");

  const errored = githubAuthFlowReducer(INITIAL_GITHUB_AUTH_FLOW_STATE, {
    type: "beginFailed",
    reason: "error",
    message: "bad_verification_code",
  });
  assert.equal(errored.phase, "error");
  assert.equal(errored.message, "bad_verification_code");
});

test("已连接：只有 connected 而没有 login 时不给出账号名", () => {
  const noName = githubAuthFlowReducer(INITIAL_GITHUB_AUTH_FLOW_STATE, {
    type: "accountLoaded",
    account: { connected: true },
  });
  assert.equal(noName.phase, "connected");
  assert.equal(githubAuthAccountLabel(noName.account), null);

  // name 优先于 login；只有 login 时用 login。
  assert.equal(githubAuthAccountLabel({ connected: true, login: "octocat" }), "octocat");
  assert.equal(
    githubAuthAccountLabel({ connected: true, login: "octocat", name: " Mona " }),
    "Mona",
  );
  // 空字符串不能伪装成账号名。
  assert.equal(githubAuthAccountLabel({ connected: true, name: "   " }), null);
  assert.equal(githubAuthAccountLabel(undefined), null);
});

test("未连接：accountLoaded(connected:false) 回到未登录而非已连接", () => {
  const state = githubAuthFlowReducer(
    githubAuthFlowReducer(INITIAL_GITHUB_AUTH_FLOW_STATE, {
      type: "accountLoaded",
      account: { connected: true, login: "octocat" },
    }),
    { type: "accountLoaded", account: { connected: false } },
  );
  assert.equal(state.phase, "idle");
  assert.equal(state.account, undefined);
});

test("退出登录：已连接 → 未登录", () => {
  const connected = githubAuthFlowReducer(INITIAL_GITHUB_AUTH_FLOW_STATE, {
    type: "accountLoaded",
    account: { connected: true, login: "octocat" },
  });
  assert.deepEqual(
    githubAuthFlowReducer(connected, { type: "signedOut" }),
    INITIAL_GITHUB_AUTH_FLOW_STATE,
  );
});

test("剩余有效期：按秒向上取整，过期不返回负数，无 expiresAt 时不倒计时", () => {
  assert.equal(githubAuthRemainingSeconds(10_500, 10_000), 1);
  assert.equal(githubAuthRemainingSeconds(15_000, 10_000), 5);
  assert.equal(githubAuthRemainingSeconds(9_000, 10_000), 0);
  assert.equal(githubAuthRemainingSeconds(undefined, 10_000), null);
});

test("本地剩余归零不改变状态、不停轮询：过期只由服务端 poll 的 expired 判定", () => {
  // 手机远控下渲染端时钟可能比 host 快几分钟；若用本地剩余 0 派生过期，
  // 会提前掐断一个仍然有效的授权。这条断言就是防它被改回去。
  const state = begin({ expiresAt: 1_000 });
  const nowMs = 600_000; // 远超 expiresAt
  assert.equal(githubAuthRemainingSeconds(state.expiresAt, nowMs), 0);

  // 纯展示的倒计时不影响状态机：phase / 轮询开关 / 下次请求都保持原样。
  assert.equal(state.phase, "authorizing");
  assert.equal(shouldPollGithubAuth(state), true);
  assert.deepEqual(buildGithubAuthPollRequest(state), {
    deviceCode: "device-1",
    interval: DEFAULT_POLL_INTERVAL_SECONDS,
  });

  // 只有服务端结果能把它带到 expired。
  const expired = githubAuthFlowReducer(state, {
    type: "pollResult",
    result: { status: "expired" },
  });
  assert.equal(expired.phase, "expired");
  assert.equal(shouldPollGithubAuth(expired), false);
});
