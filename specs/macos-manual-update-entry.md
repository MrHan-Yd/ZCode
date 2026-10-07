# macOS 更新入口降级为「打开下载页」

## 背景

macOS 上应用内自动更新**在当前发行方式下必然失败**，且失败会让更新弹窗自行消失，用户既点不到按钮也无法完成升级。

证据（真实日志 `~/.zcode/v2/logs/2026-10-07.log`，本地 app 签名状态）：

```
16:48:29.651  [auto-update] downloaded: 3.15.2, ready to install on quit or explicit install
16:48:30.443  [error] Code signature at URL .../ShipIt/update.SMp2ves/ZCode.app/ did not ...
16:48:30.444  [auto-update] error: {"code":-1,"domain":"SQRLCodeSignatureErrorDomain"}
16:48:30.444  [auto-update] cleared ready update after error version=3.15.2
```

- 每次打开更新窗口后 1.7–3.2 秒内必然出现该错误（六次重试无一例外）。
- 本机 app：`Signature=adhoc`、`TeamIdentifier=not set`。macOS 的 Squirrel（ShipIt）会拿「正在运行 app 的 designated requirement」校验新包；ad-hoc 的 requirement 绑定 cdhash，**每个构建都不同**，所以永远无法通过。
- CI 未配置签名（`.github/workflows/release-desktop.yml:41` 仅留注释说明如何补 `APPLE_SIGNING_IDENTITY` / `ZCODE_ENABLE_MAC_SIGN`）。
- `MacUpdater` 把 zip 交给 Electron 原生 `autoUpdater`（ShipIt），校验在原生层；`verifyUpdateCodeSignature` 只存在于 Windows 的 `NsisUpdater`，**macOS 没有可开关**。

失败后的连锁（用户看不到原因地「窗口一闪就没」）：

1. `autoUpdater.ts` 的 post-ready 错误分支调用 `clearReadyUpdateState()`（`isDevSquirrelReadyError` 只在 `!app.isPackaged` 时保留 ready）。
2. 状态离开 `update-downloaded` → `index.ts` 的 `isUpdateStatusWindowCloseLocked` 变 false（窗口解除关闭保护），preload 也清空缓存的 ready 版本。
3. 渲染侧 `UpdateStatusDialogController` 的 `!displayVersion && updateState !== null → onOpenChange(false)` 触发 → `UpdateStatusWindowRoot` 的 `onRequestClose` 调 `window.close()` → 此时窗口已不锁定 → **窗口被销毁**。

## 产品规则

1. **macOS（`isMacDesktop`）上更新弹窗不再提供应用内安装**：`update-available` 态的主按钮由「下载并更新」改为「打开下载页」，`update-downloaded` 态的主按钮由「重启以更新」改为「打开下载页」。点击打开 Release 页面，用户自行下载安装包。
2. **Windows / Linux 行为完全不变**：Windows 未配置 `publisherName`，NSIS 的签名校验被跳过，应用内自动更新可用，主按钮与流程逐字保持原样。
3. **不改主进程更新状态机**：下载、安装、`clearReadyUpdateState`、`quitAndInstall` 等逻辑一行不动；macOS 上只是不再从 UI 触发 `downloadUpdate` / `quitAndInstallUpdate`，因此也不会再产生 ready → error 的自关链路。
4. macOS 上「跳过此版本」（available 态）与「稍后」保持可用 —— 降级的是安装方式，不是整个更新提示。
5. 这是**未签名发行下的诚实降级**：不给用户一个必然失败的按钮。将来若配置签名 + 公证，应移除 macOS 分支以恢复应用内安装。

## 状态所有者

- 更新状态与安装能力仍由 main 的 `autoUpdater` 状态机唯一所有，本次不改。
- 本次只新增一个动作：`openUpdateDownloadPage`（打开 Release 页面），由 main 负责解析地址（复用 `resolveForceUpdateManualUpdateUrl`），渲染侧不持有 URL。
- 平台差异的知识来源仍是既有的 `isMacDesktop` prop（由 `packages/desktop/src/renderer` 传入），不新增平台探测。

## 接口

```ts
// packages/shared/src/channels.ts
PlatformChannels.OpenUpdateDownloadPage: "zcode:open-update-download-page";
// 类型映射：{ request: void; response: void }

// packages/shared/src/platform.ts
interface IPlatformService {
  openUpdateDownloadPage?(): Promise<void>;
}
```

- main 实现：`shell.openExternal(resolveForceUpdateManualUpdateUrl())`（即
  `https://github.com/<owner>/<repo>/releases/latest`）。
- 方法可选：旧版 renderer / 非桌面端拿不到时不渲染该入口。

## 时序

```text
macOS（改动后）
  检查到新版本 → 弹窗「有新版本」[打开下载页] [跳过此版本] [稍后]
        └─ 打开下载页 → 系统浏览器打开 Release 页 → 用户下载 dmg 手动安装
  （不再触发 downloadUpdate / quitAndInstallUpdate，因此不再有 ready → 签名错误 → 自关）

Windows（不改动）
  检查到新版本 → [下载并更新] → 下载完成 → [重启以更新] → quitAndInstall → 安装并重启
```

## 验收

1. macOS：`update-available` 与 `update-downloaded` 态的主按钮为「打开下载页」；点击后系统浏览器打开 Release 页；界面上不出现下载/安装动作。
2. Windows / Linux：主按钮与流程与改动前一致（不受 `isMacDesktop` 分支影响）。
3. macOS 不再出现「弹窗闪一下就没」的链路：不会进入 ready → 签名错误 → 清 ready → 自关。
4. 「跳过此版本」「稍后」在 macOS 上仍可用。
5. `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed` 全绿。

## 已知限制

- 首次安装 dmg 仍会被 Gatekeeper 拦（未签名/未公证），用户需手动放行；本次不解决签名问题。
- macOS 用户不再能「一键更新」，必须走浏览器下载 —— 这是未签名发行的既有代价，不是本次引入的。
- 未做「macOS 上不下载、只提示」之外的状态机改动：若将来发现其他平台也有 post-ready 安装失败，仍会走既有的清 ready 路径（那属于另一个问题）。
