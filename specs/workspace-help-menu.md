# 工作区帮助菜单（Workspace Help Menu）

## 背景

标题栏右侧的 `?` 按钮是一个下拉菜单，入口组件是 `WorkspaceHelpMenuButton`
（`packages/ui/src/WorkspaceHelpMenuButton.tsx`）。同一组件被三处复用：

- 工作区标题栏操作区：`packages/ui/src/WorkspaceHeaderSections/WorkspaceHeaderActionSection.tsx:59`
- 设置页顶部：`packages/ui/src/SettingsPage.tsx:1384`
- 设置页另一处标题栏：`packages/ui/src/SettingsPage.tsx:1582`

本次变更把菜单里的「用户社群」「问题上报」「给产品提需求」三条入口下线，菜单只保留
「产品文档」「资源管理器」「发现新版本 / 重启更新」「关于 ZCode」。

## 产品规则

菜单按平台渲染为两组：

1. **全平台可见**
   - 产品文档：`platform.openExternal(ZCODE_PRODUCT_DOCS_URL)`，经 `createHelpMenuActionHandlers` 的 `openProductDocs`。
2. **仅桌面端可见**（`isDesktop` 为 true 时）：
   - 资源管理器：`DesktopCommandIds.OpenResourceManager`（`data-testid` 为 `TID_WORKSPACE_HELP_MENU_RESOURCE_MANAGER`）。
   - 发现新版本 / 重启更新：由 `useDesktopUpdateMenu(isDesktop)` 决定可见性与文案，点击触发检查更新或重启安装。
   - 关于 ZCode：`DesktopCommandIds.ShowAbout`。

`isDesktop` 由挂载处注入，不在组件内嗅探：Web 端的 `IPlatformService` 桩同样实现了
`executeDesktopCommand`（no-op），靠它判断会让 Web 出现一个点了没反应的「资源管理器」。

菜单触发按钮的 `aria-label` 与 tooltip 文案是 `workspaceHeader.help.menu`，
`data-testid` 为 `TID_WORKSPACE_HELP_MENU_TRIGGER`。

## 已下线的入口

以下三条不再出现在帮助菜单中，**底层能力保留**，其他入口不受影响：

| 下线入口     | 原行为                                                         | 仍然存在的入口                                                                                                                                       |
| ------------ | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户社群     | `platform.openCommunity()`                                     | 命令面板 `quick-pick` 的 `community` 项（依赖 `platform.canOpenCommunity(locale)`）                                                                  |
| 问题上报     | `feedbackStore.openSubmit({ type: "bug", module: "其它", … })` | 命令面板的 `feedback` 项、`ChatErrorBanner`、`TaskListItem`、`WorkspaceHeaderSections` 里的上报入口                                                  |
| 给产品提需求 | `feedbackStore.openFeatureRequest()`                           | 无其他 UI 入口；`feedbackStore.openFeatureRequest` 与 `FeatureRequestDialog` 作为能力保留（`feedbackStore.openSubmit` / `openTickets` 仍是活跃入口） |

因此 `createHelpMenuActionHandlers` 不再返回 `openIssueReport`，帮助菜单也不再订阅
`useFeedbackStore` 的 `openSubmit` / `openFeatureRequest`。

## 状态所有者

- **更新菜单状态**：`useDesktopUpdateMenu`（`packages/ui/src/hooks/useDesktopUpdateMenu.ts`），不在帮助菜单组件里另存一份。
- **反馈弹窗状态**：`feedbackStore`（`packages/ui/src/feedback/feedbackStore.ts`）是唯一所有者，帮助菜单本次不再参与写入。

## 验收场景

1. Web 端打开帮助菜单：只有「产品文档」一条，无分隔线、无桌面项。
2. 桌面端打开帮助菜单：依次为「产品文档」/ 分隔线 /「资源管理器」/「发现新版本」/「关于 ZCode」。
3. 桌面端 `updateMenu.visible` 为 false 时，不渲染更新项，其余项顺序不变。
4. 菜单中不存在「用户社群」「问题上报」「给产品提需求」三项，任何平台、任何入口复用点（标题栏、设置页）都一致。
