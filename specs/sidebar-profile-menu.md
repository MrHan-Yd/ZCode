# 侧栏账户菜单（Workspace Sidebar Profile Menu）

## 背景

工作区侧栏底部的头像按钮是一个下拉菜单，入口组件是 `WorkspaceSidebarFooter`
（`packages/ui/src/WorkspaceSidebarFooter.tsx`），菜单内容由两部分拼成：

- 偏好项（语言 / 主题 / 界面模式 / 桌面缩放）直接写在 footer 内。
- 用量项（使用统计 / 升级）由 `WorkspaceSidebarFooterUsageSummaryContent`
  （`packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx`）渲染。

同一组件被两处挂载，菜单也因此有两份：

- 工作区侧栏：`packages/ui/src/WorkspaceSidebar.tsx:1645`
- 设置页侧栏：`packages/ui/src/SettingsPage.tsx:1490`

本次变更面向个人二开版本：账户菜单不再承担「升级」与「连接使用」两个入口，
把菜单收敛为偏好 + 使用统计 + 退出登录。账号连接能力本身保留——设置页的
provider OAuth 入口、WelcomeScreen 与命令面板仍能发起登录（见下方「已下线的入口」）。

## 产品规则

变更后的菜单分组固定为：

1. **偏好**：界面语言、界面主题、界面模式；桌面端（`isDesktop`）额外有界面缩放子菜单。
2. **用量**：分隔线 + 使用统计（`setPendingSettingsUsageIntent()` + `onUsageClick`）。
3. **登录态相关**：仅 `onLogout` 存在时渲染分隔线 + 退出登录。

`onLogin` 不再参与菜单渲染，未登录时菜单结尾不再出现任何登录项。

触发按钮本身保留，因为它只是偏好菜单的入口（`data-testid` 为 `TID_LOGIN_TRIGGER`，
取值仍是 `login-trigger`，命名与字符串为兼容既有 E2E 保留），但两种情况分别渲染：

- **未登录**（个人二开版本的常态）：不渲染头像与用户名，改为偏好图标
  （`SlidersHorizontal`）+ 菜单名 `sidebar.profile.menuLabel`（偏好 / Preferences），
  `aria-label` 同用菜单名。账号观感会让人以为还要登录，因此不再出现「头像 + 姓名」。
- **已登录**：保持原有「头像 + 显示名/用户名 + 套餐徽标」不变。
- **登录态未落定**（`isRestoringOAuthSession` 且无 user）：图标位换成 loading，表达"状态确认中"。

因此 `sidebar.profile.notLoggedIn`（“连接使用”/“Connect”）与失去消费者的
`app.login` 两条文案一并删除，新增 `sidebar.profile.menuLabel`。

## 已下线的入口

| 下线入口 | 原行为                                                                                            | 仍然存在的等价能力                                                                                                                                                                  |
| -------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 升级     | `WorkspaceSidebarFooterUsageSummaryContent` 的升级项 → `onUpgradeClick` → `openCodingPlanUpgrade` | 设置页模型提供商分区（`settings/model-provider-section/Detail.tsx`）、`AutomationsSection`、V4 工具栏与 `SessionPane` 的升级入口，以及 `CodingPlanUpgradeDialogProvider` 本身都保留 |
| 连接使用 | footer 的 `app.login` 菜单项 → `WorkspaceSidebarFooter.onLogin` → `Root.handleOpenLoginEntry`     | 命令面板（仅未登录时出现）的 `login` 项、`WelcomeScreen` 引导流程保留；`Root.handleOpenLoginEntry` 仍经 `RootWorkspaceContent` → `App.onLogin` 传给命令面板                         |

因此 `onUpgradeClick` / `onLogin` 不再穿透 `WorkspaceSidebarFooter`、
`WorkspaceSidebarFooterUsageSummary*`、`WorkspaceSidebar`、`SettingsPage`、
`WorkspaceSettingsLayer` 与 `WorkspaceShellLayout`；`Root`、`App` 与
`RootWorkspaceContent` 之间的 `onLogin` 因为命令面板仍在用而保留。

## 状态所有者

- **用量/套餐徽标状态**：`useWorkspaceSidebarFooterUsageSummaryState`，头像徽标仍由它驱动，
  本次只删除与升级目标 provider 相关的派生值（`upgradeTargetProviderId`）。
- **升级弹窗状态**：`CodingPlanUpgradeDialogProvider`，本次不改动，只从账户菜单断开一个触发点。
- **登录态**：`Root`（`handleOpenLoginEntry` → `setWelcomeScreenOpenReason`）与 auth store，
  本次不改动。

## 验收场景

1. 未登录时侧栏底部入口显示偏好图标 + 「偏好」（不显示头像、用户名或「连接使用」），
   点击后菜单依次为 界面语言 / 界面主题 / 界面模式 / （桌面端）界面缩放 / 分隔线 / 使用统计，
   没有「升级」「连接使用」，结尾没有多余分隔线。
2. 登录后打开同一菜单：在「使用统计」之后多出 分隔线 / 退出登录，其余顺序不变。
3. 设置页侧栏头像菜单与工作区侧栏完全一致（同一组件、同一解析结果）。
4. 设置页的套餐升级入口（模型提供商分区、自动化分区）与 `CodingPlanUpgradeDialog` 仍可正常打开。
5. 命令面板在未登录时仍能通过「登录」项打开 WelcomeScreen。
