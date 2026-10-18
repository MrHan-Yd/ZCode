# 模型设置（供应商 / 模型配置）↔ GitHub 私有 Gist 同步（Model provider config sync）

## 背景

设置页「模型设置」的用户配置存在 `{数据存储路径}/.zcode/v2/provider_config.json`：供应商列表
（自定义供应商、内置 Provider 的个人覆盖）、每个供应商的模型成员与调序、模型精确配置规则，以及
默认模型选择。换机器要一个个重建。

本改动复用与子智能体 / MCP **同一套** GitHub 私有 gist 机制（见 `specs/subagent-config-sync.md`、
`specs/mcp-config-sync.md` 与 `packages/services/src/config-sync/` 的共享核心），使用**独立的 gist、
独立的元数据与独立的模块**：三个功能的远端互不干扰。

**核心约束：API Key 不参与同步。** 上传时把 `config.access.apiKey` 从条目内容里剥离；下载时任何策略
都保留本机已有的 API Key。私有 gist 不是加密存储，凭据不进远端。

## 数据流

```
本机（唯一事实源）                                      GitHub（登录账号）
{数据存储路径}/.zcode/v2/provider_config.json   ──上传──▶  私有 gist
  ├─ providerConfigRules.providerRules[].config        ◀─下载──  ├─ manifest.json        (schemaVersion/revision/每文件 sha256)
  │    （access.apiKey 被剥离后才出网）                           ├─ provider.<id>.json   (单个供应商规则，无 apiKey)
  ├─ providerOrder                                              └─ settings.json        (providerOrder + modelConfigRules + defaultModelSelection)
  ├─ modelConfigRules
  └─ defaultModelSelection
{数据存储路径}/.zcode/v2/provider-config-sync.json      本机元数据：gistId / lastRemoteRevision / lastLocalFingerprint
{数据存储路径}/.zcode/v2/provider-config-sync-backup/<ts>/provider_config.json  应用前备份（整份配置文件）
```

## 产品规则

1. **默认不联网**：打开模型设置页只读本机状态与元数据；只有点「上传到 GitHub」「从 GitHub 下载」才出网。
2. **私有 gist**：`public: false`，`description` 固定标记 `zcode-provider-config-sync`。
3. **凭据复用登录账号**：token 从凭据库 key `github:oauth:access_token` 读取（写入方仍是 `GithubAuthService`，
   本改动**只读**）。未登录时上传/下载不发任何网络请求。
4. **API Key 永不出网**：条目内容里的 `config.access.apiKey` 在上传前剥离；`access.type` /
   `apiKeyManagementUrl` 等其余字段照常同步。下载时任何策略都保留本机已有 API Key（见「写入语义」）。
5. **同步范围 = 个人配置层**：只同步 `provider_config.json` 的个人覆盖（`providerRules` / `providerOrder` /
   `modelConfigRules` / `defaultModelSelection`）。**不碰** 内置 Provider 配置、`model-smart-config.json`
   （那是「模型智能配置」自己的同步通道）、以及账号 Provider 的凭据库。
6. **上传即镜像**：远端文件集合 = 本次上传的供应商集合；远端多出来的 `provider.*.json` 在本轮删除。
   本地未变化（内容指纹与 `lastLocalFingerprint` 相同且已有 gistId）时直接返回「无需上传」，不发网络请求。
7. **下载必须两阶段**：先「预览」得到计划（不写任何文件），用户确认后再「应用」。
8. **默认只增不删**：`merge` 保留本地独有供应商（远端覆盖同名），`replace` 才镜像远端并删除本地独有项，
   且必须带二次确认标记。
9. **失败保留本地不变**：网络、校验、大小上限、revision 冲突等失败都发生在首次写盘之前；写盘阶段失败用备份回滚。
10. **疑似密钥只警告**：`api.headers` 等非 apiKey 字段仍可能带凭据，上传前扫描命中时先返回警告
    （只给文件名、行号、规则名，不给命中值），确认后才上传。
11. **不做定时/自动同步**，不做逐条挑选。

## 条目语义

- **条目 = 一个个人 Provider 规则**，名称 = `providerId`，内容是该规则的规范化 JSON：
  `{ providerId, templateId?, providerName?, enabled?, config }`，其中 `config.access.apiKey` 已剥离。
- **额外通道 = `settings.json`**：`{ providerOrder, modelConfigRules, defaultModelSelection }`。
  三个字段始终写出（`providerOrder` 缺省为 `[]`），保证远端布局稳定、manifest 校验一致。
- **文件名映射**：`provider.<encoded-id>.json`。`providerId` 通常是 `[a-z0-9-]`，但内置/账号 Provider 的
  个人覆盖可能是 `account:xxx`（`:` 在 Windows 上非法），因此只对 `% \ / `、`:` 与控制字符做百分号转义，
  再由 manifest 记录 `name ↔ fileName` 保证往返精确。

## 写入语义

- **整份重写个人层**：应用时经 `PersonalProviderConfigRepository.update()` 在文件锁内读-改-写，产出新的
  `ProviderConfigMap` / `ModelConfigRules` / `providerOrder` / `defaultModelSelection`，**不是逐文件写**。
- **merge**：以本机当前个人集合打底，再用**远端全部条目**（含内容未变的）覆盖同名项；本地独有供应商保留。
  `modelConfigRules` 按 `(providerId, modelId)` **覆盖式合并**（`mergePersonalModelRules`）：远端同键胜出、
  本机独有键保留，且同一 Provider/Model 只留下一条规则（跨「智能 / 手动」类型也只留远端那条）。
  刻意**不复用**纯拼接的 `mergeModelConfigRules`——那是为「builtin 层 + modelSmart 层」这种互不相交的层设计的；
  用在个人层上会让每次「下载(merge)」都重复追加远端规则（非幂等、配置文件持续膨胀），
  并可能产出「同一 Provider/Model 既是智能规则又是手动规则」的非法组合，被 `personalModelConfigRulesSchema`
  拒绝后整次写入失败。
  `providerOrder` 取稳定合并（远端顺序在前，本地独有项按本地顺序追加）。
- **replace**：供应商只留**远端全部条目**，本地独有项被删除；`modelConfigRules` / `providerOrder` 整份取远端。
- **API Key 保留（两种策略都适用）**：条目内容不含 `apiKey`，写回时若本机同一 `providerId` 已有同类型
  `api-key` access，则把本机 `apiKey` 补回。否则（远端新增的供应商）`apiKey` 为空，需要用户在新机器上重新填写。
  这是刻意选择：`apiKey` 不属于同步数据，「镜像远端」只镜像同步条目集合，不应顺带清空本机凭据。
- **`defaultModelSelection`**：远端给出时用远端，未给出时保留本机现值（不因下载而清空默认模型选择）。

## 状态所有者

- **个人 Provider 配置**：`PersonalProviderConfigRepository`（`NodePersonalProviderConfigRepository`）独占。
  设置页的增删改（`ProviderSettingsFacade` → `ProviderConfigService`）与同步落地经**同一个
  `repository.update()` 文件锁**串行，不出现「同步写盘期间用户改了一个供应商」的交错。
- **同步元数据与备份**：`{数据存储路径}/.zcode/v2/provider-config-sync.json` 与
  `provider-config-sync-backup/`（数据存储路径 = 设置里的 `dataBaseDir`，由 `getAppConfigDir()` 解析；
  默认即 `~/.zcode/v2`）。`ProviderRuntime` 独占。
- **远端 gist**：本机元数据里的 `gistId` 是权威定位；`description` 标记只在「本机没有 gistId」时用于一次性发现。
- **access token**：`GithubAuthService`（凭据库 `github:oauth:access_token`）。本改动只 `load`，不 `save`/`delete`。

## 接口

`packages/services/src/model-provider/providerConfigSyncModel.ts`（纯逻辑）

- `PROVIDER_CONFIG_GIST_DESCRIPTION`、`PROVIDER_CONFIG_SETTINGS_FILE_NAME`、`PROVIDER_CONFIG_PROFILE`
  （`fileNameFor` / `nameFromFileName` / `isValidContent` / `isValidExtraContent`（校验 `settings.json` 语义）/
  `maxFileBytes` 512KiB / `maxTotalBytes` 8MiB / `extraFileNames: ["settings.json"]`）。
- `encodeProviderName` / `decodeProviderName` / `providerFileName` / `providerNameFromFileName`。
- `stripProviderApiKey(config)`：剥离 `config.access.apiKey`，其余字段原样。
- `providerItemContent(rule)` / `parseProviderItemContent(content)`：条目往返；后者用个人 Provider 规则 schema 校验。
- `serializeProviderSettings(input)` / `parseProviderSettings(content)`：`settings.json` 往返。
- `restoreLocalApiKey(config, localConfig)`：把本机已有 `apiKey` 补回。
- `mergeProviderOrder(local, remote)`：稳定合并供应商顺序。
- `mergePersonalModelRules(local, remote)`：按 `(providerId, modelId)` 覆盖式合并个人精确模型规则
  （幂等；同一 Provider/Model 只留一条，跨智能/手动类型也只留远端那条）。

`packages/services/src/model-provider/providerConfigSync.ts`：`createProviderConfigSync(options)` → `ConfigSyncOperations`。
端口由 `ProviderRuntime` 注入：`readLayer` / `updateLayer` / `userConfigPath` / `dataDir` /
`credentialService` / `fetchImpl` / `enqueueWrite`。

`IProviderSettingsService` 增加 6 个方法（channel 仍是 `provider-settings`），形状与 MCP / 子智能体同步一致：

```ts
getConfigSyncStatus(): Promise<ConfigSyncStatus>;
listConfigSyncBackups(): Promise<ConfigSyncBackupList>;
restoreConfigSyncBackup(params: { backupDir: string }): Promise<ConfigSyncResult<ConfigSyncRestoreResult>>;
syncConfigToGist(params?: { confirmSecretUpload?: boolean }): Promise<ConfigSyncResult<ConfigSyncUploadResult>>;
previewConfigFromGist(): Promise<ConfigSyncResult<ConfigSyncDownloadPlan>>;
applyConfigFromGist(params: {
  strategy: "merge" | "replace";
  expectedRemoteRevision: number;
  confirmReplace?: boolean;
}): Promise<ConfigSyncResult<ConfigSyncDownloadResult>>;
```

## 共享核心

复用 `packages/services/src/config-sync/`（manifest / 指纹 / 计划 / 密钥扫描 / gist 客户端 / 远端定位 /
元数据 / 备份 / 编排），不复制实现。差异只在适配器：条目语义、额外通道、备份对象与整份重写。

为支持本功能，共享核心新增两个**可选**扩展点（缺省行为不变，MCP / 子智能体不受影响）：

- `ConfigSyncProfile.isValidExtraContent?(fileName, content)`：额外通道的语义校验。核心原本只校验额外通道的
  sha256，语义非法要到写盘阶段才暴露、错误码只能退化成 `unknown`；实现它之后在 `parseRemoteFiles`
  即拦下并报 `remote_invalid`。
- `ConfigSyncAdapter.restoreFromBackup?(backupDir)`：用功能自己的写入路径整份还原。缺省仍由核心直接 `cp`
  覆盖目标文件；当功能有唯一写入路径（带锁 / 原子写 / 落盘前校验）时必须实现，否则还原会绕过这些约束。

## 时序

上传：

```
UI ─ syncConfigToGist() ─▶ ProviderRuntime（经 createProviderConfigSync）
                          单飞检查 → busy?
                          load(github:oauth:access_token) → 空 → not_authenticated（不发网络）
                          读个人配置层 → 每个 providerRule 剥 apiKey → 条目 + settings.json
                          指纹相同且已有 gistId → unchanged（不发网络）
                          scanSecrets → 命中且未确认 → secret_warning（不发网络）
                          定位远端（元数据 gistId / description 发现 / 新建）
                          PATCH（revision+1；远端多余 provider.*.json 置 null）或 POST 新建
                          写元数据 → UI toast + 刷新模型设置
```

下载：

```
UI ─ previewConfigFromGist() ─▶ 单飞 → 凭据 → 定位远端 → 校验 manifest / 条目 / settings.json
                                → 与本地个人层 diff → 计划（不写盘）─▶ UI
UI ─ 确认（列出 add/update/localOnly；replace 需勾选）─▶ applyConfigFromGist({strategy, expectedRemoteRevision})
                                → 单飞 → 再 GET 一次远端 → revision 不符 → conflict
                                → 入队：备份 provider_config.json → repository.update() 整份重写个人层（补回本机 apiKey）
                                → 失败尝试回滚 → UI toast + 刷新模型设置与状态行
```

## 备份与还原

与子智能体 / MCP 同步同一套机制（见 `specs/subagent-config-sync.md` 的「备份与还原」），差异只有内容：

- 备份内容是**整份** `provider_config.json`，放在
  `{数据存储路径}/.zcode/v2/provider-config-sync-backup/<时间戳>/provider_config.json`。
- 条目数 = 备份里 `providerConfigRules.providerRules` 的规则个数。
- `listConfigSyncBackups()` / `restoreConfigSyncBackup({ backupDir })` 语义完全一致：只接受已知备份、
  还原前再备份当前状态、整份覆盖需二次确认、不改元数据、参与单飞与写队列。
- **还原也走唯一写入路径**：本功能实现 `restoreFromBackup`，把备份内容 `decodeProviderConfigFile` 解析成
  layer update 后交给 `PersonalProviderConfigRepository.update`，因此具备文件锁、原子写与落盘前整份校验。
  直接 `cp` 备份文件会绕过这三者，且会把「备份内容非法」直接写成生效配置。

## 失败语义

与子智能体 / MCP 共用同一张表（未登录 / 401 / 403 缺权限 / 404 / 网络 / 超时 / 限流 / 远端非法 / 超限 /
本地非法 / revision 冲突 / 重复点击 / 疑似密钥 / 写盘失败回滚）。Provider 侧额外注意：

- `local_invalid` 的 message 是 providerId，`too_large` 同理。
- `not_found` 在下载侧的含义包括「远端还没有上传过配置」，UI 文案已覆盖。
- 远端条目或 `settings.json` 无法解析时按 `remote_invalid` 拒绝，本机个人层零变更（绝不让 `update()`
  写入非法内容：个人配置读取失败会整份降级为空配置，等于丢失全部供应商）。

## UI

- 入口：模型设置页顶部（`ModelProviderSectionLayout` 的 `SettingsResourceHeaderActions`）的溢出菜单，
  与「刷新 / 添加供应商」同一行；仅在 `providerSettingsService` 可用时出现。
- 模型设置页固定消费**本机** Local Host（`SettingsPage` 注入 `localHostServices`），因此不像 MCP 页那样
  需要额外排除远程 workspace。
- 状态行、下载确认弹窗、疑似密钥确认弹窗、还原弹窗**复用** `packages/ui/src/settings/ConfigSyncParts.tsx`
  与 `ConfigSyncDialogs.tsx`；`testid` 为 `model-config-sync-status` / `model-config-sync-go-login` /
  `model-config-sync-confirm` / `model-config-sync-replace-ack` / `model-config-sync-restore-confirm` /
  `model-config-sync-restore-option` / `model-config-sync-secret-warning`，header 动作为
  `model-config-upload` / `model-config-download` / `model-config-restore`。
- 未登录时状态行给「去登录」，经 `SettingsPage` 的 `setActiveSettingsSection("modelSmartConfig")` 跳到
  「同步配置」分区（该分区含 GitHub 账号登录）。
- 同步进行中禁用 header 的上传/下载/还原/刷新。
- API Key 不同步这一点在下载确认弹窗的额外摘要里如实说明。

## 验收场景

1. 未登录点上传：不发任何网络请求，返回 `not_authenticated`，状态行显示未登录引导。
2. 首次上传（含带 `:` 的 `account:` 覆盖）：创建私有 gist，`revision = 1`，文件为 `manifest.json` +
   `provider.<id>.json` + `settings.json`，且**任何文件里都不含 `apiKey`**。
3. 本地未变化再点上传：返回 `unchanged`，**零网络请求**。
4. 本地改一个供应商、删一个再上传：PATCH 同一 gist，`revision = 2`，远端被删的文件传 `null`。
5. merge 下载：远端 A、本地 A(不同)/B → `updated=1, kept=1`，B 保留，且 A 的本机 `apiKey` 仍在。
6. replace 下载：缺 `confirmReplace` 返回错误且本地零变更；带确认后 B 被删除，`removed=1`，
   **未变更的远端供应商仍在**（整份重写必须写远端全集），且共用供应商的本机 `apiKey` 仍被保留。
7. 新机器无元数据：按 description 发现 gist，全量 add，应用后本地出现全部供应商并留下备份目录；
   新供应商的 `apiKey` 为空（需重新填写）。
8. 远端条目非法（schema 不符 / sha256 不符）或 `settings.json` 语义非法（校验和正确）：**预览阶段**即报
   `remote_invalid`，本地零变更。
9. `api.headers` 里含 `ghp_...`：先返回 `secret_warning` 且不含命中值；确认后上传成功。
10. 401：返回 `unauthorized`，凭据未被删除。
11. 应用一次下载后还原：本机 `provider_config.json` 回到下载前（含 apiKey），多出一份安全备份；元数据未改写。
12. 传入任意路径调用还原：被拒绝，本地零变更。
13. 本机有独有模型规则时连续两次 merge 下载：`modelConfigRules` 规则数不增长（幂等），不重复追加远端规则。
14. 本机对某 Provider/Model 存的是手动规则、远端存的是智能规则：merge 下载**成功**且以远端为准，
    不出现「智能 + 手动同键」的非法组合。
15. 备份目录完整但 `provider_config.json` 内容非法：还原被拒绝（返回错误），本地配置保持原样不被写成非法内容。

## 非目标

逐条挑选、多 gist、自动/定时同步、把 API Key 也纳入同步、同步内置 Provider 配置或账号 Provider 凭据、
同步 `model-smart-config.json`（已有独立通道）、改动 `IProviderSettingsService` 既有方法语义。
