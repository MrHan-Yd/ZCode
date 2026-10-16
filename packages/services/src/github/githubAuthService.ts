import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type {
  GithubAuthAccount,
  GithubAuthAccountState,
  GithubAuthBeginResult,
  GithubAuthPollResult,
  IGithubAuthService,
} from "./githubAuth.js";

/**
 * GitHub OAuth App 的公开 client id。
 *
 * Device Flow 不需要 client secret（RFC 8628 只要求公开的 client id），因此内嵌进源码是安全的。
 */
const GITHUB_CLIENT_ID = "Ov23lib5yQwc5KZxAgz7";
/** `gist` 供后续创建私有 gist，`read:user` 供显示登录账号。 */
const GITHUB_SCOPE = "gist read:user";

const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const GITHUB_API_VERSION = "2022-11-28";

/** access token 在凭据库中的唯一 key（host 侧唯一所有者）。 */
const GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY = "github:oauth:access_token";

const REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INCREMENT_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 900;

const log = createServiceLogger("githubAuthService");

export interface CreateGithubAuthServiceOptions {
  /** 凭据读写端口；token 只经它落盘，绝不写日志。 */
  readonly credentialService: Pick<ICredentialService, "load" | "save" | "delete">;
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
  const clientId = (options.clientId ?? GITHUB_CLIENT_ID).trim();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

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
      const detail = describeError(error);
      log.warn(undefined, "github device auth poll request failed", detail);
      return { status: "error", message: `网络异常：${detail}` };
    }

    if (body.access_token) {
      // 先落 token（持久事实），再拉账号（展示增强）；账号拉取失败不影响登录成功。
      await credentialService.save(GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY, body.access_token);
      const { account } = await requestGithubUser(fetchImpl, body.access_token);
      log.info(undefined, "github device auth succeeded");
      return { status: "success", ...(account ? { account } : {}) };
    }

    switch (body.error) {
      case undefined:
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
    const token = (await credentialService.load(GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY))?.trim() ?? "";
    if (!token) {
      return { connected: false };
    }
    const { account, unauthorized } = await requestGithubUser(fetchImpl, token);
    if (unauthorized) {
      // token 已被撤销 / 失效：清理凭据回到未连接态，避免 UI 显示假连接。
      await credentialService.delete(GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY);
      log.info(undefined, "github account token rejected, credential cleared");
      return { connected: false };
    }
    if (!account) {
      // 网络等临时失败：保留 token，只缺展示字段，不误删凭据。
      return { connected: true };
    }
    return {
      connected: true,
      login: account.login,
      ...(account.name ? { name: account.name } : {}),
      ...(account.avatarUrl ? { avatarUrl: account.avatarUrl } : {}),
    };
  };

  const signOut = async (): Promise<void> => {
    await credentialService.delete(GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY);
    log.info(undefined, "github account signed out");
  };

  return { beginDeviceAuth, pollDeviceAuth, getAccount, signOut };
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
    throw new GithubRequestError(describeError(error), "network");
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    throw new GithubRequestError(`响应不是合法 JSON（HTTP ${response.status}）`, "invalid_response");
  }
  if (raw === null || typeof raw !== "object") {
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
    log.warn(undefined, "github user request failed", describeError(error));
    return { account: null, unauthorized: false };
  }
  if (response.status === 401) {
    return { account: null, unauthorized: true };
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

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.name === "TimeoutError") {
    return "请求超时";
  }
  // undici 的 fetch 只报 "fetch failed"，真正的原因挂在 cause 链上（UND_ERR_CONNECT_TIMEOUT /
  // ENOTFOUND / 证书校验失败等）。不带上 cause，界面上就只有「网络异常：fetch failed」，
  // 无法区分「没配代理」「DNS 失败」还是「证书问题」——首次接 GitHub 时就踩过这个坑。
  // cause 链只含网络层信息，不含请求体与 token。
  const parts = [error.message];
  let cause: unknown = (error as { cause?: unknown }).cause;
  for (let depth = 0; cause !== undefined && cause !== null && depth < 4; depth += 1) {
    const code = (cause as { code?: unknown }).code;
    const message = cause instanceof Error ? cause.message : String(cause);
    parts.push(typeof code === "string" && code.length > 0 ? `${code}: ${message}` : message);
    cause = (cause as { cause?: unknown }).cause;
  }
  return parts.join(" ← ");
}
