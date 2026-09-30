# 检查更新源切换为 GitHub Releases

## 背景

桌面端自动更新的更新信息原本来自自建服务端接口：`packages/desktop/src/main/manifestUpdateProvider.ts`
里的自定义 provider 请求 `https://zcode.z.ai/api/v1/releases/electron/manifest`，由服务端按
platform / channel / device_mid 返回一份 YAML。

本次把更新源换成仓库自身的 GitHub 项目 `https://github.com/MrHan-Yd/ZCode`：改用
`electron-updater` 内置的 GitHub provider，直接读 Releases 里的 `latest*.yml` 元数据，
不再依赖 `zcode.z.ai` 的更新接口。

## 产品规则

1. 「检查更新」的所有入口（帮助菜单、托盘、系统菜单、顶部按钮）语义不变，仍然汇总到
   `DesktopCommandIds.CheckForUpdates`；只是更新信息的来源换成 GitHub Releases。
2. 稳定通道读仓库**最新正式 Release** 的 `latest.yml`（Windows/Linux）或 `latest-mac.yml`（macOS）。
   这是 electron-updater GitHub provider 的默认行为（GET `/releases/latest` 拿 tag，再取该 tag 下的
   channel 文件）。
3. preview 通道（`receivePreviewUpdates: true`）允许预发布版本：`channel = "preview"`、
   `allowPrerelease = true`，优先取 `preview.yml` / `preview-mac.yml`，取不到时回退同一 Release 的
   `latest*.yml`。因此发版时不需要额外配置 channel 文件名，按常规流水线产出的 `latest*.yml` 即可。
   electron-updater 按 tag 的预发布标识选版本，preview 版本的 tag 需是 `vX.Y.Z-preview.N` 这类形式，
   否则会被跳过。
4. 只接受更高版本：设置 `channel` 会把 electron-updater 的 `allowDowngrade` 自动置为 `true`，
   必须在同一次调用里显式还原为 `false`。否则仓库里版本更低的 Release 会被当成「可用更新」。
5. 版本说明（release notes）取自 GitHub Release 正文，标题取自 Release 名称；正文是 HTML 还是
   Markdown 取决于发版时怎么填，渲染按现有 Markdown 链路处理。
6. 发版产物必须包含 `latest*.yml` 与 `*.blockmap`：metadatas 缺一个，客户端就会报
   `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND`；blockmap 缺失只影响差分下载，会退化为整包下载。
7. 开发联调入口 `ZCODE_UPDATE_FEED_URL` / `--zcode-update-feed-url` 的语义由「覆盖 manifest 地址」
   改成「改用 generic feed 目录」（该目录需自备 `latest*.yml`）。仍然只在未打包构建生效，
   正式包继续忽略该覆盖。
8. **不在本次范围**：启动强更门禁（`forceUpdateGuard`，读 `zcode.z.ai/api/v1/client/configs`）
   与更新状态弹窗、跳过版本、自动下载安装等既有链路均不变。

## 状态所有者

- **更新通道值**：仍是 `SharedSettings.receivePreviewUpdates`，唯一写入口是 `updateSharedSettings`，
  本次不改。
- **通道到 electron-updater 的映射**：由 `GitHubReleaseUpdateProvider.getLatestVersion()` 在**每次请求内**
  从设置解析后直接写到 updater 实例（`channel` / `allowPrerelease` / `allowDowngrade`）。
  保持「provider 内部按请求读设置」这一既有模型，`packages/desktop/src/main/autoUpdater.ts` 里
  `availableUpdateChannel` / `activeAutoUpdateCheckChannel` / `zcodeReleaseChannel` 的过期结果防护不变：
  provider 仍把本次请求通道随 `UpdateInfo` 带回去，`shouldIgnoreStaleAvailableUpdate` 据此丢弃旧通道结果。
- **更新源坐标**：`packages/desktop/src/main/githubReleaseUpdateProvider.ts` 的
  `GITHUB_UPDATE_REPOSITORY` 是运行时唯一来源；`packages/desktop/electron-builder.config.js` 的
  `publish` 只用于生成 `app-update.yml` 元数据，两处需保持一致。

## 时序

```
启动 / 每小时轮询 / 手动点「检查更新」
  → beginAutoUpdateCheck()（记录 checkId 与 expected channel）
  → GitHubReleaseUpdateProvider.getLatestVersion()
      → 读 SharedSettings.receivePreviewUpdates → stable | preview
      → 写 updater.channel / allowPrerelease / allowDowngrade=false
      → GET https://github.com/MrHan-Yd/ZCode/releases/latest（稳定通道拿 tag）
      → GET /releases.atom（preview 通道按预发布标识选 tag）
      → GET <tag>/latest.yml | latest-mac.yml | preview.yml
      → 返回 UpdateInfo（附 zcodeReleaseChannel）
  → update-available / update-not-available 事件 → 既有状态机
```

## 验收场景

1. 仓库最新正式 Release 带 `latest.yml` / `latest-mac.yml` 时，桌面端「检查更新」能识别到更高版本，
   弹窗显示的版本号、发布日期与版本说明来自该 Release。
2. Release 里只有安装包、没有 `latest*.yml` 时，手动检查以错误收敛（提示找不到更新信息），
   不会卡在 checking。
3. 仓库最新 Release 版本低于当前安装版本时，不会提示「有可用更新」（`allowDowngrade = false`）。
4. `receivePreviewUpdates: true` 且存在 `vX.Y.Z-preview.N` 的预发布 Release 时，
   检查更新走 preview 通道；切回 `false` 后下一次检查回到正式 Release。
5. 未打包构建设置 `ZCODE_UPDATE_FEED_URL` 指向本地目录（含 `latest.yml`）时，更新检查改走该目录；
   打包后的应用设置同样的环境变量被忽略并打 warn。

## 已知限制

- macOS 自动更新走 Squirrel.Mac，需要应用已签名；当前发版流水线是未签名构建，
  macOS 上可能能检查到更新但安装失败。Windows（nsis）不受影响。
- 仓库现状（2026-09-30）：唯一已发布的 Release 是 `v3.14.3`，由旧流水线产出，资产里只有
  `.exe` / `.dmg` / `.zip`，没有 `latest*.yml`；`v3.15.0` 只有 tag、没有 Release。
  必须用更新后的流水线重新发一次带 `latest*.yml` 的 Release，检查更新才能成功。
- 稳定通道固定看「最新正式 Release」，因此当一个预览版构建（如 `3.16.0-preview.1`）版本号已经
  高于正式发布时，稳定通道不会再给出更新；这类构建要继续更新需要打开 `receivePreviewUpdates`。
