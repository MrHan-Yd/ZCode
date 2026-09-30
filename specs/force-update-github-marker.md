# 启动强更门禁改用 GitHub Release 标记

## 背景

`packages/desktop/src/main/forceUpdateGuard.ts` 原本在打包版启动前请求
`{zcode endpoint}/api/v1/client/configs?app_version=&platform=`，从返回的 client config 里
取 `forceUpdate.minimalVersion` 决定是否阻止主窗口创建。

本次把判断依据换成 GitHub Release 的标记资产，去掉对 `zcode.z.ai` 的依赖。

## 产品规则

1. 判断依据是仓库**最新正式 Release** 的资产 `force-update.json`，地址为
   `https://github.com/<owner>/<repo>/releases/latest/download/force-update.json`。
2. 该资产沿用 client config 里 `forceUpdate` 段落的结构，复用同一套解析与 semver 比较：

   ```json
   { "forceUpdate": { "minimalVersion": "3.16.0" } }
   ```

3. `minimalVersion` 为空字符串表示不拉闸。拿不到标记（404、超时、离线、非 JSON、响应体过大）
   一律按「读不到标记」处理并放行，只打 warn —— 启动门禁不做 fail-closed。
4. 触发条件不变：仅 `ZCODE_PRODUCT_FLAVOR === "production"` 且 `app.isPackaged` 时检查；
   当前版本 semver 低于 `minimalVersion` 才阻止启动（`resolveForceUpdateRequirement`）。
5. 「手动升级」按钮改为打开 `https://github.com/<owner>/<repo>/releases/latest`，不再按语言区分站点。
6. 请求超时保持 10s，响应体上限收紧到 64KB（标记文件只有一行 JSON）。
7. 标记的**声明**放在仓库根 `force-update.json`（唯一人工编辑点）；发版流水线在 release job 里
   把它复制进 Release 资产，因此标记的投递媒介是 Release，语义仍是「一直声明着」而不是「每次发版
   重新声明」。
8. 仓库坐标唯一来源仍是 `githubReleaseUpdateProvider.ts` 的 `GITHUB_UPDATE_REPOSITORY`，
   标记 URL 与手动升级 URL 都由它拼出。

## 状态所有者

- **标记内容**：仓库根 `force-update.json`。
- **标记投递**：`.github/workflows/release-desktop.yml` 的 release job（`cp` 到 release-assets 后上传）。
- **标记读取与判定**：`packages/desktop/src/main/forceUpdateMarker.ts`（纯函数，无 Electron 依赖）
  - `forceUpdateGuard.ts`（网络请求、弹窗、阻止启动）。
- **窗口门禁状态**：`index.ts` 的 `forceUpdateMainWindowCreationBlocked`，本次不改。

## 时序

```
打包版 production 启动
  → GET /releases/latest/download/force-update.json（10s 超时，64KB 上限）
      404 / 超时 / 解析失败 → warn，「读不到标记」放行
      200 → {"forceUpdate":{"minimalVersion":"..."}}
  → resolveForceUpdateRequirement(currentVersion=ZCODE_VERSION)
      不命中 → 创建主窗口
      命中   → 阻止主窗口 + 强更弹窗（自动升级 / 手动升级=Release 页 / 退出）
```

## 验收场景

1. 最新正式 Release 没有 `force-update.json`：正常启动，无强更弹窗（当前仓库即为此状态）。
2. 资产里 `minimalVersion` 高于当前版本：阻止创建主窗口并弹强更窗，「手动升级」打开 Release 页。
3. `minimalVersion` 低于或等于当前版本：正常启动。
4. 断网、超时或 GitHub 返回 404/5xx：正常启动（fail-open），日志有 warn。
5. `minimalVersion` 为空字符串：正常启动。

## 已知限制

- 门禁只看**最新正式 Release** 的资产：如果新发的 Release 忘了带 `force-update.json`
  （例如不走流水线手工发版），门禁会静默失效，直到下一版补上。
- 预发布 Release 不参与 `releases/latest` 解析，因此预览版用户不会被正式渠道的标记拦下。
- 每次启动都会多一次对 github.com 的请求；失败只影响门禁本身，不影响启动。
