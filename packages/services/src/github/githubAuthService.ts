import { describeRequestError } from "../http/describeRequestError.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  GITHUB_OAUTH_CLIENT_ID,
  type GithubAuthAccount,
  type GithubAuthAccountState,
  type GithubAuthBeginResult,
  type GithubAuthPollResult,
  type IGithubAuthService,
} from "./githubAuth.js";
import { createGithubTokenProvider, type GithubCredentialAccess } from "./githubTokenProvider.js";

/** `gist` 供后续创建私有 gist，`read:user` 供显示登录账号。 */
const GITHUB_SCOPE = "gist read:user";

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const GITHUB_API_VERSION = "2022-11-28";

const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 900;

const log = createServiceLogger("githubAuthService");

export interface CreateGithubAuthServiceOptions {
  /** 凭据读写端口；token 只经它落盘，绝不写日志。 */
  readonly credentialService: GithubCredentialAccess;
  /** 覆盖 client id；注入空串用于测试 not_configured 分支。缺省用内置公开 client id。 */
  readonly clientId?: string;
  /** 注入 fetch（测试用）；缺省用全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
}

interface GithubDeviceCodeResponse {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number;
  interval?: number;
  error?: string;
  error_description?: string;
}

interface GithubAccessTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

interface GithubUserResponse {
  login?: string;
  name?: string;
  avatar_url?: string;
}

/**
 * GitHub 账号授权（OAuth Device Flow）。
 *
 * 无状态轮询：不保存 deviceCode / 轮询会话；token 是唯一持久化事实，`GET /user` 现取展示字段。
 */
export function createGithubAuthService(
  options: CreateGithubAuthServiceOptions,
): IGithubAuthService {
  const credentialService = options.credentialService;
  const clientId = (options.clientId ?? GITHUB_OAUTH_CLIENT_ID).trim();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  // 本服务不再直接读写 token key：登录写入、刷新、退出清理统一交给 provider。
  // 每个消费者各自创建 provider（不做跨实例单例）：跨实例竞争由 provider 的
  // bad_refresh_token 重读 + compare-and-delete 兜底，单飞只保证实例内。
  const tokens = createGithubTokenProvider({ credentialService, fetchImpl, clientId });

  const beginDeviceAuth = async (): Promise<GithubAuthBeginResult> => {
    if (!clientId) {
      return { status: "not_configured" };
    }
    let body: GithubDeviceCodeResponse;
    try {
      body = await postForm<GithubDeviceCodeResponse>(fetchImpl, GITHUB_DEVICE_CODE_URL, {
        client_id: clientId,
        scope: GITHUB_SCOPE,
      });
    } catch (error) {
      if (error instanceof GithubRequestError && error.kind === "invalid_response") {
        // 响应非法（非 JSON / 非对象）属于可预期的 GitHub 侧问题，按契约用 status:error 表达。
        log.warn(undefined, "github device auth begin got invalid response", error.message);
        return { status: "error", message: error.message };
      }
      // 网络 / 超时等真正的意外仍抛异常（见 spec「失败语义」）。
      throw error;
    }
    if (body.error === "device_flow_disabled") {
      // OAuth App 未勾选 Enable Device Flow：单独成状态，供 UI 专门提示。
      log.warn(undefined, "github device auth begin device_flow_disabled");
      return { status: "device_flow_disabled" };
    }
    if (body.error) {
      log.warn(undefined, "github device auth begin failed", body.error);
      return { status: "error", message: `GitHub 设备码授权发起失败：${body.error}` };
    }
    if (!body.device_code) {
      log.warn(undefined, "github device auth begin failed", "missing_device_code");
      return { status: "error", message: "GitHub 设备码授权发起失败：missing_device_code" };
    }
    // ok 要求 userCode / verificationUri 必填：GitHub 缺字段时不能用空串硬凑，
    // 否则 UI 既展示不了验证码、也打不开授权页，会永久空转。
    const userCode = typeof body.user_code === "string" ? body.user_code.trim() : "";
    if (!userCode) {
      log.warn(undefined, "github device auth begin failed", "missing_user_code");
      return { status: "error", message: "GitHub 设备码授权发起失败：缺少 user_code" };
    }
    const verificationUri =
      typeof body.verification_uri === "string" ? body.verification_uri.trim() : "";
    if (!verificationUri) {
      log.warn(undefined, "github device auth begin failed", "missing_verification_uri");
      return { status: "error", message: "GitHub 设备码授权发起失败：缺少 verification_uri" };
    }
    const interval = positiveNumber(body.interval) ?? DEFAULT_POLL_INTERVAL_SECONDS;
    const expiresInSeconds = positiveNumber(body.expires_in) ?? DEFAULT_EXPIRES_IN_SECONDS;
    return {
      status: "ok",
      deviceCode: body.device_code,
      userCode,
      verificationUri,
      interval,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    };
  };

  const pollDeviceAuth = async (params: {
    deviceCode: string;
    interval?: number;
  }): Promise<GithubAuthPollResult> => {
    const deviceCode = params.deviceCode?.trim() ?? "";
    if (!deviceCode) {
      return { status: "error", message: "缺少 device code" };
    }
    if (!clientId) {
      return { status: "error", message: "GitHub OAuth client id 未配置" };
    }
    // 无状态：UI 回传上次使用的间隔，缺省按默认 5 处理；slow_down 在此基础上 +5 递进。
    const currentInterval = positiveNumber(params.interval) ?? DEFAULT_POLL_INTERVAL_SECONDS;

    let body: GithubAccessTokenResponse;
    try {
      body = await postForm<GithubAccessTokenResponse>(fetchImpl, GITHUB_ACCESS_TOKEN_URL, {
        client_id: clientId,
        device_code: deviceCode,
        grant_type: GITHUB_DEVICE_GRANT_TYPE,
      });
    } catch (error) {
      // 网络 / 超时 / 非法响应：转成可读 error，绝不把请求体或 token 带出去。
      const detail = describeRequestError(error);
      log.warn(undefined, "github device auth poll request failed", detail);
      return { status: "error", message: `网络异常：${detail}` };
    }

    if (body.access_token) {
      const issuedAt = Date.now();
      const expiresIn = positiveNumber(body.expires_in);
      const refreshTokenExpiresIn = positiveNumber(body.refresh_token_expires_in);
      const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token.trim() : "";
      // 先落 token set（持久事实），再拉账号（展示增强）；账号拉取失败不影响登录成功。
      // GitHub 返回了 refresh_token / expires_in 时一并落盘，否则按长期 token 处理。
      await tokens.saveSession({
        accessToken: body.access_token,
        ...(refreshToken ? { refreshToken } : {}),
        ...(expiresIn !== undefined ? { accessTokenExpiresAt: issuedAt + expiresIn * 1000 } : {}),
        ...(refreshTokenExpiresIn !== undefined
          ? { refreshTokenExpiresAt: issuedAt + refreshTokenExpiresIn * 1000 }
          : {}),
      });
      const { account } = await requestGithubUser(fetchImpl, body.access_token);
      log.info(undefined, "github device auth succeeded");
      return { status: "success", ...(account ? { account } : {}) };
    }

    // 没有 access_token 时，只有带非空字符串 error 才是 GitHub 的预期形状
    //（pending 一定带 error: "authorization_pending"）。空对象 / {message} 这类非法响应
    // 不能落成 pending，否则 UI 会一直轮询到设备码过期。
    if (typeof body.error !== "string" || body.error.length === 0) {
      log.warn(undefined, "github device auth poll returned invalid response");
      return { status: "error", message: "GitHub 授权响应格式非法" };
    }

    switch (body.error) {
      case "authorization_pending":
        // 保持当前节奏。
        return { status: "pending", interval: currentInterval };
      case "slow_down":
        // GitHub 要求退避：在当前节奏上 +5，由 UI 回传 interval 实现无状态递进。
        return { status: "pending", interval: currentInterval + SLOW_DOWN_INCREMENT_SECONDS };
      case "expired_token":
        return { status: "expired" };
      case "access_denied":
        return { status: "denied" };
      case "device_flow_disabled":
        return { status: "device_flow_disabled" };
      default:
        log.warn(undefined, "github device auth poll failed", body.error);
        return { status: "error", message: `GitHub 授权失败：${body.error}` };
    }
  };

  const getAccount = async (): Promise<GithubAuthAccountState> => {
    const resolved = await tokens.getAccessToken();
    if (resolved.status === "none") return { connected: false };
    if (resolved.status === "reauth_required") {
      return { connected: false, reason: "reauth_required" };
    }
    if (resolved.status === "temporarily_unavailable") {
      // 凭据仍在，只是当前无法完成刷新验证：保持已连接态，UI 下次再补账号信息。
      return { connected: true, reason: "unverified" };
    }

    const first = await requestGithubUser(fetchImpl, resolved.token);
    if (first.account) return connectedAccountState(first.account);
    if (!first.unauthorized) {
      // 网络等临时失败：保留 token，只缺展示字段，不误删凭据。
      return { connected: true, reason: "unverified" };
    }

    // 401 是软失败：先刷新再判定，禁止一次 401 就删凭据。
    const refreshed = await tokens.refreshAfterRejectedToken(resolved.token);
    if (refreshed.status === "ok") {
      const retry = await requestGithubUser(fetchImpl, refreshed.token);
      if (retry.account) return connectedAccountState(retry.account);
      if (retry.unauthorized) {
        if (!refreshed.refreshed) {
          // 复用的不是本次真实刷新的 token（缓存 / 别的 provider 刚写入）：无权据此
          // 判定授权失效，保留凭据，下次调用会重新走强制刷新判定。
          return { connected: true, reason: "unverified" };
        }
        // 真实刷新后的新 token 仍被拒：此时才判定授权已失效。
        try {
          await tokens.clearSession();
        } catch (error) {
          // 内部自动清理失败不能变成 RPC 异常：仍按 reauth_required 语义返回。
          log.warn(
            undefined,
            "github session cleanup failed after rejected refresh",
            describeRequestError(error),
          );
        }
        log.info(undefined, "github account token rejected after refresh, session cleared");
        return { connected: false, reason: "reauth_required" };
      }
      return { connected: true, reason: "unverified" };
    }
    if (refreshed.status === "reauth_required") {
      return { connected: false, reason: "reauth_required" };
    }
    if (refreshed.status === "temporarily_unavailable") {
      return { connected: true, reason: "unverified" };
    }
    return { connected: false };
  };

  const signOut = async (): Promise<void> => {
    await tokens.clearSession();
    log.info(undefined, "github account signed out");
  };

  return { beginDeviceAuth, pollDeviceAuth, getAccount, signOut };
}

function connectedAccountState(account: GithubAuthAccount): GithubAuthAccountState {
  return {
    connected: true,
    login: account.login,
    ...(account.name ? { name: account.name } : {}),
    ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}),
  };
}

/**
 * 区分「网络/超时」（真正的意外，begin 允许抛出）与「响应非法」（GitHub 侧可预期问题，
 * begin 用 status:error 表达）。poll 两种情况都归一为 status:error。
 */
class GithubRequestError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "invalid_response",
  ) {
    super(message);
    this.name = "GithubRequestError";
  }
}

/** GitHub 的 device flow 失败多数仍返回 HTTP 200，必须解析 body，不能只看状态码。 */
async function postForm<T>(
  fetchImpl: typeof fetch,
  url: string,
  fields: Record<string, string>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GithubRequestError(describeRequestError(error), "network");
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new GithubRequestError(
      `响应不是合法 JSON（HTTP ${response.status}）`,
      "invalid_response",
    );
  }
  // 数组也是非法响应：`typeof [] === "object"`，漏掉它会让 poll 把 [] 当成 pending。
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new GithubRequestError(`响应格式非法（HTTP ${response.status}）`, "invalid_response");
  }
  return raw as T;
}

async function requestGithubUser(
  fetchImpl: typeof fetch,
  token: string,
): Promise<{ account: GithubAuthAccount | null; unauthorized: boolean }> {
  let response: Response;
  try {
    response = await fetchImpl(GITHUB_USER_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    log.warn(undefined, "github user request failed", describeRequestError(error));
    return { account: null, unauthorized: false };
  }
  if (response.status === 401) {
    // 401 不一定来自 GitHub：代理 / 企业网关也会拦截并返回 401（常见是 HTML 登录页）。
    // 只有 GitHub 自己的 {"message":"Bad credentials"} 才代表 token 被撤销；
    // 其余按临时失败处理（unverified），保留凭据，避免一次代理拦截就逼用户重新登录。
    const message = await readGithubErrorMessage(response);
    if (message === "Bad credentials") {
      return { account: null, unauthorized: true };
    }
    log.warn(
      undefined,
      "github user request returned 401 without bad credentials",
      `HTTP ${response.status}`,
    );
    return { account: null, unauthorized: false };
  }
  if (!response.ok) {
    log.warn(undefined, "github user request failed", `HTTP ${response.status}`);
    return { account: null, unauthorized: false };
  }
  let raw: GithubUserResponse;
  try {
    raw = (await response.json()) as GithubUserResponse;
  } catch {
    return { account: null, unauthorized: false };
  }
  const login = typeof raw.login === "string" ? raw.login.trim() : "";
  if (!login) {
    return { account: null, unauthorized: false };
  }
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  const avatarUrl = typeof raw.avatar_url === "string" ? raw.avatar_url.trim() : "";
  return {
    account: {
      login,
      ...(name ? { name } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
    },
    unauthorized: false,
  };
}

/**
 * 安全读取 GitHub 错误响应体里的 `message`。
 * 非 JSON（代理 HTML）、数组、非对象、字段非字符串一律返回 null，绝不把 body 内容写日志。
 */
async function readGithubErrorMessage(response: Response): Promise<string | null> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const message = (raw as { message?: unknown }).message;
  return typeof message === "string" ? message : null;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
