import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 旧版 access token 在凭据库中的 key。
 *
 * 现在只作为**只读迁移来源**：旧版本只写过它；新代码不再向它写入，登录/刷新成功写入
 * `github:oauth:token_set` 后会删除它。需要调用 GitHub API 的服务统一经
 * `GithubTokenProvider.getAccessToken()` 取 token，不直接读这个 key。
 */
export const GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY = "github:oauth:access_token";

/**
 * GitHub OAuth App 的公开 client id。
 *
 * Device Flow 与 refresh token 流程都不需要 client secret（RFC 8628 / GitHub 文档：
 * refresh 的 `client_secret` 仅对非设备码流程签发、且过期的 token 必需），因此内嵌进源码是安全的。
 * 授权服务与 token provider 共用同一常量，避免两处硬编码漂移。
 */
export const GITHUB_OAUTH_CLIENT_ID = "Ov23lib5yQwc5KZxAgz7";

/** GitHub 账号展示信息；来自 `GET https://api.github.com/user`，不持久化。 */
export interface GithubAuthAccount {
  readonly login: string;
  readonly name?: string;
  readonly avatarUrl?: string;
}

/**
 * 发起设备码授权的结果。
 *
 * 判别联合：`ok` 时 deviceCode/userCode/verificationUri/interval/expiresAt 全部必填，
 * 类型层面堵掉「ok 却没有设备码」导致消费者永久空转的洞。
 * - `not_configured`：client id 未配置，不发任何网络请求。
 * - `device_flow_disabled`：OAuth App 未勾选 Enable Device Flow（UI 专门提示）。
 * - `error`：其它 GitHub 错误码 / 缺 device_code / 缺 user_code / 缺 verification_uri / 响应非法
 *   （`message` 点明原因，不含 token）。
 *
 * 真正的网络 / 超时异常仍以抛异常形式冒出（见实现）。
 */
export type GithubAuthBeginResult =
  | {
      readonly status: "ok";
      readonly deviceCode: string;
      readonly userCode: string;
      readonly verificationUri: string;
      /** 轮询间隔（秒），GitHub 默认 5。 */
      readonly interval: number;
      /** 设备码过期时间（epoch ms）。 */
      readonly expiresAt: number;
    }
  | { readonly status: "not_configured" }
  | { readonly status: "device_flow_disabled" }
  | { readonly status: "error"; readonly message: string };

/**
 * 轮询一次设备码的结果。
 * 服务端无状态、不保存 deviceCode；UI 把上次使用的 `interval` 回传，host 据此计算新间隔。
 */
export interface GithubAuthPollResult {
  readonly status: "pending" | "success" | "denied" | "expired" | "device_flow_disabled" | "error";
  /** 仅 pending 时给，UI 下次应使用的间隔（秒）。 */
  readonly interval?: number;
  readonly account?: GithubAuthAccount;
  /** 仅 error 时给，可读文案（不含 token）。 */
  readonly message?: string;
}

/** 当前 GitHub 账号连接态；token 明文只存在 host 侧。 */
export interface GithubAuthAccountState {
  readonly connected: boolean;
  readonly login?: string;
  readonly name?: string;
  readonly avatarUrl?: string;
  /**
   * `connected` = 本机存在 GitHub 凭据（不代表 token 此刻一定可用）。
   * - `"unverified"`：凭据在，但当前无法向 GitHub 验证（网络失败 / 刷新暂时失败）。
   * - `"reauth_required"`（此时 connected=false）：refresh token 也已失效，必须重新授权。
   */
  readonly reason?: "reauth_required" | "unverified";
}

/**
 * GitHub 账号授权服务（OAuth Device Flow）。
 *
 * access token 的唯一所有者是本服务（host 侧），经 `ICredentialService` 加密持久化；
 * UI 只读状态、只发命令，不缓存 token 明文。设备码无状态，host 不保存中间态。
 */
export interface IGithubAuthService {
  /** 发起设备码授权。not_configured = client_id 未配置；device_flow_disabled / error 见上方说明。 */
  beginDeviceAuth(): Promise<GithubAuthBeginResult>;
  /**
   * 轮询一次。服务端无状态、不保存 deviceCode；
   * UI 把上次使用的 `interval`（秒，缺省 5）回传，host 据此在 slow_down 时递进。
   */
  pollDeviceAuth(params: { deviceCode: string; interval?: number }): Promise<GithubAuthPollResult>;
  getAccount(): Promise<GithubAuthAccountState>;
  signOut(): Promise<void>;
}

export const IGithubAuthService = createServiceDescriptor<IGithubAuthService>(
  ServiceChannels.GithubAuth,
);
