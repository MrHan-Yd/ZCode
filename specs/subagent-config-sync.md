# 子智能体配置 ↔ GitHub 私有 Gist 同步（Subagent config sync）

## 背景

设置页「子智能体」目前只能在本机维护（`{storageRoot}/agents/*.md` + `{storageRoot}/v2/agents-state.json`），
换台机器就得手工搬。设置页「同步配置」已经能登录 GitHub 账号（`specs/github-account-auth.md`，scope
`gist read:user`），并明确把「创建/上传私有 gist」留给后续改动——本改动就是那个后续改动：**子智能体配置
上传到当前登录账号的私有 gist，并可从远端下载同步回本地**。

**与模型智能配置完全分开**：后者用固定公开 gist 分发内置规则（`specs/model-smart-config-sync.md`），
本改动用登录账号下的私有 gist、独立的元数据文件与独立的模块，两者不共享 gist、不共享元数据、不共享代码路径。

## 数据流

```
本机（唯一事实源）                          GitHub（登录账号）
{storageRoot}/agents/*.md            ──上传──▶  私有 gist
{storageRoot}/v2/agents-state.json   ◀─下载──   ├─ manifest.json   (schemaVersion/revision/每文件 sha256)
                                               ├─ agent.<name>.md  (与本地文件同内容)
                                               └─ state.json       (精选子集)
{storageRoot}/v2/subagents-config-sync.json   本机元数据：gistId / lastRemoteRevision / lastLocalFingerprint
```

## 产品规则

1. **默认不联网**：打开设置页只读本机状态与元数据；只有点「上传到 GitHub」「从 GitHub 下载」才出网。
2. **私有 gist**：上传创建 `public: false` 的 gist，`description` 固定标记 `zcode-subagents-config-sync`；
   gist 的读写只用登录账号的 access token。
3. **凭据复用登录账号**：token 从凭据库 key `github:oauth:access_token` 读取（写入方仍是
   `GithubAuthService`，本改动**只读**）。未登录时上传/下载不发任何网络请求。
4. **上传即镜像**：上传后远端文件集合 = 本地 depth-0 文件集合；远端多出来的 `agent.*.md` 在本次上传里删除，
   避免 gist 累积已删除的 agent。本地未变化（内容指纹与 `lastLocalFingerprint` 相同且已有 gistId）时
   直接返回「无需上传」，不发网络请求。
5. **下载必须两阶段**：先「预览」得到计划（不写任何文件），用户确认后再「应用」。不存在无确认的写入路径。
6. **默认只增不删**：`merge` 只覆盖远端存在的同名 agent，本地独有的 agent 保留；`replace` 才镜像远端并删除
   本地独有项，且必须带二次确认标记。
7. **失败保留本地不变**：网络、校验、大小上限、revision 冲突等一切失败都发生在首次写盘之前，本地零变更；
   写盘阶段失败尝试用备份回滚。
8. **疑似密钥只警告**：上传前扫描待上传内容，命中常见密钥形态时先返回警告（只给文件名、行号、规则名，
   不给命中值），用户确认后才真正上传。私有 gist **不是加密存储**，文案必须如实。
9. **不做定时/自动同步**，不做逐条挑选，不同步工作区级配置。

## 同步范围

纳入：

- `{storageRoot}/agents/` **根目录**下的 `*.md` / `*.markdown`（与 `createAgent` 的落盘位置一致）。
- `agents-state.json` 的精选子集：`disabledAgentIds`、`builtInModelSelectionOverrides`、
  `pluginAgentModelSelectionOverrides`。

排除（在计划里显式报出，不静默丢弃）：

- 子目录里的 agent 文件：`SubagentConfigSyncStatus.skippedNested` 列出相对路径，UI 显示跳过数量。
- 工作区级 `<workspace>/.zcode/agents/*.md`：它是仓库内文件、已随 git 版本化，跨机路径不同。
- `agents-state.json` 的 `builtInModelOverrides` / `builtInThoughtLevelOverrides`：服务端注释已禁止从这两个
  字段恢复覆盖，带上会把废弃语义重新注入远端。

agent 的身份 = **文件名去掉扩展名**（`agent.<basename>.md` ↔ `{agentsRoot}/<basename>.md`），不依赖 frontmatter。
上传前每个本地文件都必须能被 `parseSubagentMarkdown` 解析，否则 `local_invalid`（带文件名）；下载时同样校验
远端 md 可解析，否则 `remote_invalid`。

## 远端布局

`manifest.json`（gist 内）：

```json
{
  "schemaVersion": 1,
  "revision": 3,
  "updatedAt": "2026-10-17T09:30:00.000Z",
  "agents": [
    { "name": "code-reviewer", "fileName": "agent.code-reviewer.md", "sha256": "…", "bytes": 812 }
  ],
  "state": { "fileName": "state.json", "sha256": "…" }
}
```

- `schemaVersion` 只接受 `1`；更高版本 → `remote_invalid`（提示升级客户端），不写入。
- `revision` 每次上传 +1；下载时用作 stale 防护。
- `state.json` 只含三个精选字段（`disabledAgentIds` / `builtInModelSelectionOverrides` /
  `pluginAgentModelSelectionOverrides`）。
- 文件名扁平化（无路径语义），gist 内不出现子目录。

**上传请求体按 gist API 契约构造**（`POST /gists` / `PATCH /gists/{id}` 的 `files` 字段）：

```json
{
  "description": "zcode-subagents-config-sync",
  "public": false,
  "files": {
    "manifest.json": { "content": "{…}" },
    "agent.code-reviewer.md": { "content": "---\nname: code-reviewer\n" },
    "state.json": { "content": "{…}" }
  }
}
```

每个文件的值必须是**带 `content` 字符串的对象**；本轮要删除的远端文件传 `null`（仅 `PATCH` 有意义）。
裸字符串、缺 `content` 或带多余键都会被 GitHub 以 **422** 拒绝。`buildRemoteFiles` 的返回值**就是**这份
请求体（含 `null` 删除标记），`gistClient` 原样透传，不再做二次转换；下载侧读的是**响应**形状
（`{ content, truncated, … }`），与请求形状不同，两者不要混用。

## 状态所有者

- **access token**：`GithubAuthService`（凭据库 `github:oauth:access_token`）。本改动只 `load`，不 `save`、
  不 `delete`；401 也不删凭据。token 明文只存在于 host 侧函数栈内，不进 RPC 返回值、不进日志。
- **`agents/*.md` 与 `agents-state.json`**：`SubagentsService` 独占。同步不是第二个所有者，而是它的一个内部
  代码路径，写盘一律经同一个 `writeQueue`。
- **同步元数据与备份**：`{数据存储路径}/.zcode/v2/` 下的 `subagents-config-sync.json` 与
  `subagents-config-sync-backup/`（数据存储路径 = 设置里配置的 `dataBaseDir`，由 `getAppConfigDir()` 解析；
  默认设置下即 `~/.zcode/v2`）。`SubagentsService` 独占，元数据原子写。
- **远端 gist**：本机元数据里的 `gistId` 是权威定位；`description` 标记只在「本机没有 gistId」时用于一次性发现。

## 接口

本功能**复用** `packages/services/src/config-sync/` 的共享核心（远端 manifest、指纹、计划、密钥扫描、
gist 客户端、远端定位、元数据、备份回滚、编排），MCP 配置同步（`specs/mcp-config-sync.md`）用的是同一套；
两个功能各自的 gist、元数据文件与适配器互不影响。核心不感知业务语义，业务语义由适配器描述：

- `packages/services/src/subagents/subagentConfigSyncModel.ts`（纯逻辑）：`SUBAGENT_CONFIG_PROFILE`
  （`agent.<name>.md` 文件名映射、md 可加载性判定）、`pickCuratedState` / `serializeCuratedState` /
  `parseRemoteState` / `mergeCuratedState` / `diffCuratedState` / `isCuratedStateEqual`（`agents-state.json`
  的三个精选字段）。
- `packages/services/src/subagents/subagentConfigSyncStorage.ts`：agents 根目录快照、元数据与备份路径。
- `packages/services/src/subagents/subagentConfigSync.ts`：`createSubagentConfigSync(options)` 把上述语义
  包成 `ConfigSyncAdapter`，交给 `createConfigSync` 编排（`getStatus` / `upload` / `preview` / `apply`）。

契约类型是通用的 `ConfigSync*`（`ConfigSyncStatus` / `ConfigSyncUploadResult` / `ConfigSyncDownloadPlan` /
`ConfigSyncDownloadResult` / `ConfigSyncError` / `ConfigSyncResult<T>`），从 `@zcode/services` 导出；
子智能体额外有一个 `SubagentConfigDownloadPlan = ConfigSyncDownloadPlan & { stateChange }`，
其中 `stateChange` 是启用状态与模型覆盖的变更摘要（下载弹窗会显示变更项数）。

请求统一带 `authorization: Bearer <token>`、`accept: application/vnd.github+json`、
`x-github-api-version: 2022-11-28`、`AbortSignal.timeout(20_000)`。

`packages/services/src/subagents/subagents.ts`：`ISubagentsService` 增加 4 个方法（channel 仍是 `subagents`）

```ts
getConfigSyncStatus(): Promise<SubagentConfigSyncStatus>;
syncConfigToGist(): Promise<SubagentConfigSyncResult<SubagentConfigUploadResult>>;
previewConfigFromGist(): Promise<SubagentConfigSyncResult<SubagentConfigDownloadPlan>>;
applyConfigFromGist(params: {
  strategy: "merge" | "replace";
  expectedRemoteRevision: number;
  confirmReplace?: boolean;
}): Promise<SubagentConfigSyncResult<SubagentConfigDownloadResult>>;
listConfigSyncBackups(): Promise<ConfigSyncBackupList>;
restoreConfigSyncBackup(params: {
  backupDir: string;
}): Promise<ConfigSyncResult<ConfigSyncRestoreResult>>;
```

## 时序

上传：

```
UI ─ syncConfigToGist() ─▶ SubagentsService
                          单飞检查 → busy?
                          load(github:oauth:access_token) → 空 → not_authenticated（不发网络）
                          读本地快照（含 skippedNested）+ 校验可解析 → local_invalid?
                          指纹相同且已有 gistId → unchanged（不发网络）
                          scanSecrets → 命中且未确认 → secret_warning（不发网络）
                          读元数据 gistId；无则 GET /gists 发现；仍无则本次 POST /gists 新建
                          GET /gists/{id} 取当前 revision 与文件集合
                          PATCH（revision+1；远端多余 agent.*.md 置 null）
                          写元数据（gistId / revision / 指纹 / 时间）
                          ─▶ UI：toast + 刷新列表与 mention store
```

下载：

```
UI ─ previewConfigFromGist() ─▶ 单飞 → 凭据 → gistId/发现 → GET /gists/{id}
                                → 校验 manifest/state/md（sha256、大小、可解析）→ remote_invalid?
                                → 与本地快照 diff → 计划（不写盘）─▶ UI
UI ─ 确认（列出 add/update/localOnly；replace 需勾选）─▶ applyConfigFromGist({strategy, expectedRemoteRevision})
                                → 单飞 → 再 GET 一次远端
                                → revision ≠ expectedRemoteRevision → conflict（本地零变更）
                                → 入队：备份 → 写 md（原子写）→ replace 时删 localOnly
                                       → 写 agents-state.json（merge 并集 / replace 整份）
                                       → 写元数据
                                → 任一步失败尝试回滚 → ─▶ UI：toast + 刷新
```

要点：`preview` 与 `apply` 各自读一次远端，`expectedRemoteRevision` 是两者之间唯一的 stale 防护；apply 在队列
内**重新计算**计划（本地可能在预览后又被改过），所以写入内容永远来自最新本地状态；state 与 md 在同一个队列
任务内完成，不出现「md 已换、state 未换」的中间态。

## 备份与还原

- **备份时机**：每次「应用下载」写盘之前。备份内容是**整份** `{storageRoot}/agents/` 目录 +
  `agents-state.json`，放在 `{数据存储路径}/.zcode/v2/subagents-config-sync-backup/<时间戳>/`。
- **保留策略**：最多保留最近 10 份，且丢弃超过 30 天的；只列**包含全部声明条目**的备份
  （内容不全的备份既不展示、也不接受为还原源）。
- **自动回滚**：写盘中途失败时用本次备份整份恢复；备份本身失败则中止本次应用、不动本地。
- **主动还原**：`listConfigSyncBackups()` 列出可用备份（新的在前，含备份根目录、时间、条目数），
  `restoreConfigSyncBackup({ backupDir })` 整份覆盖本地配置。
  - `backupDir` 必须来自 `listConfigSyncBackups()`，任意路径一律拒绝（防止把任意目录当备份拷到本地配置上）。
  - 还原前**先给当前状态再做一份安全备份**，选错可以再还原回来（返回值里带 `safetyBackupDir`）。
  - 还原是整份覆盖、不是合并，UI 必须二次确认。
  - 还原**不改同步元数据**：还原后本地与上次同步不一致，状态行会如实显示「本地有未上传的修改」。
  - 还原参与单飞（进行中返回 `busy`）并在同一个写队列内执行。

## 失败语义

| 场景             | 触发                                            | 返回                                                                          | 本地后果              |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------------------------- | --------------------- |
| 未登录           | 凭据库无 token                                  | `not_authenticated`                                                           | 不变，无网络请求      |
| token 失效       | HTTP 401                                        | `unauthorized`（**不删凭据**）                                                | 不变                  |
| 缺 gist 权限     | HTTP 403（非限流）                              | `insufficient_scope`（message 带 `x-accepted-oauth-scopes`）                  | 不变                  |
| gist 已删/无权限 | HTTP 404                                        | 上传：清元数据 gistId 后自动新建一次，仍失败 → `not_found`；下载：`not_found` | 不变                  |
| 网络/代理失败    | fetch 抛错                                      | `network`，message 带 cause 链 `code`                                         | 不变                  |
| 超时             | 20s                                             | `timeout`                                                                     | 不变                  |
| 限流             | 403/429 且 `x-ratelimit-remaining: 0`           | `rate_limited`，message 带 `retry-after`                                      | 不变                  |
| 请求体被拒绝     | HTTP 422 等未映射状态码                         | `unknown`，message 带 GitHub 的校验摘要（只取 `message` 首行与 `errors` 的 `field`/`code`） | 不变                  |
| 远端格式非法     | manifest/state/md 校验失败、`schemaVersion ≠ 1` | `remote_invalid`                                                              | 不变                  |
| 超大小上限       | 单文件 > 512KiB 或总量 > 8MiB                   | `too_large`                                                                   | 不变                  |
| 本地文件不可解析 | 上传快照                                        | `local_invalid`（带文件名）                                                   | 不变，无网络请求      |
| 计划过期         | apply 时 revision ≠ 预期                        | `conflict`                                                                    | 不变                  |
| 重复点击         | 单飞命中                                        | `busy`                                                                        | 不变（UI 已禁用按钮） |
| 疑似密钥         | 扫描命中且未确认                                | `secret_warning` + `secretWarnings`                                           | 不变，无网络请求      |
| 写盘失败         | 备份后第 N 个文件失败                           | `unknown`，尝试回滚；回滚失败在 message 里给出备份目录                        | 尽量恢复备份          |

## 安全与日志

- 私有 gist **不是加密存储**（GitHub 服务端可见、secret scanning 可读），UI 文案不得写「安全存储」。
- 密钥扫描只报告 `{ 文件名, 行号, 规则名 }`，命中值不进返回值、不进日志。
- GitHub 错误摘要走白名单：只取顶层 `message` 首行（截断）与 `errors[].field` / `errors[].code`，
  **不取** `errors[].message`，也不回显响应体原文——避免把待上传内容带进 message 与日志。
- 日志用 `createServiceLogger("subagentConfigSync")`：`info` 记上传/下载成功（agent 数、revision、gistId 前 8 位），
  `warn` 记错误码，`debug` 记 HTTP 状态；**禁止**记录 md/state 内容、token、完整 gistId。

## UI

- 入口：`SubagentsSection` 用户级分组 header 的 `SettingsResourceHeaderActions` 溢出菜单里新增
  「上传到 GitHub」「从 GitHub 下载」（与本地「导入 / 导出」用分隔线分开）。仅当 `activeScope === "user"`
  且宿主支持用户级目录（`capability.userScopeAvailable`）时才出现。
- 状态行、下载确认弹窗与密钥确认弹窗复用 `packages/ui/src/settings/ConfigSyncParts.tsx`（MCP 同步同一套组件，
  文案在 `settings.configSync.*`）。
- 状态行（`data-testid="subagent-config-sync-status"`）：未登录显示引导 + 「去登录」（跳「同步配置」分区）；
  已登录显示 gist 短 id（外链）、上次同步时间、本地有未上传修改、被跳过的嵌套文件数；同步进行中显示「正在同步…」。
- 下载弹窗：列出 `add/update/localOnly`（最多 50 条，其余只报数量）、本地已改动提醒、远端未识别文件数；
  勾选「镜像远端（删除本地独有的 N 个子智能体）」才以 `replace` 应用（勾选即确认，缺省 `merge`）。
- 上传前命中疑似密钥时弹确认框：只列 `文件名:行号 · 规则名`，不显示命中值；确认后带
  `confirmSecretUpload: true` 重调。
- 同步状态全部是组件局部状态（`configSyncPhase` / `downloadPlan` / `secretWarnings`），不进 `subagentsStore`；
  同步进行中禁用 header 的上传/下载/刷新/新建。
- 文案：私有 gist **非加密存储**必须如实写；i18n key 在 `zh-CN.ts` 与 `en-US.ts` 同步新增
  `settings.configSync.*` 与 `settings.resourceActions.uploadToGithub` / `downloadFromGithub`。
  失败文案按错误码选模板，服务返回的 message 只作技术细节填进 `{detail}`（与 `ModelSmartConfigSection`
  处理 `view.error` 的方式一致）。

## 验收场景

1. 未登录点上传：不发任何网络请求，返回 `not_authenticated`，UI 引导去「同步配置」登录。
2. 首次上传 3 个 agent：创建私有 gist（`public: false`），`revision = 1`，gist 内为 `manifest.json` +
   3 个 `agent.*.md` + `state.json`，元数据写入 gistId。
3. 本地未变化再点上传：返回 `unchanged`，**零网络请求**（假 fetch 断言调用次数为 0）。
4. 本地改了一个 agent 再上传：PATCH 同一 gistId，`revision = 2`，远端被删的 agent 文件在本次上传中移除。
5. 新机器（无元数据）预览：通过 description 发现已有 gist，计划为全 `add`；应用后本地出现全部 agent。
6. merge 下载：远端 A/B、本地 B/C → `added=1, updated=1, kept=1`，C 保留。
7. replace 下载：缺 `confirmReplace` 返回 `unknown` 且本地零变更；带确认后 C 被删除，`removed=1`。
8. 远端 `schemaVersion: 2` 或 md 不可解析：预览即 `remote_invalid`，本地零变更。
9. apply 时远端 revision 与预览不符：`conflict`，本地零变更。
10. 并发：上传进行中再点下载 → `busy`，且 gist 请求只发生一次。
11. 网络失败（`UND_ERR_CONNECT_TIMEOUT`）：`network`，message 含该 code，本地零变更。
12. 401 / 403 / 404 / 限流：映射到 `unauthorized` / `insufficient_scope` / `not_found` / `rate_limited`，
    凭据未被删除。
13. 本地 md 含 `sk-xxxx`：返回 `secret_warning` 且不含命中值；带确认后上传成功。
14. `agents/sub/x.md` 不出现在快照，`skippedNested` 含该路径。
15. 本机 `agents-state.json` 含 `builtInModelOverrides`：上传的 `state.json` 不含该字段。
16. 应用成功或失败后：列表与 mention store 都刷新（成功时出现新 agent）。

## 非目标

逐条挑选、多 gist、自动/定时同步、工作区级同步、三方自动合并、把子智能体配置并入模型智能配置的公开 gist、
改动 `ISubagentsService` 既有 8 个方法的语义。
