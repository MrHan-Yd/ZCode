import type { CredentialServiceAccess } from "../credential/credential.js";
import {
  createGithubTokenProvider,
  type GithubTokenSession,
} from "../github/githubTokenProvider.js";
import type { ConfigSyncError } from "./types.js";

export interface ConfigSyncTokenAccess {
  /** 只读本地凭据（含旧 key 迁移），不刷新、不出网。 */
  readSession(): Promise<GithubTokenSession | null>;
  /** 取可用 access token；失败映射为 config-sync 的稳定错误码。 */
  resolveAccessToken(): Promise<
    { ok: true; token: string } | { ok: false; error: ConfigSyncError }
  >;
}

/**
 * config-sync 的取 token 入口：统一经 GithubTokenProvider，
 * 避免各功能自己读旧 key、也避免与账号授权服务各建一套刷新逻辑。
 */
export function createConfigSyncTokenAccess(options: {
  readonly credentialService?: CredentialServiceAccess;
  readonly fetchImpl?: typeof fetch;
}): ConfigSyncTokenAccess {
  // 每个 config-sync 实例各自创建 provider（不做跨实例单例）：
  // 单飞只保证同一实例内；跨实例竞争由 provider 的 bad_refresh_token 重读 +
  // compare-and-delete 兜底。这样也不会把「首个创建者的 fetchImpl」隐式固化成全局单例。
  const provider = options.credentialService
    ? createGithubTokenProvider({
        credentialService: options.credentialService,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      })
    : null;

  const loadToken = async () => (await provider?.getAccessToken()) ?? { status: "none" as const };

  return {
    readSession: async () => (await provider?.getSession()) ?? null,
    async resolveAccessToken() {
      const result = await loadToken();
      if (result.status === "ok") return { ok: true, token: result.token };
      if (result.status === "temporarily_unavailable") {
        // 网络问题可稍后重试；配置类错误（OAuth App 配置 / 凭据错误）重试无效，需检查配置。
        if (result.reason === "configuration") {
          return {
            ok: false,
            error: {
              code: "unknown",
              message: "GitHub 授权刷新失败，请检查 OAuth App 配置或重新登录",
            },
          };
        }
        return {
          ok: false,
          error: { code: "network", message: "无法刷新 GitHub 授权，请稍后重试" },
        };
      }
      return {
        ok: false,
        error: {
          code: "not_authenticated",
          message: result.status === "reauth_required" ? "GitHub 授权已过期，请重新登录" : "未登录",
        },
      };
    },
  };
}
