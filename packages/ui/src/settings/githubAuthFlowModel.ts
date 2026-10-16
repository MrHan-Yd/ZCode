/**
 * GitHub 账号授权（OAuth Device Flow）的纯状态机。
 *
 * 抽成纯模块的原因：授权流程的难点不是渲染，而是「状态迁移 + 轮询间隔递进 + 终止条件」，
 * 这些规则一旦写在组件里就只能靠手点验证。这里把规则收成纯函数，用差分测试钉住，
 * 组件只负责 dispatch 与渲染。
 *
 * 关键约束：轮询间隔由服务端（host）在 slow_down 时递增返回，UI 必须把「上次使用的间隔」
 * 原样回传，否则 slow_down 无法递进。因此间隔是流程状态的一部分，不是渲染细节。
 */
import type { GithubAuthAccountState, GithubAuthPollResult } from "@zcode/services";

/** 默认轮询间隔（秒），与 GitHub Device Flow 的默认值一致。 */
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;

/** 轮询间隔下限：服务端可能给 0 或负数（非法响应），不能让它变成忙等。 */
const MIN_POLL_INTERVAL_SECONDS = 1;

export type GithubAuthPhase =
  /** 未登录：可以发起授权。 */
  | "idle"
  /** 授权中：已拿到设备码，正在轮询。 */
  | "authorizing"
  /** 已登录。 */
  | "connected"
  /** 服务端未配置 client id，不显示登录入口。 */
  | "not_configured"
  /** OAuth App 未勾选 Enable Device Flow，需要去 GitHub 设置里改。 */
  | "device_flow_disabled"
  /** 用户拒绝了授权。 */
  | "denied"
  /** 设备码过期。 */
  | "expired"
  /** 其它错误（含发起失败与轮询异常）。 */
  | "error";

export interface GithubAuthFlowState {
  readonly phase: GithubAuthPhase;
  readonly deviceCode?: string;
  readonly userCode?: string;
  readonly verificationUri?: string;
  /** 下一次轮询应使用的间隔（秒）。 */
  readonly intervalSeconds: number;
  /** 设备码过期时间（epoch ms）。 */
  readonly expiresAt?: number;
  readonly account?: GithubAuthAccountState;
  /** 终止态的可读原因（服务端返回，不含 token）。 */
  readonly message?: string;
}

export const INITIAL_GITHUB_AUTH_FLOW_STATE: GithubAuthFlowState = {
  phase: "idle",
  intervalSeconds: DEFAULT_POLL_INTERVAL_SECONDS,
};

export type GithubAuthFlowAction =
  /** 初始化/刷新读取到的账号状态。 */
  | { type: "accountLoaded"; account: GithubAuthAccountState }
  /** beginDeviceAuth 返回 ok。 */
  | {
      type: "beginSucceeded";
      deviceCode?: string;
      userCode?: string;
      verificationUri?: string;
      intervalSeconds?: number;
      expiresAt?: number;
    }
  /** beginDeviceAuth 返回非 ok。 */
  | {
      type: "beginFailed";
      reason: "not_configured" | "device_flow_disabled" | "error";
      message?: string;
    }
  /**
   * 一次轮询的结果；pending 推进间隔，其余各自终止。
   * 终止**只能**来自服务端结果：渲染端不自己判过期（跨机时钟不可信）。
   */
  | { type: "pollResult"; result: GithubAuthPollResult }
  /** 用户取消授权。 */
  | { type: "cancelled" }
  /** 退出登录。 */
  | { type: "signedOut" };

/** 把任意输入收敛成合法间隔；缺失/非法一律回落到默认值。 */
export function normalizePollIntervalSeconds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_POLL_INTERVAL_SECONDS;
  }
  return Math.max(MIN_POLL_INTERVAL_SECONDS, Math.floor(value));
}

/**
 * slow_down 递进规则：服务端 pending 回传的间隔优先，缺失才沿用上次。
 * 递增本身由 host 计算，UI 只负责「不把间隔丢掉」。
 */
export function resolvePollIntervalSeconds(
  currentSeconds: number,
  serverSeconds: number | undefined,
): number {
  return normalizePollIntervalSeconds(serverSeconds ?? currentSeconds);
}

/** 轮询成功时把服务端账号信息折成 UI 账号状态。 */
function accountStateFromPollResult(result: GithubAuthPollResult): GithubAuthAccountState {
  return {
    connected: true,
    login: result.account?.login,
    name: result.account?.name,
    avatarUrl: result.account?.avatarUrl,
  };
}

export function githubAuthFlowReducer(
  state: GithubAuthFlowState,
  action: GithubAuthFlowAction,
): GithubAuthFlowState {
  switch (action.type) {
    case "accountLoaded":
      if (!action.account.connected) {
        return INITIAL_GITHUB_AUTH_FLOW_STATE;
      }
      return { ...INITIAL_GITHUB_AUTH_FLOW_STATE, phase: "connected", account: action.account };
    case "beginSucceeded":
      return {
        phase: "authorizing",
        deviceCode: action.deviceCode,
        userCode: action.userCode,
        verificationUri: action.verificationUri,
        intervalSeconds: normalizePollIntervalSeconds(action.intervalSeconds),
        expiresAt: action.expiresAt,
      };
    case "beginFailed":
      return {
        ...INITIAL_GITHUB_AUTH_FLOW_STATE,
        phase: action.reason,
        message: action.message,
      };
    case "pollResult": {
      // 迟到的轮询结果不能覆盖新状态（例如用户已取消、或已换了一个 deviceCode）。
      if (state.phase !== "authorizing") {
        return state;
      }
      const { result } = action;
      switch (result.status) {
        case "pending":
          return {
            ...state,
            intervalSeconds: resolvePollIntervalSeconds(state.intervalSeconds, result.interval),
          };
        case "success":
          return {
            ...INITIAL_GITHUB_AUTH_FLOW_STATE,
            phase: "connected",
            account: accountStateFromPollResult(result),
          };
        case "denied":
        case "expired":
        case "device_flow_disabled":
        case "error":
          return {
            ...INITIAL_GITHUB_AUTH_FLOW_STATE,
            phase: result.status,
            message: result.message,
          };
      }
    }
    case "cancelled":
    case "signedOut":
      return INITIAL_GITHUB_AUTH_FLOW_STATE;
  }
}

/** 是否应该继续轮询。组件用它决定是否排下一次请求。 */
export function shouldPollGithubAuth(state: GithubAuthFlowState): boolean {
  return state.phase === "authorizing" && Boolean(state.deviceCode);
}

/**
 * 构造下一次轮询请求。间隔必须带回去，否则 host 无法在 slow_down 时递进。
 * 返回 null 表示当前不该再轮询。
 */
export function buildGithubAuthPollRequest(
  state: GithubAuthFlowState,
): { deviceCode: string; interval: number } | null {
  const deviceCode = state.deviceCode;
  if (state.phase !== "authorizing" || !deviceCode) {
    return null;
  }
  return { deviceCode, interval: state.intervalSeconds };
}

/**
 * 已连接账号的展示名。
 * 返回 null 表示「token 在但账号名暂不可得」（getAccount 在 GitHub API 不可达时只给 connected），
 * UI 此时只显示「已连接」，不要伪造账号名。
 */
export function githubAuthAccountLabel(account: GithubAuthAccountState | undefined): string | null {
  const name = account?.name?.trim();
  if (name) {
    return name;
  }
  return account?.login?.trim() || null;
}

/**
 * 设备码剩余有效秒数；没有 expiresAt 时返回 null（不显示倒计时）。
 *
 * **纯展示值，禁止用它派生状态迁移**：`expiresAt` 由 host 时钟产生，手机远控下渲染端与 host
 * 是两台机器，渲染端时钟不可作为过期判据。过期一律以服务端 `poll` 返回的 `expired` 为准。
 */
export function githubAuthRemainingSeconds(
  expiresAt: number | undefined,
  nowMs: number,
): number | null {
  if (expiresAt === undefined) {
    return null;
  }
  return Math.max(0, Math.ceil((expiresAt - nowMs) / 1000));
}
