# GitHub 账号授权（GitHub account auth，Device Flow）

## 背景

设置页「同步配置」需要让用户用 GitHub 账号登录，后续用于创建/上传私有 gist 等能力。本改动只交付
**授权与账号查询**：发起设备码授权、轮询换 token、把 token 存进仓库既有加密凭据库、查询当前账号、
退出登录。创建/上传私有 gist 属于后续改动，本次不实现。

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
- **scope**：`gist read:user`（`gist` 供后续创建私有 gist，`read:user` 供显示登录账号）。
- **凭据 key**：`github:oauth:access_token`（唯一持久化凭据；access token 明文只存在 host 侧）。
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
  getAccount(): Promise<{ connected: boolean; login?: string; name?: string; avatarUrl?: string }>;
  signOut(): Promise<void>;
}
```

Channel：`github-auth`（`ServiceChannels.GithubAuth`）。

`begin` 用**判别联合**：`ok` 时 `deviceCode/userCode/verificationUri/interval/expiresAt` 全部必填，
类型层面堵掉「ok 却没有设备码 → 消费者永久空转」的洞。GitHub 返回了 `device_code` 但缺
`user_code` / `verification_uri` 时落到 `status: "error"`（message 点明缺哪个字段），**不硬凑空串**。
`poll` 的形状保持可选字段不动（`account` 可能缺、`message` 仅 error、`interval` 仅 pending 是真实可选）。

## 状态所有者

- **access token**：唯一所有者是 host 侧 `GithubAuthService`，经 `ICredentialService`（AES-256-GCM
  加密）持久化到 `credentials.json`，key 为 `github:oauth:access_token`。
  - UI 只读状态、只发命令（`begin/poll/getAccount/signOut`），**不缓存 token 明文**，也拿不到 token。
  - 除本服务外没有第二个写入方；`signOut` 是唯一的删除入口。
- **设备码中间态**：**无状态**。host 不保存 `deviceCode`、不保存轮询会话、不做定时器；`pollDeviceAuth`
  每次都是独立请求，`deviceCode` 由 UI 透传。为了让 `slow_down` 能真正退避递进，UI 把**上次使用的
  `interval`** 作为入参回传，host 据此计算新间隔（缺省按 5 处理）。「上次间隔」是 UI 侧事实，host 不落任何状态。
- **账号展示信息（login/name/avatarUrl）**：不单独持久化，`getAccount` / `poll` 成功时按需调用
  `GET https://api.github.com/user` 现取。唯一持久化事实仍是 access token。
  - **`connected: true` 时 `login` 可能缺失**：token 存在但 `GET /user` 因网络/非 401 失败时，返回
    `{ connected: true }` 而不带账号字段。UI 此时只显示「已连接」态，不显示账号名；待下次 `getAccount`
    成功后再补全。UI 不得把「无 login」等同于「未连接」。

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
 │ pollDeviceAuth({deviceCode,interval:10}) ─▶ ... ◀── {access_token, scope}
 │                         │ save("github:oauth:access_token", token)   ← 加密落盘
 │                         │ GET https://api.github.com/user (Bearer token)
 │ ◀── {status:"success", account:{login,name?,avatarUrl?}}
 │
 │ getAccount() ──────────▶ load("github:oauth:access_token") → GET /user
 │ ◀── {connected:true, login, ...}
 │ signOut() ─────────────▶ delete("github:oauth:access_token")
```

事件顺序要点：
1. `begin` 只拿设备码，不落任何状态。
2. `poll` 由 UI 回传入参 `interval`；host 无状态，`slow_down` 在入参基础上 +5 实现递进。
3. `poll` 成功时**先落 token 再拉账号**：token 是持久事实，`GET /user` 是展示增强，后者失败不影响登录成功。
4. `getAccount` 的读取永远以凭据库为准，不信任 UI 侧缓存。

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
| `getAccount` 时 token 失效（HTTP 401） | `/user` 返回 401 | 清理凭据，返回 `{ connected: false }` |
| `getAccount` 时网络失败 | `/user` 请求异常 / 非 401 错误 | 保留 token，返回 `{ connected: true }`（`login` 可能缺失，不误删凭据） |

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
3. **token 落盘**：`success` 后凭据库存在 `github:oauth:access_token`，值即 access token。
4. **slow_down 递进**：缺省调用 `poll` 返回 `interval: 10`；以 `interval: 10` 调用返回 `interval: 15`。
5. **expired / denied / device_flow_disabled**：`poll` 分别映射到 `expired` / `denied` / `device_flow_disabled`。
6. **begin 的 GitHub 侧错误**：`device_flow_disabled` → `{ status: "device_flow_disabled" }`；未知 `error` /
   缺 `device_code` / 非法响应 → `{ status: "error", message }`（含错误码，不抛）。
7. **begin 缺字段**：GitHub 返回 `device_code` 但缺 `user_code` 或 `verification_uri` → `{ status: "error" }`
   （message 点明缺哪个字段），不会返回 `ok`。
8. **begin 网络异常**：抛异常（真正的意外）。
9. **poll 网络异常**：返回 `{ status: "error", message }`，message 可读且不含 token。
10. **退出登录**：`signOut` 后凭据库中 `github:oauth:access_token` 被删除，`getAccount` 返回
    `{ connected: false }`。
11. **不泄漏 token**：任何返回值、日志都不包含 access token；`poll` 的返回体不含 `access_token` 字段。
12. **已连接但账号名暂不可得**：token 存在、`/user` 网络失败时 `getAccount` 返回 `{ connected: true }`
    （无 `login`），UI 只显示已连接态。

## 边界

- 不改 UI（`packages/ui/**` 由另一路负责）。
- 不实现创建/上传私有 gist。
- 不改远端同步地址（仍是硬编码 `MrHan-Yd/23347...` 公开 gist）。
- 不引入 keytar / safeStorage 等新依赖。
- token 绝不写日志；日志只记事件与错误码。
