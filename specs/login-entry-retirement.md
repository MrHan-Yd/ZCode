# App 级登录入口下线（Login entry retirement）

## 背景

个人二开版本不使用 z.ai / BigModel 账号，只用自定义供应商（API Key / 自建 Base URL）。但启动链路里
仍有一条「没有账号就先把用户按在登录页」的门禁，实际表现是**每次打开应用都弹出登录页**
（bigmodel / z.ai / 使用 API key 三选一）：

- `Root`（`packages/ui/src/Root.tsx`）把 `useProviderAvailabilityLoginEntryGuard`
  （`packages/ui/src/root/useProviderAvailabilityLoginEntryGuard.ts`）的判定结果写成
  `welcomeScreenOpenReason = "startup-provider-required"`，再由 Root 提前 return，
  用 `WelcomeScreen` 整屏替换工作区 shell。
- 该守卫的判定是 `shouldOpenLoginEntry = !providerFamilyDomain || (!user && !hasUsableProvider)`。
  二开用户不登录，`providerFamilyDomain` 恒为 `null`，所以**即使已经配好可用的自定义供应商，
  也会被强制拉回登录页**。
- 其余自动打开登录页的来源：上次会话 JWT 失效后重启（`consumeZcodeJwtInvalidRestartMarker()` 把初始
  reason 置为 `"session-expired"`）、会话过期广播 / 缓存会话恢复失败
  （`onReauthenticationRequired`）、退出登录后 provider family 被清空
  （`logout-provider-required`）。
- 手动入口：设置页 `onLogin` 透传、命令面板未登录时的「连接 / Connect」项
  （`quickPickCommands.ts` 的 `handlers.login`）。

本次把登录从 **App 级入口** 整体下线：打开应用直接进入工作区，任何自动路径都不再弹出登录页，
命令面板与设置页也不再提供账号登录入口。

## 产品规则

1. 启动不再打开登录页。provider 可用性、是否已登录、`providerFamilyDomain` 都不再决定是否展示
   `WelcomeScreen`；`providerFamilyDomain` 为空不再是登录理由。
2. 上次会话 JWT 失效触发的重启不再以登录页开场。该「重启后回登录页」标记连同模块一起删除。
3. 会话过期（`ZCODE_JWT_INVALID` 广播、缓存会话恢复返回 `reauthentication-required`）只保留告知性弹窗：
   不再打开全屏登录页，广播取消重启分支直接结束。
4. 退出登录不再打开登录页。
5. 命令面板不再有「连接 / Connect」项（登录态下的「断开连接」项保留）。
6. 设置页不再接收 `onLogin`。

## 保留的能力

本次只下线 **UI 入口**，底层数据与运行链路一行没删：

| 保留项                         | 说明                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------- |
| `WelcomeScreen` 组件           | 代码保留，`provider-request` 的打开路径仍在（`Root` 的 `loginEntryRequest` 订阅） |
| `LoginApiKeyForm` / `useOAuth` | 同上，属于用户主动发起的连接流程                                                  |
| OAuth / 账号 Provider 链路     | `oauthService`、`zhipu-account`、计费与购买链路、已登录用户的凭据与设置一律不动   |

**但 `provider-request` 当前没有可达生产者**（静态可达性已确认），所以登录页实际上已经打不开了：

- `requestLoginEntry` 只有两个调用点：`ModelProviderSection.tsx:767`（在 `handleCodingPlanLogin` 内）
  与 `settings/codingPlanUpgradeLoginRecovery.ts:23`（在 `beginCodingPlanUpgradeLogin` 内）。
- `handleCodingPlanLogin` 只经 `ModelProviderSection.tsx:1093` → `Detail.tsx` 的
  `onCodingPlanLogin` 使用，而 `Detail.tsx` 全部 `onLogin` 调用都在
  `selectedNavItem.type === "preset" | "codingPlan" | "teamPlan"` 分支内（`Detail.tsx:681`、`:772`）。
  内置预置入口下线后这些分支不可达（见 [模型设置的供应商入口](./model-settings-provider-entries.md)）。
- `beginCodingPlanUpgradeLogin` 只剩 `CodingPlanUpgradeDialog.tsx:10,19` 的 import 与 re-export，
  没有调用点；该对话框的购买流程已迁进官网 webview（同文件 `onReopen` 注释）。

保留而不删除的原因：账号 Provider / 计费链路的数据与运行代码按
[模型设置的供应商入口](./model-settings-provider-entries.md) 的要求继续保留，删掉 UI 组件会连带拆掉这条链路。
若后续确认这条链路在本二开版本彻底不用，可连同 `WelcomeScreen`、`LoginApiKeyForm`、`useOAuth`、
`loginEntryRequest` 与账号 Provider 一起做第二层清理。

## 状态所有者

- **登录页开关**：`Root` 的 `isProviderLoginEntryOpen`（`boolean`）。唯一打开路径是
  `loginEntryRequest`（`store/index.ts`）的订阅 effect（当前无生产者，见上）；唯一关闭路径是
  `WelcomeScreen.onComplete`。
- 原先的 `welcomeScreenOpenReason` 五种来源（`startup-provider-required` / `manual-login` /
  `provider-request` / `logout-provider-required` / `session-expired`）收敛为
  「设置页发起」这一种，故改成布尔量，避免保留只有一种取值的联合类型。

## 接口变更

删除：

- `useProviderAvailabilityLoginEntryGuard`（`root/useProviderAvailabilityLoginEntryGuard.ts`，整文件）
- `shouldEnableProviderAvailabilityLoginEntryGuard`、`shouldResolveProviderStartupState`、
  `ProviderStartupResolutionState`（`lib/rootStartupGate.ts`）
- `root/zcodeJwtInvalidRestartMarker.ts`（整文件，`mark` / `consume` 都失去唯一消费者）
- `useRootOAuthEffects` 的 `onReauthenticationRequired` 参数
- `applyCachedOAuthSessionRestoreResult` 的 `onReauthenticationRequired` 参数
- `QuickPickCommandIcon` / `QuickPickCommandHandlers` 的 `login`，`AppProps.onLogin`、
  `RootWorkspaceContent` 的 `onLogin`
- 文案 `quickPick.command.login`（zh-CN / en-US）

保留：`isProviderStartupSyncPending`、`shouldBlockRootRender`、`shouldShowRootStartupLoading`、
`shouldOpenFallbackWorkspaceAfterCreate`。

## 启动门禁的事件顺序

```text
启动
  |
  v
isResolvingStartupAuthState = isRestoringOAuthSession
isResolvingProviderStartupState = providerStartupSyncPending
  ( = !providerFamilyDomainMigrationComplete || !modelSelectionViewHydrated )
  |
  v
shouldShowRootStartupLoading(isDesktop && !isProviderLoginEntryOpen && 仍有阻塞)
  |
  v
恢复 tab -> 兜底创建默认 workspace -> 工作区 shell
```

登录页不再出现在这条链上：`isProviderLoginEntryOpen` 在启动阶段恒为 `false`（只有
`loginEntryRequest` 能把它置为 `true`，而该请求当前没有生产者）。

## 验收场景

1. **未登录、无 providerFamilyDomain、已配好自定义供应商**：打开应用直接进入工作区，
   不出现 bigmodel / z.ai / 使用 API key 选择页。
2. **未登录、没有任何可用 provider**：打开应用同样直接进入工作区（不再被登录页拦截）；
   需要模型时由用户在设置页自行添加自定义供应商。
3. **上次会话 JWT 失效后重启**：本次启动不再以登录页开场。
4. **会话过期**：只出现告知弹窗；确认或关闭后都不会打开全屏登录页。
5. **命令面板**（未登录）：命令列表里没有「连接 / Connect」。
6. **设置页**：遍历模型设置左栏（只剩自定义供应商，没有任何套餐/内置项）与升级入口，
   没有任何动作能打开 `WelcomeScreen`（与「保留的能力」里的可达性结论一致）。
7. **退出登录**：不打开登录页；退出后停在当前工作区，不再出现登录页。

## 遗留状态：官方版账号用户装本 fork 会怎样

### 已由代码确认

**同一份数据，原地替换。** 安装包与官方版同 `appId: dev.zcode.app` / `productName: ZCode` /
安装位置（`packages/desktop/scripts/desktop-product-identity.mjs`，发版 workflow 只设
`ZCODE_ENV: production`，没开 Preview 身份），userData（`~/Library/Application Support/ZCode`、
`%APPDATA%\ZCode`、`~/.config/ZCode`）与数据根 `~/.zcode/v2`（`credentials.json`、
`setting.json`、`tasks-index.sqlite`、`sessions/`）都共用
（`packages/desktop/src/main/desktopRuntimeEnv.ts:61-78`、`packages/services/src/paths.ts:34-55`）。
凭据加解密密钥只依赖 OS 用户与 HOME（`credentialCipherProvider.ts:24-38`），
所以官方版写入的密文本 fork 能读、能改、能删——**登录态清理是双向影响的**。

**启动分支**（`packages/services/src/oauth/oauthService.ts:182-269`）。

| 官方残留状态                        | 启动表现                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| 无 active provider / 无缓存 profile | `signed-out`，静默无提示，直接进工作区                                       |
| ZAI 且缺 `zcodejwttoken`            | `signed-out`，静默无提示                                                     |
| BigModel 有 profile 但缺 JWT        | 仍判 `authenticated`，侧栏显示头像/用户名，直到实际请求 401 才降级           |
| JWT 有效                            | `authenticated`，恢复登录态并刷新套餐权益                                    |
| JWT 已过期                          | 清空共享凭据 → 弹「登录已过期」（只有标题 + 确认），**官方版登录态一并失效** |

**不可回退。** 登录入口全部不可达后，账号用户唯一能做的账号动作是「退出登录」
（`WorkspaceSidebarFooter.tsx` 在 `user` 非空时渲染登出项）；退出会写
`providerFamilyDomain: ""` 并清共享凭据，之后无路可回，只能手动改
`~/.zcode/v2/credentials.json` 或换回官方版重新登录。`onProviderFamilyDomainClearedAfterLogout`
已无消费者，退出后停在当前工作区。

**账号 UI 残留。** `providerFamilyDomain` 为 `zai` / `bigmodel` 时不会被主动清除，继续影响
侧栏套餐徽标（`WorkspaceSidebarFooterUsageSummary.tsx`）、闲时任务资格（`useOffPeakEligibility.ts`）、
升级入口（`SessionPane.tsx` / `AutomationsSection.tsx`）与「连接丢失」提示的替代项选择。

### 需要实机验证

- 官方版版本高于 3.15.1 时任务库迁移的前向兼容：`tasksDatabase/migrations.ts` 只认自己认识的
  3 条迁移，既有迁移 checksum 不一致会直接抛错，未知的新迁移会被忽略，没有「数据库比 app 新」的门禁。
- 模型选择器 / 用量摘要里是否仍会列出不可用的内置账号 provider 与模型：
  `shouldShowBuiltinModelProviderForDomain` / `...ForActiveOAuth`
  （`packages/shared/src/model-provider-family.ts:149-168`）在 UI 里已无调用方，即没有统一的隐藏过滤。
- 若外部注入了不同的 `ZCODE_CREDENTIAL_SECRET`，读凭据会走 `clearCorruptOAuthSession`
  （`oauthCredentialRepo.ts:432-447`），表现为静默强制登出 + 派生 provider 清理。
