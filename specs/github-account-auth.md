# GitHub 账号授权（GitHub account auth，Device Flow）

## 背景

设置页「同步配置」需要让用户用 GitHub 账号登录，后续用于创建/上传私有 gist 等能力。本改动只交付
**授权与账号查询**：发起设备码授权、轮询换 token、把 token 存进仓库既有加密凭据库、查询当前账号、
退出登录。创建/上传私有 gist 属于后续改动，本次不实现。

### 为什么要处理刷新令牌（2026-10-27 补充）

GitHub OAuth App 开启 `Expire user access tokens` 后，设备码换来的 access token **8 小时**过期，
refresh token **闲置 6 个月**过期。旧实现只保存 access token，`expires_in` / `refresh_token` 被直接丢弃，
也没有任何过期判断，于是每 8 小时必然失效一次；同时 `getAccount` 把任意 401 当成「授权已撤销」并删除
凭据，用户被迫重新登录。

线上日志已证实该链路（`%ZCODE_DATA%/.zcode/v2/logs`）：三次授权都在登录后约 7 小时 40 分仍有效，
下一次访问即出现 `github account token rejected, credential cleared`。因此本 spec 增加
**自动刷新 + 401 软失败**，把「重新授权的周期」从 8 小时拉长到 refresh token 的 6 个月。

### 文档依据：刷新不需要 client secret

GitHub 文档 [Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
的「Refreshing user access tokens」章节给出：

- access token 8 小时过期，refresh token 6 个月不用则过期（`expires_in=28800`、`refresh_token_expires_in=15897600`）。
- 刷新：`POST https://github.com/login/oauth/access_token`，参数 `client_id`、`client_secret`
  （原文：**"Required unless the token was generated using the device flow"**）、`grant_type=refresh_token`、
  `refresh_token`。我们的 token 来自设备码流程，因此**不携带 client secret**，桌面端无需内嵌密钥。
- 刷新是**轮换**：原文「that refresh token and the old access token will no longer work」。
- refresh token 无效/过期返回 `bad_refresh_token`，只能重新走设备码授权。
- `offline_access` scope 可强制签出带刷新令牌的短期 token；本 spec **不引入**该 scope（scope 继续冻结）。

> 代码里刷新请求不带 `client_secret` 是刻意的，不要「补」上它：设备码流程签发的 token 按上述文档不需要，
> 而把 secret 打进客户端才是真正的安全问题。

### 为什么用 Device Flow，而不是回环端口 / 深链

- **GitHub OAuth App 不支持 PKCE**：GitHub 的 OAuth App（`Ov23...` 前缀的 client id）不支持
  `code_challenge`，授权码流程必须携带 client secret。桌面应用无法安全内嵌 secret，因此不能用
  Authorization Code + 回环端口方案。
- **回环端口必须内嵌 client secret**：即便起本地 HTTP 回调端口，换 token 时仍要 `client_secret`，
  等于把密钥打进客户端，不可接受。
- **Web / 手机端无 `zcode://` 深链**：深链回调只在 Electron 桌面可用；Web 与手机远控没有自定义协议
  注册，无法接收授权码回调。
- **Device Flow 无需 secret**：设备码流程（RFC 8628）只需公开 client id，用户在系统浏览器里输入
  `user_code` 完成授权，客户端轮询换 token。跨桌面 / Web / 手机一致可用。

## 参数（冻结）

- **client id**：`Ov23lib5yQwc5KZxAgz7`（GitHub OAuth App 的**公开** client id，内嵌进源码；
  Device Flow 不需要 client secret，因此公开内嵌是安全的）。
- **scope**：`gist read:user`（`gist` 供创建私有 gist，`read:user` 供显示登录账号）。
  **不追加 `offline_access`**：它会强制所有用户使用 8 小时 token，属于产品行为变更，需另议。
- **凭据 key（两段式）**：
  - `github:oauth:token_set`：JSON 字符串，唯一权威事实：
    ```json
    {
      "accessToken": "gho_...",
      "refreshToken": "ghr_...",
      "accessTokenExpiresAt": 1790000000000,
      "refreshTokenExpiresAt": 1795000000000
    }
    ```
    `refreshToken` / 两个过期时间都可缺省（长期 token 场景）。过期时间是 **epoch ms**，由 host 时钟写入。
  - `github:oauth:access_token`：**只读迁移来源**。旧版本只写过它；新代码只读不再写，登录/刷新成功后删除它。
- **token 寿命**：access token 8 小时（`expires_in=28800`）；refresh token 闲置 6 个月
  （`refresh_token_expires_in=15897600`）。两者都以 `expires_in` 为准，不硬编码。
- **提前刷新窗口**：`REFRESH_SKEW_MS = 5 分钟`。`now >= accessTokenExpiresAt - 5min` 即视为需要刷新。
- **请求超时**：`AbortSignal.timeout(20_000)`，与 `modelSmartConfigService.ts` 同风格。

## 网络路径（必须走 host 的代理感知传输）

本服务的 `fetchImpl` **必须**注入 `createLocalServices` 里的 `hostApiNetworkTransport.fetch`，
不能用 `globalThis.fetch`。原因：

- Node 的 `globalThis.fetch`（undici）**不认** `http_proxy` / `https_proxy` 环境变量，只会直连。
  在「只有代理能出网」的环境下，请求表现为 `fetch failed` + cause
  `UND_ERR_CONNECT_TIMEOUT (github.com:443)`。浏览器走系统代理所以能打开授权页、显示授权成功，
  服务端却连不上——这是首次接入 GitHub 时真实踩到的故障。
- `hostApiNetworkTransport`（`packages/services/src/providers/api/nodeApiNetwork.ts`）按设置里的
  `httpProxy` / `httpProxyNoProxy` / `httpProxyCaCertPath` **逐请求**解析 dispatcher（与模型 API
  同一条代理策略），设置变更即时生效。
- 网络异常的可读文案必须带出 cause 链上的 `code`（`describeError`）。只报 `fetch failed` 时无法
  区分「没配代理」「DNS 失败」还是「证书问题」，这一坑已经踩过一次。

**注意**：该传输只读**应用设置**里的代理，**不读**环境变量。因此需要代理才能访问 GitHub 的环境，
用户必须在设置里配置 HTTP 代理，并把本机模型网关这类地址放进 no-proxy 列表（否则模型流量会被
绕进代理）。是否让代理解析回退到标准环境变量，是共享网络层（影响模型 API 全部流量）的语义决策，
不在本 spec 范围。

`modelSmartConfigService`（拉取远端 gist）有同一问题，一并改走同一条传输。

## 接口契约（冻结，前端并行开发，不得改方法名 / 字段名）

```ts
export type GithubAuthBeginResult =
  | {
      status: "ok";
      deviceCode: string;
      userCode: string;
      verificationUri: string;
      interval: number;    // 秒，GitHub 默认 5
      expiresAt: number;   // epoch ms
    }
  | { status: "not_configured" }
  | { status: "device_flow_disabled" }
  | { status: "error"; message: string };  // 可读文案，不含 token

export interface IGithubAuthService {
  beginDeviceAuth(): Promise<GithubAuthBeginResult>;
  pollDeviceAuth(params: {
    deviceCode: string;
    interval?: number;   // UI 上次使用的轮询间隔（秒），缺省 5
  }): Promise<{
    status: "pending" | "success" | "denied" | "expired" | "device_flow_disabled" | "error";
    interval?: number;   // 仅 pending 时给，UI 下次应使用的间隔
    account?: { login: string; name?: string; avatarUrl?: string };
    message?: string;
  }>;
  getAccount(): Promise<GithubAuthAccountState>;
  signOut(): Promise<void>;
}

/** 冻结：方法名/字段名不变，只新增可选 `reason`。 */
export interface GithubAuthAccountState {
  connected: boolean;
  login?: string;
  name?: string;
  avatarUrl?: string;
  /**
   * `connected` = 本机存在 GitHub 凭据（不代表 token 此刻一定可用）。
   * - `"unverified"`：凭据在，但当前无法向 GitHub 验证（网络失败 / 刷新暂时失败）。
   * - `"reauth_required"`（此时 connected=false）：refresh token 也已失效，必须重新授权。
   */
  reason?: "reauth_required" | "unverified";
}
```

Channel：`github-auth`（`ServiceChannels.GithubAuth`）。

**内部契约（不暴露给 UI）**：`packages/services/src/github/githubTokenProvider.ts`

```ts
export interface GithubTokenSession {
  accessToken: string;
  refreshToken?: string;
  accessTokenExpiresAt?: number;   // epoch ms
  refreshTokenExpiresAt?: number;  // epoch ms
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
  | { status: "none" }                     // 从未登录 / 已退出
  | { status: "reauth_required" }          // refresh token 已失效：凭据已删除或确认不可用
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

export function createGithubTokenProvider(options: {
  /**
   * host 内部端口的超集：`deleteIf` 是 compare-and-delete，不进 RPC 契约。
   * 生产由 `createCredentialService()` 直接提供；测试 fake 可不实现。
   */
  credentialService: Pick<ICredentialService, "load" | "save" | "delete"> & {
    deleteIf?(key: string, predicate: (plaintext: string) => boolean): Promise<boolean>;
  };
  fetchImpl?: typeof fetch;
  clientId?: string;
  now?: () => number;   // 测试注入
}): IGithubTokenProvider;
```

> RPC 暴露面：`ServiceCollection.exposeOnChannelServer` 用 `ProxyChannel.fromService` 包装实例，会把对象上
> **任意函数属性**都变成可调用方法。因此 host 注册时必须用
> `toRpcCredentialService(credentialService)` 收窄成 `{load, save, delete}`，不能直接注册带 `deleteIf` 的 host 对象。

`begin` 用**判别联合**：`ok` 时 `deviceCode/userCode/verificationUri/interval/expiresAt` 全部必填，
类型层面堵掉「ok 却没有设备码 → 消费者永久空转」的洞。GitHub 返回了 `device_code` 但缺
`user_code` / `verification_uri` 时落到 `status: "error"`（message 点明缺哪个字段），**不硬凑空串**。
`poll` 的形状保持可选字段不动（`account` 可能缺、`message` 仅 error、`interval` 仅 pending 是真实可选）。

## 状态所有者

- **token set（access + refresh + 过期时间）**：唯一所有者是 host 侧 `GithubTokenProvider`
  （`packages/services/src/github/githubTokenProvider.ts`，内部接口，不是 RPC 服务）。
  - 负责读取 / 刷新 / 轮换 / 删除，经 `ICredentialService`（AES-256-GCM）持久化到 `credentials.json`。
  - **不做跨实例单例**：授权服务与每个 config-sync 实例各自 `createGithubTokenProvider({credentialService, fetchImpl})`，
    直接使用注入的凭据端口与代理感知传输。取消早期的 `getGithubTokenProvider` / WeakMap 记忆：
    「首个创建者决定 `fetchImpl`」会把单例静默固化成 `globalThis.fetch`（不认代理），是隐式耦合。
  - **单飞只保证同一 provider 实例内**（共享同一个刷新 Promise）。跨 provider / 跨进程并发由
    `bad_refresh_token` 重读 + compare-and-delete 兜底：最坏多一次刷新请求，但**不会误删**对方刚写入的新凭据。
  - **compare-and-delete**：凭据服务新增 host 内部原语 `deleteIf(key, predicate)`——在同一文件锁内
    读取、解密、执行 predicate、删除并原子写回，返回是否删除；**不进 RPC 接口**（renderer 不可用）。
    `bad_refresh_token` 后只有在「库里的 token 仍是本次失败所用值」时才删除；值已变化说明别的 provider/Host
    已轮换，直接复用新值。没有 `deleteIf` 的注入（测试 fake）走保守路径：**不删除**，只返回 `reauth_required`。
  - `GithubAuthService` 只发命令：登录成功 `saveSession`、退出登录 `clearSession`、`getAccount` 先
    `getAccessToken` 再 `GET /user`。它不再自己读写 token key。
  - **config-sync 不再直接 `load("github:oauth:access_token")`**：统一经 provider 的 `getAccessToken()`；
    其 `credentialService` 选项类型放宽为 `load | save | delete`（host 注入的是完整服务，删除
    `tokenAccess` 里 `as CredentialAccess` 的类型断言）。
  - **退出登录必须压过在飞刷新（会话代际）**：provider 维护 `writeEpoch`，`clearSession` 先递增；
    刷新在发起请求前捕获代际，写盘前比对，不一致就丢弃本次结果并返回 `none`。保证 `signOut` 返回后
    凭据不会又被写回。
  - **跨进程 / 多 Host**：另一个 host 可能已轮换。收到 `bad_refresh_token` 时先**重读凭据库**；若读到
    与本次失败所用 token 不同、且当前有效的 access token，直接复用；否则走 compare-and-delete 判定。
  - **旧 key 迁移**：`token_set` 不存在但 `github:oauth:access_token` 存在时，按「无过期时间的长期
    token」使用（不刷新）；下一次登录/刷新写 `token_set` 后删除旧 key。新代码不向旧 key 写入。
  - **写盘失败的内存兜底**：刷新成功但 `saveSession` 抛错时，把新 session 缓存在 provider 内存里并继续使用
    （`log.error` 不吞）；后续调用优先用这份内存 session，直到持久化成功或被新登录取代。否则同一进程下次
    调用会重读旧 refresh token → `bad_refresh_token` → 立刻逼用户重新登录，与「只影响下次启动」的语义不符。
- **设备码中间态**：**无状态**。host 不保存 `deviceCode`、不保存轮询会话、不做定时器；`pollDeviceAuth`
  每次都是独立请求，`deviceCode` 由 UI 透传。为了让 `slow_down` 能真正退避递进，UI 把**上次使用的
  `interval`** 作为入参回传，host 据此计算新间隔（缺省按 5 处理）。「上次间隔」是 UI 侧事实，host 不落任何状态。
- **账号展示信息（login/name/avatarUrl）**：不单独持久化，`getAccount` / `poll` 成功时按需调用
  `GET https://api.github.com/user` 现取。持久化事实仍是 token set。
  - **`connected: true` 时 `login` 可能缺失**：凭据存在但 `GET /user` 因网络/非 401 失败时，返回
    `{ connected: true, reason: "unverified" }` 而不带账号字段。UI 只显示已连接态，待下次 `getAccount`
    成功后再补全。UI 不得把「无 login」等同于「未连接」。
  - **`connected: false` 且 `reason: "reauth_required"`**：refresh token 也失效，UI 应说明「授权已过期，
    请重新登录」，而不是静默回到初始态。

## 时序

```
UI                     GithubAuthService                 GitHub
 │ beginDeviceAuth() ─────▶ POST /login/device/code
 │                         │  ◀── device_code,user_code,verification_uri,interval,expires_in
 │ ◀── {ok, deviceCode, userCode, verificationUri, interval, expiresAt}
 │
 │ openExternal(verification_uri)  ← UI 用系统浏览器打开
 │
 │ pollDeviceAuth({deviceCode}) ─▶ POST /login/oauth/access_token (grant_type=device_code)
 │                         │  ◀── {error:"authorization_pending"}  → {status:"pending", interval:5}
 │  (UI 等 interval 秒; 下次 poll 回传上次 interval)
 │ pollDeviceAuth({deviceCode,interval:5}) ─▶ ... ◀── {error:"slow_down"} → {status:"pending", interval:10}
 │ pollDeviceAuth({deviceCode,interval:10}) ─▶ ... ◀── {access_token, expires_in, refresh_token, refresh_token_expires_in, scope}
 │                         │ tokenProvider.saveSession({accessToken, refreshToken, ...})  ← 一次写入
 │                         │ delete("github:oauth:access_token")  ← 清掉旧 key
 │                         │ GET https://api.github.com/user (Bearer accessToken)
 │ ◀── {status:"success", account:{login,name?,avatarUrl?}}
 │
 │ getAccount() ──────────▶ tokenProvider.getAccessToken()
 │                         │  ├─ 未过期（距过期 > 5min）→ 直接用本地 token，不出网刷新
 │                         │  ├─ 临近/已过期 → refresh（见下）
 │                         │  └─ 无凭据 → {connected:false}
 │                         │ GET /user
 │ ◀── {connected:true, login, ...} / {connected:false, reason:"reauth_required"}
 │ signOut() ─────────────▶ tokenProvider.clearSession()（token_set + 旧 key）
```

### 刷新时序（可能由 settings / gist 同步任一方触发）

```
调用方                 GithubTokenProvider                    GitHub
 │ getAccessToken() ────▶ load("github:oauth:token_set")
 │                       │ now < expiresAt - 5min → 返回当前 token（无网络）
 │                       │ 否则：refreshInFlight ??= 本次刷新
 │                       │ POST /login/oauth/access_token
 │                       │   {client_id, grant_type:"refresh_token", refresh_token}   ← 无 client_secret
 │                       │ ◀── {access_token, expires_in, refresh_token, refresh_token_expires_in}
 │                       │ saveSession(新 token set)  ← 先落盘再返回
 │ ◀── {status:"ok", token: 新 access token}
 │
 │ 刷新失败分支：
 │   bad_refresh_token ──▶ 重读 token_set
 │                          ├─ 已被其它 host 轮换出有效 access token → 复用之
 │                          └─ 仍是本次失败值 → deleteIf(key, 值未变) 才删除
 │                                               → {status:"reauth_required"}
 │   网络/超时/其它 error ─▶ token 仍未过期 → 用当前 token
 │                          token 已过期 → {status:"temporarily_unavailable"}（凭据保留）
 │
 │ 退出登录并发：clearSession() 先 writeEpoch += 1 → 在飞刷新写盘前比对代际
 │              不一致 → 丢弃结果（不写回）→ 返回 none
```

事件顺序要点：
1. `begin` 只拿设备码，不落任何状态。
2. `poll` 由 UI 回传入参 `interval`；host 无状态，`slow_down` 在入参基础上 +5 实现递进。
3. `poll` 成功时**先落 token set 再拉账号**：token 是持久事实，`GET /user` 是展示增强，后者失败不影响登录成功。
4. `getAccount` 的读取永远以凭据库为准，不信任 UI 侧缓存。
5. **刷新先落盘、后使用**：写盘失败时本次仍可用新 token，但必须 `error` 记录「刷新结果未能持久化」，
   并把新 session 放进 provider 内存兜底，同进程后续调用继续用它；不得因为重读旧 refresh token 而立刻清凭据。
6. **旧 key 的删除发生在新 key 写入之后**：即使删除失败也只是残留一条无效副本，不会丢登录。
7. **登出压过在飞刷新**：`clearSession` 递增 `writeEpoch`；在飞刷新写盘前比对，不一致就丢弃结果。`signOut`
   返回后凭据必须保持已删除。
8. **删除必须 compare-and-delete**：`bad_refresh_token` 的删除在凭据文件锁内重新判断「值是否仍是本次失败值」，
   防止「读旧 → 对方写新 → 我删新」的丢更新。

## 失败语义

| 场景 | 触发 | 行为 |
| --- | --- | --- |
| `not_configured` | `begin` 时 client id 为空 | 返回 `{ status: "not_configured" }`，不发请求 |
| `device_flow_disabled` | GitHub 返回 `error=device_flow_disabled` | `begin` / `poll` 都返回 `{ status: "device_flow_disabled" }`（UI 专门提示去勾选 Enable Device Flow）。**两阶段都可能出现，语义相同**（依据见下方「文档依据」） |
| `authorization_pending` | 用户尚未在浏览器完成授权 | `poll` → `{ status: "pending", interval }`，`interval` = 入参间隔（缺省 5），**保持当前节奏** |
| `slow_down` | 轮询过快 | `poll` → `{ status: "pending", interval }`，`interval` = 入参间隔（缺省 5）+ 5，实现无状态递进（5 → 10 → 15 …） |
| `expired_token` | 设备码超时 | `poll` → `{ status: "expired" }` |
| `access_denied` | 用户点了拒绝 | `poll` → `{ status: "denied" }` |
| `begin` 其它 GitHub `error` / 缺 `device_code` / 响应非法 | 非 JSON、非对象、未知 `error` | `begin` → `{ status: "error", message }`（保留错误码，不含 token） |
| `begin` 缺 `user_code` / `verification_uri` | GitHub 返回 `device_code` 但缺其一 | `begin` → `{ status: "error", message }`（message 点明缺哪个字段），**不硬凑空串让 ok 成立** |
| `poll` 未知 `error` / 响应非法 / 网络异常 | fetch 抛错、超时、非 JSON、未知 `error` | `poll` → `{ status: "error", message }`（可读文案，不含 token） |
| `begin` 网络 / 超时异常 | fetch 抛错、超时 | **抛异常**（真正的意外；与 GitHub 侧可预期错误区分，后者用 `status: "error"` 表达） |
| `getAccount` 时 access token 临近/已过期 | `now >= expiresAt - 5min` 且存在 refresh token | 静默刷新后继续，用户无感；刷新成功后新 token set 落盘 |
| `getAccount` 时 `/user` 返回 401 | `/user` 返回 401 | **先** `refreshAfterRejectedToken` 并重试 `/user` 一次；**只有本次 token 来自真实刷新（`refreshed: true`）且仍 401** 才删除 token set 并返回 `{ connected: false, reason: "reauth_required" }`；复用的是别的 provider 刚写入的 token 时返回 `unverified`，下次调用再走强制刷新判定。**禁止一次 401 就删凭据** |
| 刷新成功 | token 端点返回新 `access_token` | 用新 token；`refresh_token` 若返回则轮换保存，未返回则丢弃旧 refresh token（已作废） |
| 刷新返回 `bad_refresh_token` | refresh token 过期 / 已被轮换 | 先重读凭据库；读数已变且有效 → 复用；仍是本次失败值 → `deleteIf`（compare-and-delete）成功才删除，随后 `{ status: "reauth_required" }` |
| `/user` 返回 401 但响应体不是 GitHub 撤销 | 代理 / 企业网关拦截 | 只有响应体 `message === "Bad credentials"` 才视为授权失效；否则按 `unverified` 处理，**保留凭据** |
| `poll` 响应非法（数组 / 空对象 / 既无 `access_token` 也无 `error`） | GitHub 侧异常响应 | `{ status: "error", message }`，不得落成永久 `pending` |
| 刷新返回其它 `error`（如 `incorrect_client_credentials`） | GitHub 侧配置/协议问题 | 保留凭据，`{ status: "temporarily_unavailable", reason: "configuration" }`，`log.error` 记录错误码（不引导用户重复登录） |
| 刷新网络异常，access token 仍未过期 | fetch 抛错 / 超时 / 非 JSON | 用当前 token 继续（`log.warn`），不阻塞本次操作 |
| 刷新网络异常，但本次是「401 后的强制刷新」 | `/user` 已拒绝该 token | `{ status: "temporarily_unavailable", reason: "network" }`，**不返回被拒的旧 token**（否则调用方重试会再次 401 并误删凭据） |
| 刷新网络异常，access token 已过期 | 同上 | `{ status: "temporarily_unavailable", reason: "network" }`，**保留凭据**；`getAccount` 返回 `{ connected: true, reason: "unverified" }` |
| `signOut` 时删除凭据失败 | 文件被锁 / 只读 | `clearSession` 尝试两个 key 后**抛错**；`signOut` 原样上抛，UI 保持 connected 并提示失败，**不得宣称已退出**。内部自动清理调用方 catch 后 `log.warn` 继续 |
| 本地 `refreshTokenExpiresAt` 已过 | 过期时间判断 | 不发请求，直接 `clearSession()` + `reauth_required` |
| `getAccount` 时网络失败 | `/user` 请求异常 / 非 401 错误 | 保留 token，返回 `{ connected: true, reason: "unverified" }`（`login` 可能缺失，不误删凭据） |

### 文档依据：`device_flow_disabled` 在 poll（token 端点）也可达

GitHub 官方文档 [Authorizing OAuth apps](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
的 Device flow 章节里，紧接「轮询 `POST https://github.com/login/oauth/access_token`」的说明之后，
有一张标题为 **"Error codes for the device flow"** 的表格，其正文明确写「more than one access token request
(`POST https://github.com/login/oauth/access_token`) … you'll hit the rate limit and receive a `slow_down`
error response … see the Error codes for the device flow」，即该表描述的是 **token 端点**的错误码。
表中条目为：`authorization_pending`、`slow_down`、`expired_token`、`unsupported_grant_type`、
`incorrect_client_credentials`、`incorrect_device_code`、`access_denied`、`device_flow_disabled`。
其中 `device_flow_disabled` 的描述为「Device flow has not been enabled in the app's settings.」。

因此 `poll` 的 `device_flow_disabled` **不是死分支**，保留，且与 `begin` 语义相同（都是「OAuth App 未启用
Device Flow」）。附带发现：同表 `slow_down` 描述为「The error response includes the new interval that you
must use.」——GitHub 的 `slow_down` 响应可能自带新 `interval`；本契约仍按「入参 + 5」计算（用户冻结行为），
未采用响应里的 `interval`，如需改用响应值需另议。

### 契约说明（正式契约，非缺口）

- **`begin` 用状态表达 GitHub 侧错误，不抛异常**：OAuth App 忘勾 Enable Device Flow 是最常见的失败路径，
  不该以裸异常冒到 UI。故 `begin` 的 `status` 扩为 `ok | not_configured | device_flow_disabled | error`，
  GitHub 侧可预期问题一律用状态 + `message`（保留错误码）表达。**只有网络 / 超时这类真正的意外才抛异常**，
  由调用方（UI）统一兜底。
- **`poll` 把「上次间隔」作为入参回传**：host 保持无状态（不记 `deviceCode`、不记间隔），但 `slow_down`
  的退避递进成立——`authorization_pending` 保持入参节奏，`slow_down` 在入参基础上 +5，连续 `slow_down`
  即 5 → 10 → 15 递进。若 UI 不回传 `interval`，按默认 5 处理。

## 凭据加密的真实强度（不要写成「安全存储」）

`packages/services/src/credential/providers/credentialCipherProvider.ts` 用 AES-256-GCM 加密凭据 value。
密钥来源：未设置环境变量 `ZCODE_CREDENTIAL_SECRET` 时，由 `sha256("zcode-credential-fallback:${platform}:${homedir}:${username}")`
派生。这意味着：

- 加密**不是**为了抵御本机攻击者：任何能读到同机同用户环境（拿到平台、home、用户名）或读到源码的
  进程都能复现密钥。
- 它的作用是**防误读**：避免凭据以明文出现在配置文件里被随手查看、被截图、被无关日志/工单带出。
- 因此本 spec 与相关文案一律不使用「安全存储 / 钥匙串 / 加密保险箱」等表述。真正的系统钥匙串
  （keytar / safeStorage）不在本次范围，且禁止引入新依赖。

## 验收场景

1. **未配置 client id**：`begin` 返回 `{ status: "not_configured" }`，不发起任何网络请求。
2. **正常登录**：`begin` 返回 `ok` + `deviceCode/userCode/verificationUri/interval/expiresAt`；UI 打开
   `verificationUri`；连续 `poll`（回传上次 `interval`）先得到 `pending`，用户授权后得到 `success` +
   `account`；随后 `getAccount` 返回 `{ connected: true, login, ... }`。
3. **token 落盘**：`success` 后凭据库存在 `github:oauth:token_set`，其中 `accessToken` 即 access token；
   GitHub 返回了 `refresh_token` / `expires_in` 时对应字段一并落盘；旧 key `github:oauth:access_token` 被删除。
4. **slow_down 递进**：缺省调用 `poll` 返回 `interval: 10`；以 `interval: 10` 调用返回 `interval: 15`。
5. **expired / denied / device_flow_disabled**：`poll` 分别映射到 `expired` / `denied` / `device_flow_disabled`。
6. **begin 的 GitHub 侧错误**：`device_flow_disabled` → `{ status: "device_flow_disabled" }`；未知 `error` /
   缺 `device_code` / 非法响应 → `{ status: "error", message }`（含错误码，不抛）。
7. **begin 缺字段**：GitHub 返回 `device_code` 但缺 `user_code` 或 `verification_uri` → `{ status: "error" }`
   （message 点明缺哪个字段），不会返回 `ok`。
8. **begin 网络异常**：抛异常（真正的意外）。
9. **poll 网络异常**：返回 `{ status: "error", message }`，message 可读且不含 token。
10. **退出登录**：`signOut` 后凭据库中 `github:oauth:token_set` 与旧 key 均被删除，`getAccount` 返回
    `{ connected: false }`；删除失败时 `signOut` 抛错，调用方保持已连接并提示失败。
11. **不泄漏 token**：任何返回值、日志都不包含 access token / refresh token；`poll` 的返回体不含
    `access_token` 字段。
12. **已连接但账号名暂不可得**：凭据存在、`/user` 网络失败时 `getAccount` 返回
    `{ connected: true, reason: "unverified" }`（无 `login`），UI 只显示已连接态。
13. **未过期不刷新**：距 `accessTokenExpiresAt` 超过 5 分钟时，`getAccessToken` 不请求 token 端点。
14. **临近过期自动刷新**：进入 5 分钟窗口后，一次刷新请求拿到新 `access_token` + 轮换后的
    `refresh_token`，新 token set 落盘；旧 refresh token 不再被使用。
15. **刷新单飞**：并发两次 `getAccessToken`（或 `getAccount` + gist 同步同时触发）只产生一次刷新请求，
    两者拿到同一个新 access token。
16. **401 软失败**：`/user` 首次 401、刷新成功、重试 200 → `getAccount` 返回 `connected: true` +
    账号信息；凭据**未被删除**。
17. **reauth_required + compare-and-delete**：刷新返回 `bad_refresh_token`、重读仍是本次失败值 →
    `deleteIf` 在文件锁内确认值未变后删除 token set，`getAccount` 返回
    `{ connected: false, reason: "reauth_required" }`；若判断时值已被别的 provider 换成有效新值则不删除。
18. **旧 key 兼容**：只有 `github:oauth:access_token` 时按长期 token 直接可用，不触发刷新；下次登录后
    新 key 出现、旧 key 消失。
19. **刷新网络失败**：access token 未过期 → 本次继续可用；已过期 → `temporarily_unavailable` 且凭据仍在，
    下次可重试。
20. **config-sync 走 provider**：`getStatus()` 只读本地凭据、不发起刷新请求；gist 上传/预览/应用使用
    provider 返回的可用 token。
21. **写盘失败**：刷新后 `saveSession` 抛错时不得吞掉——记录 `error`，本次仍可返回新 token，但必须让
    调用方可观察到失败（日志含 key 名，不含 token）。
22. **刷新请求不带 client secret**：token 端点请求体只有 `client_id` / `grant_type` / `refresh_token`。
23. **登出压过在飞刷新**：刷新请求未返回时调用 `signOut`，刷新结果到达后**不得**写回凭据；
    `getAccount` 返回 `{ connected: false }`。
24. **跨 provider 竞争不误删**：provider A 刷新成功并写入新 token set；provider B 用旧 refresh token 收到
    `bad_refresh_token`，重读看到 A 的新值 → 直接复用，不删除；若 B 的重读发生在 A 写入前，B 的
    `deleteIf` 因值已变而失败 → 同样不删除。
25. **写盘失败同进程继续可用**：刷新成功但 `saveSession` 抛错 → 第一次返回新 token；同进程第二次
    `getAccessToken` 仍返回该 token，**不得**因重读旧 refresh token 触发 `reauth_required`。
26. **代理 401 不误删**：`/user` 返回 401 且响应体不是 `Bad credentials` → `connected: true, reason: "unverified"`，
    凭据保留；只有 GitHub 的 `Bad credentials` 才走撤销判定。
27. **poll 非法响应**：返回数组 / 空对象 / `{message}`（既无 `access_token` 也无 `error`）→
    `{ status: "error", message }`，不停在 `pending`。
28. **signOut 删除失败**：`clearSession` 对两个 key 都尝试删除后抛错；`signOut` 上抛，UI 保持 connected
    且提示失败；内部自动清理路径 catch 后继续，不影响 `reauth_required` 判定。
29. **二次 401 只在真实刷新后清凭据**：`refreshAfterRejectedToken` 复用别的 provider 已写入的 token
    （`refreshed: false`）后仍 401 → `{ connected: true, reason: "unverified" }`，凭据保留；只有
    `refreshed: true` 的 token 仍 401 才清凭据。
30. **temporarily_unavailable 分类**：网络/超时 → `reason: "network"`，config-sync 映射为 `network`；
    GitHub 配置类 error → `reason: "configuration"`，config-sync 映射为 `unknown` 并提示检查配置/重新登录。
31. **测试类型检查**：本次新增/修改的 GitHub 与凭据测试纳入 `packages/services/tsconfig.test.json`，
    由根 `pnpm typecheck` 一起执行；`test/` 全量的 48 个既有类型错误不在本 spec 范围，另行清理。

## 边界

- 本 spec 只冻结 `GithubAuthAccountState.reason` 字段；`packages/ui/**` 的展示改动由 UI 侧按该字段实现。
- 不实现创建/上传私有 gist 的新能力（同步链路只改「取 token」的入口）。
- **不做 gist 请求的 401 自动重试**：刷新已前置到取 token 时；gist 401 仍按 `unauthorized` 返回，
  由用户下次 `getAccount` 触发的刷新/判定处理。避免对上传类操作引入重试语义。
- 不改远端同步地址（仍是硬编码 `MrHan-Yd/23347...` 公开 gist）。
- 不引入 `offline_access` scope；不通过代码开关 OAuth App 的 `Expire user access tokens`
  （那是 GitHub 侧的运维配置，代码必须对「开」和「关」两种配置都正确工作）。
- 不引入 keytar / safeStorage 等新依赖。
- token（access / refresh）绝不写日志；日志只记事件与错误码。
