## 目标

让「子智能体」和「MCP 服务器」的同步支持**工作区（项目）级**：在设置页切到某个项目分区时，也能上传/下载该项目的配置。用户级行为不变。

已确认的决策：**按项目文件夹名自动识别**（零交互）；**两个功能都做**；模型设置没有工作区级配置，不涉及。

## 1. 作用域与远端命名

新增纯逻辑模块 `packages/services/src/config-sync/scope.ts`：

```ts
export type ConfigSyncScope = { kind: "user" } | { kind: "workspace"; label: string };
export function resolveConfigSyncScope(workspacePath?: string): ConfigSyncScope;
export function scopeGistDescription(base: string, scope: ConfigSyncScope): string;
export function scopeDirName(scope: ConfigSyncScope): string; // 备份目录名，user 为 ""
```

- `label = basename(workspacePath)`，空则回退 `"workspace"`；对备份目录名做最小转义（沿用 `mcpConfigSyncModel.ts` 里 `encodeMcpServerName` 的口径）。
- **远端命名**：用户级仍是 `zcode-subagents-config-sync` / `zcode-mcp-config-sync`；工作区级为 `<base>:<label>`（如 `zcode-subagents-config-sync:ZCode`）。
- **发现**沿用现有规则（description 全等 + 有 `manifest.json`），只是比较的字符串带上了 label。这样零额外请求，且 gist 描述里能直接看出属于哪个项目。
- **不改 manifest schema**（保持 `.strict()` 不变），作用域信息只走 description。
- 已知取舍（你已确认）：同名文件夹的两个项目会共用一份 gist 并互相覆盖；项目改名或换路径后要重新上传。

## 2. 元数据：一份文件、按作用域分片

`config-sync/metadata.ts` 的 schema 升到 v2：

```json
{ "schemaVersion": 2,
  "user": { "gistId": "...", "lastRemoteRevision": 1, "lastLocalFingerprint": "...", "lastSyncedAt": 0 },
  "workspaces": { "ZCode": { ...同字段... } } }
```

- `createConfigSyncMetadataStore(resolveFilePath, scope)`：`read()` 只返回该作用域的记录，`write()` 读改写、保留其它作用域。
- **迁移**：读到 v1（扁平字段）时按 `user` 记录解释，下一次写入落成 v2。现在机器上还没有任何 config-sync 元数据文件（从未成功上传过），迁移路径只是防御性覆盖。
- **并发保护**：两个作用域的 `write` 是读改写同一文件，而现在元数据写入在写队列之外。在 `metadata.ts` 里加一个按文件路径的模块级写入链，把同一文件的写串起来，避免丢更新。

## 3. 备份：按作用域分根目录

- 用户级不变：`{dataDir}/subagents-config-sync-backup/`。
- 工作区级：`{dataDir}/subagents-config-sync-backup/ws-<label>/`（MCP 同理）。这样 `listBackups`、`restore` 的「backupDir 必须来自已知列表」以及每份 10 个/30 天的裁剪都天然按作用域隔离。
- 子智能体工作区级的备份条目只有 `[{ source: <ws>/.zcode/agents, name: "agents" }]`；MCP 为 `[{ source: <ws>/.zcode/config.json, name: "config.json" }]`。

## 4. 适配器

**子智能体**（`subagents/subagentConfigSync.ts`、`subagentConfigSyncStorage.ts`）
- 新增 `SUBAGENT_WORKSPACE_CONFIG_PROFILE`：与现有 profile 同形，但 `extraFileNames: []` —— 工作区级没有 `agents-state.json`（工作区 agent 恒为启用，`supportsEnabledToggle` 也只对 user scope 生效）。
- 快照改读 `<ws>/.zcode/agents` 根目录（复用 `resolveWorkspaceSubagentRoot`），子目录仍只报进 `skippedLocalFiles`。
- `apply` 写 `<ws>/.zcode/agents/*.md`，删除 removals，不碰 state。
- `decoratePlan` 在工作区级返回空的 `stateChange`（字段保持必填，UI 显示 0 项变更）。
- 元数据/备份/gistDescription 按作用域注入。

**MCP**（`mcp-sync/mcpConfigSync.ts`、`mcpSyncService.ts`）
- 读：`readDirectoryServersFromPreferredSources("workspace", workspacePath)`（`<ws>/.zcode/config.json` 优先，回退 `<ws>/.agents/mcp.json`）。
- 写：`writeZCodeServersToFile("workspace", servers, workspacePath)` —— 与用户级一致（读生效集合、写 ZCode 文件），`writeServerMapToJson` 会保留文件里其它键。
- 新增导出 `getWorkspaceZcodeMcpConfigPath(workspacePath)` 供备份源使用（现在只有 `getUserZcodeMcpConfigPath`）。

## 5. 服务契约

`ISubagentsService`（`subagents/subagents.ts`）与 `IMcpSyncService`（`mcp-sync/mcpSync.ts`）的 6 个方法各加一个可选 `workspacePath`：

```ts
getConfigSyncStatus(params?: { workspacePath?: string })
listConfigSyncBackups(params?: { workspacePath?: string })
restoreConfigSyncBackup(params: { backupDir: string; workspacePath?: string })
syncConfigToGist(params?: { confirmSecretUpload?: boolean; workspacePath?: string })
previewConfigFromGist(params?: { workspacePath?: string })
applyConfigFromGist(params: { strategy; expectedRemoteRevision; confirmReplace?; workspacePath?: string })
```

- 省略即用户级，调用方零破坏。`workspacePath` 的有无即作用域判别，与 MCP 现有 `projectPath ? workspace : user` 的口径一致。
- 服务内部按 label 记忆化工作区级 `ConfigSyncOperations`（避免每次调用重建元数据 store），并复用同一个 `enqueueWrite`（写队列仍是每服务一条）。
- 单飞是「每作用域一条」：用户级与工作区级上传可并发，但写的是不同文件、不同 gist，互不影响。
- 服务描述符是纯类型（`descriptors.ts` 的 phantom type），**不需要动 `packages/shared/src/zcode-protocol`**。

## 6. UI

- `SubagentsSection.tsx:1742`：`canSyncConfig` 从 `activeScope === "user" && userScopeAvailable` 改为「用户级看 `userScopeAvailable`，工作区级看 `targetWorkspacePath` 非空」。远程 tab 已被 `:1313` 过滤，子智能体侧天然只做本机。
- 六个 `handle*` 在 `activeScope === "workspace"` 时带上 `workspacePath: targetWorkspacePath`。
- 好消息：工作区 agent 本来就被 `isEditableUserAgent` 归到「已安装」分组（`:153-159`），所以同步入口的渲染位置现成，`ConfigSyncStatusRow` 与三个弹窗都是纯 props、无需改动。
- `McpSettingsSection.tsx:617`：`canSyncConfig` 从 `scopeFilter === "user" && !remoteSessionId && !remoteTarget` 改为 `!remoteSessionId && !remoteTarget`（作用域不再参与门控），并在工作区分区传 `workspacePath`。远程 workspace 仍然不给入口——那里读的是远端 host 的文件，而同步跑在本机。
- 顺带修一处既有文案错误：下载弹窗的 `replaceAck` 默认文案写死「{count} 个子智能体」，MCP 复用后措辞不对。把默认文案改成通用的「{count} 项」，子智能体侧显式传原来的 key 保持原样（两种语言各加一个 key）。

## 7. 不做的事

- 插件来源的条目（插件子智能体、插件 MCP server）仍不进快照——那是所有权边界问题，另立项。
- 内置 profile 无磁盘文件，不涉及。
- 远程 workspace 不提供工作区级同步入口（沿用现有规则）。
- 不做定时/自动同步、不做逐条挑选。

## 8. spec（先于代码）

`specs/subagent-config-sync.md` 作为共享核心的权威描述，新增「作用域」一节：用户级 vs 工作区级的本地路径、gist 命名与发现规则、label 的推导与已知取舍、工作区级无 state.json、备份分根目录、远程边界；`specs/mcp-config-sync.md` 用一段引用它并说明 MCP 侧的读/写/回退来源差异。验收场景补：项目级上传创建带 label 的 gist、两个项目两份 gist、下载写进项目目录（会改动 git 工作区文件，应用前备份可还原）、切换分区时状态行跟随作用域。

## 9. 测试与验证

- 新增 `test/configSyncScope.test.ts`：label 推导、description 拼接、空/尾分隔符路径、转义。
- 新增 `test/configSyncMetadata.test.ts`：v1→v2 迁移、作用域隔离（写工作区不动 user 记录）、同一文件并发写不丢更新。
- `test/subagentConfigSync.test.ts` 补：工作区级上传用带 label 的 description、远端不含 `state.json`、下载写入 `<ws>/.zcode/agents` 且不写 state、两个 label 两份 gist。
- `test/mcpConfigSync.test.ts` 补：工作区级读 `.zcode/config.json` 优先于 `.agents/mcp.json`、写回目标文件、备份源为该文件。
- 假 GitHub 需要断言收到的 `description`。
- 验证命令：`cd packages/services && node --import tsx --test "test/*.test.ts"`、UI 测试、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`。
- 端到端仍需你升级桌面端后实点：切到项目分区上传 → 出现带项目名的 gist；另开一个项目上传 → 两份独立 gist；下载预览 → 写进项目目录。

## 10. 顺序与风险

按 spec → 核心（scope/metadata/backup）→ 子智能体适配器 → MCP 适配器 → 服务契约 → UI → 测试 的顺序推进，每步跑一次相关测试。

主要风险：一是**下载会写进项目目录**（`<ws>/.zcode/agents/*.md`、`<ws>/.zcode/config.json` 是仓库内文件，会让 git 工作区变脏）——这是你要求的能力本身带来的后果，方案里靠「应用前自动备份 + 可还原」兜底，如果你希望下载前额外提示「项目有未提交改动」，告诉我我加进 UI；二是**同名项目共用一份 gist**，这是你选的自动识别方案的固有取舍，状态行与 gist 描述都能看出绑的是哪个 label。