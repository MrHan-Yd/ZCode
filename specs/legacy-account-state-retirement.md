# 官方版遗留账号态清理（Legacy account state retirement）

## 背景

[登录入口下线](./login-entry-retirement.md) 之后，本二开版本已经没有任何账号登录入口
（`requestLoginEntry` 没有可达生产者，`WelcomeScreen` 打不开）。但安装包与官方版**共用同一身份与同一份数据**：
同 `appId: dev.zcode.app` / `productName: ZCode`，同 userData，同数据根 `~/.zcode/v2`。
所以从官方版迁移过来的用户会把登录凭据一起带进来，落到一个"入口已下线、状态还在"的错位状态：

- 缓存会话有效时启动会恢复成「已登录」：侧栏显示官方账号的头像与用户名，菜单里还有「断开连接」，
  但登出之后没有任何路径能登回来（`restoreCachedSessionState`，`packages/services/src/oauth/oauthService.ts:182-269`）。
- JWT 过期时启动会清空共享凭据，只弹一个没有动作的「登录已过期」提示。
- 残留的 `providerFamilyDomain`（`zai` / `bigmodel`）会继续驱动侧栏套餐徽标、闲时任务资格、
  升级入口等账号 UI（`WorkspaceSidebarFooterUsageSummary.tsx`、`useOffPeakEligibility.ts`、
  `SessionPane.tsx`、`AutomationsSection.tsx`）。

本变更在启动链路加一层账号态清理，让迁移用户直接落到「用自定义供应商」的干净状态。

## 产品规则

1. 本版本不提供账号登录，因此**不保留任何账号运营态**：只要检测到残留的 OAuth 会话
   （`oauthService.getActiveProvider()` 非空）或非空 `providerFamilyDomain`，启动时就清掉。
2. 清理必须先于账号会话恢复与 provider family 迁移执行，否则恢复会把残留凭据显示成「已登录」、
   迁移会依据残留 active provider 把 `providerFamilyDomain` 重新写回来。
3. 只清账号运营态：任务库、workspace、会话快照、用户自建的自定义供应商一律不动。
4. 清理失败不能阻断启动：记 warn 后继续走正常启动链路。
5. 无残留时不做任何写入（新装用户、以及已经清理过的用户每次启动都不产生副作用）。

## 清理项

| 目标                              | 手段                                                                                                                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OAuth 会话与凭据                  | `services.oauthService.logout()`：清 `oauth:active_provider`、`oauth:{provider}:access_token` / `refresh_token` / `user_info`，并按 `shouldClearZcodeJwtOnLogout` 清共享 `zcodejwttoken`，同时通知派生 Coding/Start provider 清理 |
| provider family 运行域            | `services.settingService.update({ providerFamilyDomain: "", providerFamilyDomainUpdatedAt, providerFamilyDomainMigrated: true })`                                                                                                 |
| Coding Plan 官网 webview 持久存储 | `DesktopCommandIds.ClearCodingPlanWebviewStorage`（Web 端 `executeDesktopCommand` 是 no-op）                                                                                                                                      |

与 `handleLogout`（`packages/ui/src/root/useRootWorkspaceActions.ts:284-357`）保持同一套清理语义，
不额外发明字段：`providerFamilyConnectionSelections` 退出登录时也不清，这里同样保留。

`providerFamilyDomainMigrated: true` 是清理的关键一环：`ensureProviderFamilyDomainMigration`
在 `providerFamilyDomain || providerFamilyDomainMigrated` 时直接返回，所以写入它之后
迁移不会再依据残留 provider 推断并回写 domain。

## 状态所有者与事件顺序

- **清理执行者**：`retireLegacyAccountStateOnce`（`packages/ui/src/root/legacyAccountRetirement.ts`），
  按 services 实例做 WeakMap 记忆，整个应用生命周期内只真正执行一次。
- **触发点**：`Root` 的 provider family domain 迁移 effect 与 `useRootOAuthEffects` 的启动恢复 effect。
  两处都 `await` 同一个 promise，谁先到谁发起，后到的等同一个结果，因此顺序确定、不会重复清理。

```text
启动
  |
  +--> Root: provider family domain 迁移 effect
  |      await retireLegacyAccountStateOnce()   <-- 先到者发起
  |      await ensureProviderFamilyDomainMigration()   (migrated=true -> 直接返回)
  |      setProviderFamilyDomainMigrationComplete(true)
  |
  +--> useRootOAuthEffects: 启动恢复 effect
         await retireLegacyAccountStateOnce()   <-- 复用同一个 promise
         await oauthService.restoreCachedSessionState()   (凭据已清 -> signed-out)
         setIsRestoringOAuthSession(false)
         await refreshProviderState()
```

`retireLegacyAccountStateOnce` 内部：

```text
getActiveProvider() + settingService.get()
  |
  +-- 都为空 -> retired: false，不写入
  |
  +-- 有残留 -> oauthService.logout()
                settingService.update({ providerFamilyDomain: "", ..., Migrated: true })
                executeDesktopCommand(ClearCodingPlanWebviewStorage)
                -> retired: true
```

## 接口变更

新增 `packages/ui/src/root/legacyAccountRetirement.ts`：

- `shouldRetireLegacyAccountState({ activeOAuthProvider, providerFamilyDomain })`：纯判定，便于单测与复核。
- `retireLegacyAccountState({ services, platform })`：执行一次清理并返回结果。
- `retireLegacyAccountStateOnce({ services, platform })`：按 services 记忆的一次性入口，两个启动 consumer 共用。

`LegacyAccountRetirementDeps` / `LegacyAccountRetirementOutcome` 只作为模块内部类型（返回值由调用方推导），
不对外导出，避免扩大公开面。

改动：

- `Root.tsx` 的迁移 effect 在 `ensureProviderFamilyDomainMigration` 之前先清理。
- `useRootOAuthEffects` 的启动恢复 effect 在 `restoreCachedSessionState` 之前先清理。

## 风险与已知取舍

- **会影响官方版**：凭据写在共享的 `~/.zcode/v2/credentials.json`，清理后官方版那边的登录态也会失效。
  这是"共用同一份数据"的必然结果；要两版并存只能换应用身份（本变更不做）。
- **回退官方版后需要重新登录**：清理后官方版需要用户重新登录一次。
- **若将来重新开放账号登录，必须同时删除本模块**：否则每次启动都会把刚登录的凭据清掉。
  代码内已用注释标注这一点。

### 清理后会失去凭据的能力（已核对代码）

这些能力本来就要求账号登录，本版本没有登录入口，所以随清理一并不可用：

| 能力                     | 依据                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话分享的 owner 操作    | `conversationShareHttpClient.ts:404-423` 对 capabilities/preparations/artifacts/confirm 是 `required` 鉴权；token 来自 `node.ts:2433-2440` 的 active provider `zcodeJwtToken ?? accessToken`。公开查看（viewer）是 `optional`，不受影响 |
| 官方 MCP 鉴权            | `official-mcp/officialMcpCredentials.ts:231`                                                                                                                                                                                            |
| 反馈与账号类遥测         | `feedback/feedbackService.ts:77,97`、`node.ts:2719,2726`                                                                                                                                                                                |
| 远控工作区里的账号制模型 | `remoteWorkspaceServiceCollection.ts:84,127-174` 用本机 OAuth 凭据解析账号 Provider 的 API Key                                                                                                                                          |

### 清理不会影响的能力（已核对代码）

- **远控 / 配对链路鉴权与账号凭据无关**：Web 远控用自签 lite token（`packages/server/src/http.ts:227-241`）与
  一次性 host capability（`hostCapability.ts`），Bot 通道用各自的 credentialRef / 绑定码，
  SSH 用原生认证。清理账号凭据不会断链路。
- **Web 客户端自己的登录态独立**：浏览器登录存在 localStorage
  （`packages/web/src/auth/browserOAuthCredentialRepo.ts`），与 host 的 `credentials.json` 无关；
  Web 端 `Root` 清理的是**所连 host** 的账号态。

## 验收场景

1. **官方账号用户（JWT 有效）首次启动 fork**：不显示头像/用户名，菜单无「断开连接」，
   模型设置里只有自定义供应商，`~/.zcode/v2/credentials.json` 中的 OAuth 键已被清。
2. **官方账号用户（JWT 已过期）首次启动 fork**：不再弹「登录已过期」，直接进工作区，
   清理结果与场景 1 一致。
3. **只有残留 `providerFamilyDomain`、没有凭据**：`providerFamilyDomain` 被清空且标记
   `providerFamilyDomainMigrated: true`，重启后 `ensureProviderFamilyDomainMigration` 不会回写。
4. **全新安装 / 已清理过的用户**：不发生任何写入，启动路径与本次变更前一致。
5. **自定义供应商用户**：自定义供应商与其模型选择不受影响（清理只针对账号态）。
6. **清理抛错**（如设置服务不可用）：只记 warn，启动继续，工作区照常打开。
