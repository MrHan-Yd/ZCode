import type { CredentialServiceAccess } from "../credential/credential.js";
import { describeRequestError } from "../http/describeRequestError.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY, GITHUB_OAUTH_CLIENT_ID } from "./githubAuth.js";

/**
 * 完整 token set 在凭据库中的 key（JSON 字符串），是唯一权威事实。
 *
 * 旧 key `github:oauth:access_token` 只作迁移来源；新代码只读它、不再写入。
 */
export const GITHUB_TOKEN_SET_CREDENTIAL_KEY = "github:oauth:token_set";

/** 提前刷新窗口：距 access token 过期不足 5 分钟即视为需要刷新。 */
export const REFRESH_SKEW_MS = 5 * 60_000;

const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const REQUEST_TIMEOUT_MS = 20_000;
const REFRESH_GRANT_TYPE = "refresh_token";

const log = createServiceLogger("githubTokenProvider");

export interface GithubTokenSession {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms；缺省表示长期 token（旧 key 迁移或 GitHub 未返回 `expires_in`）。 */
  accessTokenExpiresAt?: number;
  /** epoch ms；缺省表示 GitHub 未给出 refresh token 寿命。 */
  refreshTokenExpiresAt?: number;
}

export type GithubAccessTokenResult =
  | {
      status: "ok";
      token: string;
      /**
       * 本次返回的 token 是否来自一次真实刷新。
       * 缓存命中 / 旧 key 长期 token / 复用别的 provider 刚写入的 token 都是 false。
       * `getAccount` 用它决定「二次 401 是否可以判定授权失效」。
       */
      refreshed: boolean;
    }
  | { status: "none" }
  | { status: "reauth_required" }
  | {
      status: "temporarily_unavailable";
      /** 网络/超时 → network；GitHub 返回配置类 error（如 incorrect_client_credentials）→ configuration。 */
      reason: "network" | "configuration";
    };

export interface IGithubTokenProvider {
  /** 只读本地凭据（含旧 key 迁移），不出网。 */
  getSession(): Promise<GithubTokenSession | null>;
  /** 取可用 access token；临近/已过期时自动刷新。 */
  getAccessToken(): Promise<GithubAccessTokenResult>;
  /** GitHub 返回 401 后强制刷新一次；若凭据已被其它调用刷新过则直接复用。 */
  refreshAfterRejectedToken(rejectedToken: string): Promise<GithubAccessTokenResult>;
  /** 登录/刷新成功后写入完整 token set，并删除旧 key。 */
  saveSession(session: GithubTokenSession): Promise<void>;
  /** 退出登录：删除 token set 与旧 key；删除失败时抛错（不能宣称已退出）。 */
  clearSession(): Promise<void>;
}

/**
 * 凭据端口：在 `load / save / delete` 之外可选带上 host 内部的 `deleteIf`
 * （compare-and-delete，不进 RPC 接口）。
 *
 * 导出给授权服务复用：两个消费者各自创建 provider，但共享同一种端口类型。
 */
export type GithubCredentialAccess = CredentialServiceAccess;

export interface CreateGithubTokenProviderOptions {
  readonly credentialService: GithubCredentialAccess;
  /** 必须注入 host 的代理感知传输（生产是 `hostApiNetworkTransport.fetch`）。 */
  readonly fetchImpl?: typeof fetch;
  readonly clientId?: string;
  /** 测试注入用的时钟；缺省 `Date.now`。 */
  readonly now?: () => number;
}

export function createGithubTokenProvider(
  options: CreateGithubTokenProviderOptions,
): IGithubTokenProvider {
  const { credentialService } = options;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clientId = (options.clientId ?? GITHUB_OAUTH_CLIENT_ID).trim();
  const now = options.now ?? Date.now;

  // 单飞：refresh token 是一次性的，并发刷新会把对方刚轮换出的 token 作废。
  // 只有**同一 provider 实例内**共享刷新 Promise；跨实例 / 跨进程竞争由
  // bad_refresh_token 的重读 + compare-and-delete 兜底（见 handleBadRefreshToken）。
  let refreshInFlight: Promise<GithubAccessTokenResult> | null = null;
  // 会话代际：clearSession（退出登录）先递增。在飞刷新发起请求前捕获代际，
  // 拿到响应后比对；不一致说明用户已登出，本次结果必须丢弃，否则会把凭据写回。
  let writeEpoch = 0;
  // 刷新成功但写盘失败时的内存兜底：磁盘上仍是已作废的旧 refresh token，
  // 若下次调用重读磁盘会触发 bad_refresh_token 并立刻逼用户重新登录。
  // 同进程后续调用优先使用这份 session，直到持久化成功或被新登录取代。
  let unpersistedSession: GithubTokenSession | null = null;

  /** 只读磁盘凭据（含旧 key 迁移）；不经过内存兜底。 */
  const readPersistedSession = async (): Promise<GithubTokenSession | null> => {
    const rawTokenSet = await credentialService.load(GITHUB_TOKEN_SET_CREDENTIAL_KEY);
    if (rawTokenSet !== null) {
      const parsed = parseTokenSet(rawTokenSet);
      if (parsed) return parsed;
      // 解析失败按“不存在”处理：只告警、不自动删除（登录时会覆盖），并继续尝试旧 key。
    }
    const legacyToken =
      (await credentialService.load(GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY))?.trim() ?? "";
    // 旧 key 没有过期时间与 refresh token：按长期 token 使用，不触发刷新。
    return legacyToken.length > 0 ? { accessToken: legacyToken } : null;
  };

  const getSession = async (): Promise<GithubTokenSession | null> => {
    // 内存兜底优先：它是最近一次刷新成功的结果，磁盘可能仍是已作废的旧 refresh token。
    if (unpersistedSession) return unpersistedSession;
    return readPersistedSession();
  };

  const saveSession = async (session: GithubTokenSession): Promise<void> => {
    const normalized = normalizeSessionForWrite(session);
    await credentialService.save(GITHUB_TOKEN_SET_CREDENTIAL_KEY, JSON.stringify(normalized));
    // 落盘成功后内存兜底已被持久化取代（外部登录与刷新共用这条路径）。
    unpersistedSession = null;
    // 先写新 key 再删旧 key：删除失败最多残留一条无效副本，不会丢登录。
    try {
      await credentialService.delete(GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY);
    } catch (error) {
      log.warn(
        undefined,
        "github legacy access token key could not be removed",
        describeRequestError(error),
      );
    }
  };

  const clearSession = async (): Promise<void> => {
    // 必须先递增代际再删 key：在飞刷新拿到成功响应后会比对代际，
    // 只有这样才能保证 signOut 返回后凭据不会被在飞刷新写回。
    writeEpoch += 1;
    unpersistedSession = null;
    // 两个 key 都尝试删除：第一个失败不能跳过第二个（可能残留有效旧 key）。
    const results = await Promise.allSettled([
      credentialService.delete(GITHUB_TOKEN_SET_CREDENTIAL_KEY),
      credentialService.delete(GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY),
    ]);
    const failedKeys: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const key =
          index === 0 ? GITHUB_TOKEN_SET_CREDENTIAL_KEY : GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY;
        failedKeys.push(key);
        log.warn(
          undefined,
          "github token credential could not be removed",
          key,
          describeRequestError(result.reason),
        );
      }
    }
    if (failedKeys.length > 0) {
      // 删除失败不能宣称已退出：只带 key 名，绝不含 token。
      throw new Error(`GitHub 凭据删除失败: ${failedKeys.join(", ")}`);
    }
  };

  /**
   * 内部自动清理（非用户主动退出）的最优努力版本：
   * 清理失败只告警、不抛错，避免把可恢复的 reauth 判定变成 RPC 异常。
   */
  const clearSessionQuietly = async (reason: string): Promise<void> => {
    try {
      await clearSession();
    } catch (error) {
      log.warn(
        undefined,
        "github session cleanup failed during reauthorization",
        reason,
        describeRequestError(error),
      );
    }
  };

  const requireRefresh = async (
    session: GithubTokenSession,
    force: boolean,
  ): Promise<GithubAccessTokenResult> => {
    if (!session.refreshToken) {
      // 没有 refresh token 就无法续期：清掉凭据，明确要求重新授权。
      // 自动清理失败不能变成 RPC 异常，仍按 reauth_required 返回。
      await clearSessionQuietly("missing_refresh_token");
      log.warn(undefined, "github session requires reauthorization", "missing_refresh_token");
      return { status: "reauth_required" };
    }
    if (session.refreshTokenExpiresAt !== undefined && now() >= session.refreshTokenExpiresAt) {
      await clearSessionQuietly("refresh_token_expired");
      log.warn(undefined, "github session requires reauthorization", "refresh_token_expired");
      return { status: "reauth_required" };
    }
    if (refreshInFlight) return refreshInFlight;
    const run = performRefresh(session, force).finally(() => {
      if (refreshInFlight === run) refreshInFlight = null;
    });
    refreshInFlight = run;
    return run;
  };

  /**
   * 网络/超时/非法响应后的兜底：非强制刷新且当前 access token 仍未过期时继续用旧 token；
   * 强制刷新（`/user` 已返回 401）时绝不能把同一个被拒 token 当成功返回。
   *
   * 返回的 token 不是本次刷新产物，`refreshed` 恒为 false；失败分类为 network
   *（配置类错误不走到这里）。
   */
  const fallbackAfterTransientFailure = (
    session: GithubTokenSession,
    force: boolean,
  ): GithubAccessTokenResult => {
    if (!force && isAccessTokenCurrentlyValid(session, now())) {
      return { status: "ok", token: session.accessToken, refreshed: false };
    }
    return { status: "temporarily_unavailable", reason: "network" };
  };

  /** 读数已变且当前可用：说明别的 provider / Host 已经完成轮换，直接复用。 */
  const isSupersedingSession = (
    candidate: GithubTokenSession | null,
    failedSession: GithubTokenSession,
  ): candidate is GithubTokenSession =>
    candidate !== null &&
    candidate.accessToken !== failedSession.accessToken &&
    isAccessTokenCurrentlyValid(candidate, now());

  /**
   * bad_refresh_token 的处理必须 compare-and-delete：
   * 「读旧值 → 别的 provider 写入新值 → 我直接 delete」会误删刚轮换出的新凭据。
   */
  const handleBadRefreshToken = async (
    failedSession: GithubTokenSession,
  ): Promise<GithubAccessTokenResult> => {
    // 跨进程 / 多 Host 场景：另一个 host 可能已经轮换过 token。
    // 先从磁盘重读（不用内存兜底，避免它掩盖别的 Host 刚写入的新值），
    // 只有“仍是本次失败所用 token”时才判定需要重新授权。
    const reread = await readPersistedSession().catch((error: unknown) => {
      log.warn(undefined, "github token set reread failed", describeRequestError(error));
      return null;
    });
    if (isSupersedingSession(reread, failedSession)) {
      log.info(undefined, "github refresh token superseded by another session");
      // 复用的是别的 provider / Host 写入的 token，不是本次刷新产物。
      return { status: "ok", token: reread.accessToken, refreshed: false };
    }

    const { deleteIf } = credentialService;
    if (!deleteIf) {
      // 没有 host 内部 compare-and-delete（例如测试 fake）：保守路径不删除任何凭据，
      // 避免把别的 provider / Host 刚写入的新值删掉。
      unpersistedSession = null;
      log.warn(
        undefined,
        "github refresh token rejected without compare-and-delete",
        "bad_refresh_token",
      );
      return { status: "reauth_required" };
    }

    let removed = false;
    try {
      // 谓词只认「accessToken 与 refreshToken 都仍是本次失败值」；值已变化说明
      // 别的 provider 完成过轮换，不能删。
      removed = await deleteIf(GITHUB_TOKEN_SET_CREDENTIAL_KEY, (plaintext) => {
        const stored = parseTokenSet(plaintext);
        if (!stored) return false;
        return (
          stored.accessToken === failedSession.accessToken &&
          stored.refreshToken === failedSession.refreshToken
        );
      });
    } catch (error) {
      // 删除失败按“未删除”处理：宁可保留一条失效凭据，也不误删别人的新值。
      log.warn(
        undefined,
        "github token set compare-and-delete failed",
        describeRequestError(error),
      );
      removed = false;
    }

    if (removed) {
      unpersistedSession = null;
      log.warn(undefined, "github refresh token rejected", "bad_refresh_token");
      return { status: "reauth_required" };
    }

    // 谓词不匹配 / key 已不存在：写入方可能刚完成轮换，再读一次看是否已有有效新值。
    const afterDelete = await readPersistedSession().catch((error: unknown) => {
      log.warn(undefined, "github token set reread failed", describeRequestError(error));
      return null;
    });
    if (isSupersedingSession(afterDelete, failedSession)) {
      log.info(undefined, "github refresh token superseded by another session");
      return { status: "ok", token: afterDelete.accessToken, refreshed: false };
    }
    // 明确判定需要重新授权时才丢弃内存兜底：否则后续调用会继续用已作废的会话重试。
    unpersistedSession = null;
    log.warn(undefined, "github refresh token rejected", "bad_refresh_token");
    return { status: "reauth_required" };
  };

  const performRefresh = async (
    session: GithubTokenSession,
    force: boolean,
  ): Promise<GithubAccessTokenResult> => {
    const refreshToken = session.refreshToken;
    if (!refreshToken) return fallbackAfterTransientFailure(session, force);
    // 发请求前捕获会话代际：响应回来时若用户已登出（clearSession 递增了 writeEpoch），
    // 本次结果必须丢弃，不能写回凭据、也不能回退到已删除的旧 token。
    const epoch = writeEpoch;

    let body: Record<string, unknown>;
    try {
      const response = await fetchImpl(GITHUB_ACCESS_TOKEN_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        // 刻意不携带 client_secret：我们的 token 由设备码流程签发，GitHub 文档明确
        // refresh 的 client_secret 仅对“非设备码流程签发”的 token 必需；把 secret 打进
        // 客户端才是真正的安全问题。不要“补”上它。
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: REFRESH_GRANT_TYPE,
          refresh_token: refreshToken,
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const raw: unknown = await response.json();
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`响应格式非法（HTTP ${response.status}）`);
      }
      body = raw as Record<string, unknown>;
    } catch (error) {
      // 网络 / 超时 / 非 JSON：不打印请求体与 token，只记录可读原因。
      log.warn(undefined, "github token refresh request failed", describeRequestError(error));
      if (epoch !== writeEpoch) {
        // 登出已经删掉凭据：网络失败也不能再回退到旧 token。
        log.info(undefined, "github token refresh discarded after sign out");
        return { status: "none" };
      }
      return fallbackAfterTransientFailure(session, force);
    }

    // 响应已到但用户已登出：无论成功还是失败都不再写盘 / 复用，直接丢弃本次结果。
    // 这是「登出压过在飞刷新」的核心判定点，必须在任何写操作之前。
    if (epoch !== writeEpoch) {
      log.info(undefined, "github token refresh discarded after sign out");
      return { status: "none" };
    }

    const errorCode =
      typeof body.error === "string" && body.error.length > 0 ? body.error : undefined;
    if (errorCode) {
      if (errorCode === "bad_refresh_token") {
        return handleBadRefreshToken(session);
      }
      // 配置/协议类错误（如 incorrect_client_credentials）：保留凭据，不引导用户重复登录。
      // 与网络失败区分开：config-sync 据此提示「检查 OAuth App 配置」而不是「稍后重试」。
      log.error(undefined, "github token refresh failed", errorCode);
      return { status: "temporarily_unavailable", reason: "configuration" };
    }

    const accessToken = typeof body.access_token === "string" ? body.access_token.trim() : "";
    if (!accessToken) {
      log.warn(undefined, "github token refresh returned no access token");
      return fallbackAfterTransientFailure(session, force);
    }

    const rotatedRefreshToken =
      typeof body.refresh_token === "string" ? body.refresh_token.trim() : "";
    const expiresIn = positiveNumber(body.expires_in);
    const refreshTokenExpiresIn = positiveNumber(body.refresh_token_expires_in);
    const issuedAt = now();
    const nextSession: GithubTokenSession = {
      accessToken,
      // refresh_token 缺失时不保留旧值：GitHub 刷新即轮换，旧 refresh token 已作废。
      ...(rotatedRefreshToken ? { refreshToken: rotatedRefreshToken } : {}),
      ...(expiresIn !== undefined ? { accessTokenExpiresAt: issuedAt + expiresIn * 1000 } : {}),
      ...(refreshTokenExpiresIn !== undefined
        ? { refreshTokenExpiresAt: issuedAt + refreshTokenExpiresIn * 1000 }
        : {}),
    };

    // 先落盘再返回：写盘失败时本次仍可用新 token，但必须显式记录，不能假装持久化成功。
    try {
      await saveSession(nextSession);
    } catch (error) {
      // 写盘失败：把新 session 放进内存兜底，同进程后续调用继续用它。
      // 否则下次会重读磁盘上已作废的旧 refresh token → bad_refresh_token → 立刻逼用户重新登录。
      unpersistedSession = nextSession;
      log.error(undefined, "github token refresh could not be persisted", {
        key: GITHUB_TOKEN_SET_CREDENTIAL_KEY,
        detail: describeRequestError(error),
      });
    }

    log.info(undefined, "github access token refreshed", {
      refreshTokenRotated: rotatedRefreshToken.length > 0,
    });
    return { status: "ok", token: accessToken, refreshed: true };
  };

  const getAccessToken = async (): Promise<GithubAccessTokenResult> => {
    const session = await getSession();
    if (!session) return { status: "none" };
    if (session.accessTokenExpiresAt === undefined) {
      // 长期 token（旧 key 迁移或 GitHub 未给 expires_in）：不刷新。
      return { status: "ok", token: session.accessToken, refreshed: false };
    }
    if (now() < session.accessTokenExpiresAt - REFRESH_SKEW_MS) {
      return { status: "ok", token: session.accessToken, refreshed: false };
    }
    return requireRefresh(session, false);
  };

  const refreshAfterRejectedToken = async (
    rejectedToken: string,
  ): Promise<GithubAccessTokenResult> => {
    const session = await getSession();
    if (!session) return { status: "none" };
    if (session.accessToken !== rejectedToken) {
      // 已被其它调用刷新过：按正常过期规则复用/刷新，不重复强制刷新。
      return getAccessToken();
    }
    // GitHub 已明确拒绝该 token：跳过 skew 判断强制刷新一次。
    const result = await requireRefresh(session, true);
    if (result.status === "ok" && result.token === rejectedToken) {
      // 单飞可能复用了其它调用“网络失败时继续用旧 token”的兜底结果。
      // 该 token 已被 401 拒绝，不能再当成功返回，否则调用方会重试并误删凭据。
      return { status: "temporarily_unavailable", reason: "network" };
    }
    return result;
  };

  return {
    getSession,
    getAccessToken,
    refreshAfterRejectedToken,
    saveSession,
    clearSession,
  };
}

function parseTokenSet(raw: string): GithubTokenSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log.warn(undefined, "github token set is not valid JSON; treating it as missing");
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    log.warn(undefined, "github token set has invalid shape; treating it as missing");
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const accessToken = typeof record.accessToken === "string" ? record.accessToken.trim() : "";
  if (!accessToken) {
    log.warn(undefined, "github token set is missing access token; treating it as missing");
    return null;
  }
  const accessTokenExpiresAt = parseOptionalTimestamp(record.accessTokenExpiresAt);
  const refreshTokenExpiresAt = parseOptionalTimestamp(record.refreshTokenExpiresAt);
  if (!accessTokenExpiresAt.ok || !refreshTokenExpiresAt.ok) {
    log.warn(undefined, "github token set has invalid expiry; treating it as missing");
    return null;
  }
  const refreshToken = typeof record.refreshToken === "string" ? record.refreshToken.trim() : "";
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(accessTokenExpiresAt.value !== undefined
      ? { accessTokenExpiresAt: accessTokenExpiresAt.value }
      : {}),
    ...(refreshTokenExpiresAt.value !== undefined
      ? { refreshTokenExpiresAt: refreshTokenExpiresAt.value }
      : {}),
  };
}

function parseOptionalTimestamp(value: unknown): { ok: true; value?: number } | { ok: false } {
  if (value === undefined || value === null) return { ok: true };
  if (isFinitePositiveNumber(value)) return { ok: true, value };
  return { ok: false };
}

function normalizeSessionForWrite(session: GithubTokenSession): GithubTokenSession {
  const accessToken = session.accessToken.trim();
  if (!accessToken) {
    throw new Error("GitHub access token 为空，拒绝写入凭据");
  }
  const refreshToken = session.refreshToken?.trim() ?? "";
  return {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(isFinitePositiveNumber(session.accessTokenExpiresAt)
      ? { accessTokenExpiresAt: session.accessTokenExpiresAt }
      : {}),
    ...(isFinitePositiveNumber(session.refreshTokenExpiresAt)
      ? { refreshTokenExpiresAt: session.refreshTokenExpiresAt }
      : {}),
  };
}

function isAccessTokenCurrentlyValid(session: GithubTokenSession, nowMs: number): boolean {
  return session.accessTokenExpiresAt === undefined || nowMs < session.accessTokenExpiresAt;
}

function positiveNumber(value: unknown): number | undefined {
  return isFinitePositiveNumber(value) ? value : undefined;
}

function isFinitePositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
