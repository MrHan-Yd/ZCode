# 更新通道设置（receivePreviewUpdates）

## 背景

「常规」设置页的桌面更新分组（`packages/ui/src/settingsPageHelpers.tsx` 的 `isDesktop` 分支）
原本有三行：

1. Chrome 硬件加速（`settings.desktopChromiumHardwareAcceleration`）
2. **接受提前收到预览版更新（`settings.receivePreviewUpdates`）**
3. 自动下载并安装更新（`settings.autoDownloadAndInstallUpdates`）

本次删除第 2 行。**设置字段本身保留**：`receivePreviewUpdates` 仍在
`packages/shared/src/validationAppSettings.ts` 里（默认 `false`），桌面端自动更新器仍按它决定
Electron release channel。

## 产品规则

1. 设置页不再提供切换预览版通道的入口，桌面更新分组只剩硬件加速与自动下载安装两行。
2. 自动更新通道仍按已落盘的 `receivePreviewUpdates` 决定：`true` → `preview`，否则 `stable`
   （`packages/desktop/src/main/autoUpdater.ts` 的 `resolveUpdateReleaseChannel`）。通道到 GitHub
   provider 的映射见 `specs/update-source-github.md`。
3. 该字段不再有 UI 写入路径。`packages/desktop/src/main/index.ts` 的
   `syncImmediateAppSettings` 分支保留：如果 `setting.json` 里的值发生变化，main 进程仍会即时刷新
   更新通道（stable → `latest.yml`，preview → `preview.yml`）。也就是说要改通道现在只能改配置文件。
4. 埋点动作 `settings.update` / `toggle_preview_updates` 随入口一起从
   `packages/ui/src/lib/userActionTraceCatalog.ts` 移除；`toggle_auto_update` 保留。

## 状态所有者

- **设置值**：`SharedSettings.receivePreviewUpdates`（`updateSharedSettings` 是唯一写入口，
  现无 UI 调用方）。
- **通道状态**：main 进程的 auto updater，按 `autoUpdater.ts` 读取设置或由
  `syncAppSettings` 推送刷新；渲染进程不保存第二份通道状态。
- 删除行后 `SettingsPage` 不再持有 `receivePreviewUpdates` state，也不再把它传给
  `GeneralSectionContent`（对应的 prop 与 `onReceivePreviewUpdatesChange` 一并删除）。

## 验收场景

1. 桌面端打开「常规」：更新分组只有「Chrome 硬件加速」和「自动下载并安装更新」两行，
   没有「接受提前收到预览版更新」。
2. 其余行（硬件加速、自动下载安装、任务通知、通知声音、关闭窗口时隐藏到托盘、保持电脑运行）
   顺序与开关行为不变。
3. `setting.json` 中 `receivePreviewUpdates: true` 时，自动更新器仍走 preview 通道。
