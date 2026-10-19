# MCP 服务器配置 ↔ GitHub 私有 Gist 同步（MCP config sync）

## 背景

设置页「MCP 服务器」的用户级配置存在 `~/.zcode/cli/config.json` 的 `mcp.servers`（ZCode 自己的目录），
历史/兼容来源还有 `~/.agents/mcp.json` 的 `mcpServers`（生效集合按「ZCode 目录非空则优先，否则回退 agents 目录」
读取）。换机器要一个个重建，且 MCP 配置里常带 API Key。

本改动复用与子智能体配置同步**同一套** GitHub 私有 gist 机制（见 `specs/subagent-config-sync.md` 与
`packages/services/src/config-sync/` 的共享核心），但使用**独立的 gist、独立的元数据与独立的模块**：
两个功能的远端互不干扰，任一功能的 gist 被删/被改都不会影响另一个。

## 数据流

```
本机（唯一事实源）                                 GitHub（登录账号）
~/.zcode/cli/config.json 的 mcp.servers     ──上传──▶  私有 gist
  （ZCode 目录为空时回退 ~/.agents/mcp.json）  ◀─下载──   ├─ manifest.json      (schemaVersion/revision/每文件 sha256)
                                                        ├─ server.<name>.json (单个 server 配置对象)
                                                        └─ （无额外通道：启用状态写在配置对象内）
{数据存储路径}/.zcode/v2/mcp-config-sync.json          本机元数据：gistId / lastRemoteRevision / lastLocalFingerprint
{数据存储路径}/.zcode/v2/mcp-config-sync-backup/<ts>/   应用前备份（整份 config.json）
```

## 产品规则

1. **默认不联网**：打开设置页只读本机状态与元数据；只有点「上传到 GitHub」「从 GitHub 下载」才出网。
2. **私有 gist**：`public: false`，`description` 固定标记 `zcode-mcp-config-sync`。
3. **凭据复用登录账号**：token 从凭据库 key `github:oauth:access_token` 读取（写入方仍是 `GithubAuthService`，
   本改动**只读**）。未登录时上传/下载不发任何网络请求。
4. **同步范围 = 用户级生效集合**：ZCode 目录优先、回退 agents 目录；**不碰工作区级** `<workspace>/.zcode/config.json`
   与 `<workspace>/.agents/mcp.json`（它们是仓库内文件，已随 git 版本化）。
5. **上传即镜像**：远端文件集合 = 本次上传的 server 集合；远端多出来的 `server.*.json` 在本轮删除。
   本地未变化（内容指纹与 `lastLocalFingerprint` 相同且已有 gistId）时直接返回「无需上传」，不发网络请求。
6. **下载必须两阶段**：先「预览」得到计划（不写任何文件），用户确认后再「应用」。
7. **默认只增不删**：`merge` 保留本地独有 server（远端覆盖同名），`replace` 才镜像远端并删除本地独有项，
   且必须带二次确认标记。
8. **失败保留本地不变**：网络、校验、大小上限、revision 冲突等失败都发生在首次写盘之前；写盘阶段失败用备份回滚。
9. **疑似密钥只警告**：MCP 配置的 `env` / `headers` 常含 API Key，上传前扫描命中时先返回警告
   （只给文件名、行号、规则名，不给命中值），确认后才上传。私有 gist **不是加密存储**，文案必须如实。
10. **不做定时/自动同步**，不做逐条挑选。

## 写入语义（MCP 特有）

- **整份重写**：应用时按「server 名 → 配置对象」整份写回 `~/.zcode/cli/config.json` 的 `mcp.servers`
  （`writeZCodeServersToFile`），**不是逐文件写**。因此：
  - `merge`：以本机当前生效集合打底，再用**远端全部条目**（含内容未变的）覆盖同名项；
  - `replace`：只写**远端全部条目**。
  - 两种策略都必须写「远端全集」——只写变更项会把未变更的 server 一起删掉。
- **不会遮掉 agents 目录**：生效集合本身可能来自 `~/.agents/mcp.json`，写回时以该集合打底，
  所以 ZCode 配置里会出现这些 server 的副本，而不是把它们「遮」掉。
  副作用是：应用之后 ZCode 目录非空，生效来源从此固定为 ZCode 配置（这是既有的「优先来源」语义，不是本改动引入的）。
- **启用状态**：按既有约定写在 server 配置对象内的 `enabled`；上传时用 `readServerEnabled` 归一化后再写进条目内容，
  下载时原样写回配置对象。
- **文件名映射**：`server.<name>.json`。服务器名可以是任意用户字符串，因此只对 `% \ / ` 与控制字符做百分号转义
  （空格、中文原样保留以便在 gist 里可读），再由 manifest 记录 `name ↔ fileName` 保证往返精确。

## 状态所有者

- **access token**：`GithubAuthService`（凭据库 `github:oauth:access_token`）。本改动只 `load`，不 `save`/`delete`。
- **用户级 MCP 配置**：`McpSyncService` 独占。设置页的增删改（`saveMcpToUserDirectory`）与同步落地经**同一个写队列**
  串行，不出现「同步写盘期间用户改了一个 server」的交错。
- **同步元数据与备份**：`{数据存储路径}/.zcode/v2/mcp-config-sync.json` 与
  `mcp-config-sync-backup/`（数据存储路径 = 设置里的 `dataBaseDir`，由 `getAppConfigDir()` 解析；
  默认即 `~/.zcode/v2`）。`McpSyncService` 独占。
- **远端 gist**：本机元数据里的 `gistId` 是权威定位；`description` 标记只在「本机没有 gistId」时用于一次性发现。

## 接口

`packages/services/src/mcp-sync/mcpConfigSyncModel.ts`（纯逻辑）

- `MCP_CONFIG_GIST_DESCRIPTION`、`MCP_CONFIG_PROFILE`（`fileNameFor` / `nameFromFileName` / `isValidContent` /
  `maxFileBytes` 512KiB / `maxTotalBytes` 8MiB / `extraFileNames: []`）。
- `encodeMcpServerName` / `decodeMcpServerName` / `mcpServerFileName` / `mcpServerNameFromFileName`。
- `mcpServerItemContent(config, enabled)`：条目内容 = 归一化（键排序）后的配置对象。
- `parseMcpServerConfig(content)`：内容必须是 JSON 对象，否则 `remote_invalid` / `local_invalid`。
- `resolveServerMap({ base, remoteItems })`：整份重写的 server 映射（见「写入语义」）。

`packages/services/src/mcp-sync/mcpConfigSync.ts`：`createMcpConfigSync(options)` → `ConfigSyncOperations`。
端口由 `McpSyncService` 注入：`readEffectiveServers` / `writeUserServers` / `userConfigPath` / `dataDir` /
`credentialService` / `fetchImpl` / `enqueueWrite`。

`IMcpSyncService` 增加 4 个方法（channel 仍是 `mcp-sync`），形状与子智能体同步一致：

```ts
getConfigSyncStatus(): Promise<ConfigSyncStatus>;
syncConfigToGist(params?: { confirmSecretUpload?: boolean }): Promise<ConfigSyncResult<ConfigSyncUploadResult>>;
previewConfigFromGist(): Promise<ConfigSyncResult<ConfigSyncDownloadPlan>>;
applyConfigFromGist(params: {
  strategy: "merge" | "replace";
  expectedRemoteRevision: number;
  confirmReplace?: boolean;
}): Promise<ConfigSyncResult<ConfigSyncDownloadResult>>;
```

## 共享核心

`packages/services/src/config-sync/`（子智能体与 MCP 共用，不含业务语义）

- `types.ts`：`ConfigSync*` 契约类型（状态 / 计划 / 结果 / 错误码）。
- `manifest.ts`：远端 manifest schema、`canonicalJson`、`computeFingerprint`、`buildRemoteFiles`、
  `parseRemoteFiles`（校验 sha256 / 大小 / 可加载性 / 未知文件）、`findOversizedItem`。
- `plan.ts`：`buildPlan`、`resolveApplySet`、`countPlanEntries`。
- `secretScan.ts`：疑似密钥扫描（只回位置与规则名）。
- `gistClient.ts`：GitHub gist 最小客户端与状态码映射。
- `remoteResolver.ts`：远端定位（元数据 gistId 权威 → description 发现 → 再 GET 取全文）与内容校验。
- `metadata.ts` / `backup.ts`：本机同步元数据读写、应用前备份与失败回滚。
- `orchestrator.ts`：`createConfigSync({ adapter, ... })` 编排单飞、凭据、上传/预览/应用、备份回滚与元数据更新。

## 时序

上传：

```
UI ─ syncConfigToGist() ─▶ McpSyncService（经 createConfigSync）
                          单飞检查 → busy?
                          load(github:oauth:access_token) → 空 → not_authenticated（不发网络）
                          读生效集合（ZCode 目录 → 回退 agents 目录）→ 归一化 enabled
                          指纹相同且已有 gistId → unchanged（不发网络）
                          scanSecrets → 命中且未确认 → secret_warning（不发网络）
                          定位远端（元数据 gistId / description 发现 / 新建）
                          PATCH（revision+1；远端多余 server.*.json 置 null）或 POST 新建
                          写元数据 → UI toast + 刷新列表
```

下载：

```
UI ─ previewConfigFromGist() ─▶ 单飞 → 凭据 → 定位远端 → 校验 manifest/server 文件
                                → 与本地生效集合 diff → 计划（不写盘）─▶ UI
UI ─ 确认（列出 add/update/localOnly；replace 需勾选）─▶ applyConfigFromGist({strategy, expectedRemoteRevision})
                                → 单飞 → 再 GET 一次远端 → revision 不符 → conflict
                                → 入队：备份 config.json → 整份写回 mcp.servers → 写元数据
                                → 失败尝试回滚 → UI toast + 刷新 MCP 列表与状态行
```

## 备份与还原

与子智能体同步同一套机制（见 `specs/subagent-config-sync.md` 的「备份与还原」），差异只有内容：

- 备份内容是**整份** `~/.zcode/cli/config.json`（写入的目标文件），放在
  `{数据存储路径}/.zcode/v2/mcp-config-sync-backup/<时间戳>/config.json`。
- 条目数 = 备份里 `mcp.servers` 的 server 个数。
- `listConfigSyncBackups()` / `restoreConfigSyncBackup({ backupDir })` 语义完全一致：只接受已知备份、
  还原前再备份当前状态、整份覆盖需二次确认、不改元数据、参与单飞与写队列。

## 失败语义

与子智能体同步共用同一张表（未登录 / 401 / 403 缺权限 / 404 / 网络 / 超时 / 限流 / 422 请求体被拒绝 /
远端非法 / 超限 / 本地非法 / revision 冲突 / 重复点击 / 疑似密钥 / 写盘失败回滚）。MCP 侧额外注意：

- `local_invalid` 的 message 是 server 名（如 `leaky`），`too_large` 同理。
- `not_found` 在下载侧的含义包括「远端还没有上传过配置」，UI 文案已覆盖。

## UI

- 入口：MCP 设置页「已安装」分组 header 的 `SettingsResourceHeaderActions` 溢出菜单，仅在
  `scopeFilter === "user"` **且当前不是远程 workspace**（`remoteSessionId` / `remoteTarget` 为空）时出现。
  原因：MCP 设置页在远程 workspace 上显示的是**远端 host** 的 user 级 server，而同步固定读写本机
  `~/.zcode/cli/config.json`，两者不是同一份配置，不能混用（子智能体设置页不存在这个问题：它只消费本机 host）。
- 状态行、下载确认弹窗、疑似密钥确认弹窗**复用** `packages/ui/src/settings/ConfigSyncParts.tsx`
  （与子智能体同一套组件与 `settings.configSync.*` 文案）；`testid` 为 `mcp-config-sync-status` /
  `mcp-config-sync-go-login` / `mcp-config-sync-confirm` / `mcp-config-sync-replace-ack` /
  `mcp-config-sync-secret-warning`。
- 未登录时状态行给「去登录」，经 `PluginsSection` 透传的 `onOpenSyncConfigSettings` 跳到「同步配置」分区。
- 同步进行中禁用 header 的上传/下载/刷新/新建。

## 验收场景

1. 未登录点上传：不发任何网络请求，返回 `not_authenticated`，状态行显示未登录引导。
2. 首次上传（含含空格/中文的 server 名）：创建私有 gist，`revision = 1`，文件为 `manifest.json` +
   `server.<name>.json`，`enabled` 已归一化写入配置对象。
3. 本地未变化再点上传：返回 `unchanged`，**零网络请求**。
4. 本地改一个、删一个再上传：PATCH 同一 gist，`revision = 2`，远端被删的 server 文件传 `null`。
5. 生效集合来自 `~/.agents/mcp.json`：上传包含这些 server；下载写回后 ZCode 配置里是并集，服务器不丢。
6. merge 下载：远端 A、本地 A(不同)/B → `updated=1, kept=1`，B 保留。
7. replace 下载：缺 `confirmReplace` 返回错误且本地零变更；带确认后 B 被删除，`removed=1`，
   且**未变更的远端 server 仍在**（整份重写必须写远端全集）。
8. 新机器无元数据：按 description 发现 gist，全量 add，应用后本地出现全部 server 并留下备份目录。
9. 远端文件非法（非 JSON / sha256 不符）或 revision 不符：拒绝写入，本地零变更。
10. `env` 里含 `ghp_...`：先返回 `secret_warning` 且不含命中值；确认后上传成功。
11. 401：返回 `unauthorized`，凭据未被删除。
12. 应用一次下载后还原：本地 `mcp.servers` 回到下载前，且多出一份安全备份；元数据未改写。
13. 传入任意路径调用还原：被拒绝，本地零变更。

## 非目标

工作区级 MCP 配置同步、逐条挑选、多 gist、自动/定时同步、把 MCP 配置并入子智能体或模型智能配置的 gist、
改动 `IMcpSyncService` 既有方法语义。
