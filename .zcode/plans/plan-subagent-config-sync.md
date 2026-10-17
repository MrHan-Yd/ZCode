# 子智能体配置 ↔ GitHub 私有 Gist 同步（规划）

> 需求：设置页「子智能体」加按钮，把本机子智能体配置上传到「同步配置 → GitHub 账号」里已登录的账号（私有
> gist），并能从远端下载同步到本地。
>
> 来源：system-architect 架构方案（2026-10-17）。实现前先按本文落 `specs/subagent-config-sync.md`。

## 结论

同步能力**挂进 `ISubagentsService`**（不新建服务、不新增 channel）：user 级 `agents/*.md` 与
`agents-state.json` 的唯一所有者就是它，上传/下载只是给它增加「出网 + 凭据」两个端口。

远端用**单个私有 gist 多文件**（`manifest.json` + 每个 agent 一个 `agent.<name>.md` + `state.json`），
gist id 记在本机元数据文件、description 标记做兜底发现。下载是**两阶段（预览 → 确认 → 应用）**，
默认 `merge`（只增不删），`replace` 需显式二次确认；应用前强制备份，全部网络与校验在首次写盘前完成。

```
Renderer: SubagentsSection
  ├─ SettingsResourceHeaderActions(+ 上传/下载到 GitHub)
  ├─ 局部状态: syncStatus / plan / secretWarnings（不进 store）
  └─ services.subagentsService / services.githubAuthService
        │ RPC channel "subagents"（复用，不新增）
Host: createSubagentsService ← 唯一所有者 / 唯一写入方
  ├─ writeQueue（setEnabled / overrides / syncApply 串行）
  ├─ {storageRoot}/agents/*.md              (user, depth-0)
  ├─ {storageRoot}/v2/agents-state.json     (精选子集)
  ├─ {storageRoot}/v2/subagents-config-sync.json  (gistId / rev / fingerprint)
  ├─ {storageRoot}/v2/subagents-config-sync-backup/<ts>/
  ├─ subagentConfigSync.ts（纯逻辑 + 编排）
  └─ 端口: credentialService.load + hostApiNetworkTransport.fetch
        ├─ github:oauth:access_token（GithubAuthService 独占，本方案只读）
        └─ api.github.com/gists（token 明文绝不出 host、不入 RPC 返回、不入日志）
```

## 事实纠正（影响设计，先读）

1. **`createAgent` / `updateAgent` / `deleteAgent` 不走 `writeQueue`**（`subagentsService.ts:703/725/754`；
   队列只在 561/645/671/690 使用）。即「单一写入路径」目前只是部分成立，同步写盘要自己入队，并正视
   「同步写盘期间用户点新建」的并发窗口（见 R3）。
2. **`agents-state.json` 还有两个旧字段** `builtInModelOverrides` / `builtInThoughtLevelOverrides`，
   注释明确禁止从这两个字段恢复覆盖。快照**绝不能**带它们，否则会把废弃语义重新注入远端。
3. **用户级 agent 目录是递归扫描的**（`collectAgentMarkdownPaths` 递归，`subagentsService.ts:250-265`），
   而 `createAgent` 只写根目录平铺文件。同步范围必须显式定义（本方案：只取 depth-0）。
4. **设置页确实能切到工作区级 agent**（`selectedScopeKey` 默认 `"user"`，切 workspace 时
   `mode: "allRuntimeScopes"`），所以「是否同步工作区级」是真实产品选择，不是「反正看不到」。

有利现状：`createAgentStateId` / `createPluginAgentStateId` 与路径无关，`disabledAgentIds` 与模型覆盖
天然可跨机迁移；`SubagentsSection` 消费 `localHostServices`，同步天然打在**本机 host** 的 `~/.zcode` 上。

## ADR 摘要

| # | 决策 | 理由 | 被否 |
|---|---|---|---|
| 1 | 范围 = user 级 `agents/` **根目录** md + state 精选子集（`disabledAgentIds` + 两个 `*SelectionOverrides`） | 与 `createAgent` 落盘位置一致；`createAgentStateId` 与路径无关；工作区级是仓库事实（已随 git 版本化，跨机路径不同） | 递归全量、含工作区级、只同步 md、带旧字段 |
| 2 | 单私有 gist 多文件；本机 `gistId` 权威，description 标记兜底发现；`manifest.json` 带 `schemaVersion`/`revision`/每文件 `sha256` | `gist` scope 已冻结；gistId 落本机是 O(1) 确定性定位；revision+sha256 支撑变更提示与冲突检测 | 专用仓库（需 `repo` scope）、每次搜索定位、无 manifest、单文件 base64 JSON |
| 3 | 两阶段 `preview → apply`；默认 merge、显式 replace、应用前强制备份（留最近 3 份） | 不可逆删除必须是用户显式动作；plan 成为可测纯函数；多文件写盘非全局原子，备份是诚实兜底 | 单阶段静默覆盖、逐条 cherry-pick（列为未来）、三方自动合并、默认删除、只靠 atomicWrite 不备份 |
| 4 | 扩展 `ISubagentsService`（+4 方法，方法数 8→12），实现拆 `subagentConfigSync.ts`；同步写盘入同一 `writeQueue` | `agents-state.json` 的 read-modify-write 最脆弱，两个服务各自持队列会互相丢更新；`subagentsService.ts` 已 850 行、被 max-lines 豁免，不宜再膨胀 | 新建独立 sync 服务（引入第二写入方 + 共享队列成本）、塞进 `githubAuthService`、UI 侧组装快照 |
| 5 | 服务侧单飞 `busy` + 操作号 + 指纹短路 | 分别对应并发点击、晚到的旧结果、重复点击；禁止用超时掩盖同步问题 | 队列化并发上传、UI 侧防抖代替服务侧单飞 |
| 6 | 上传前本地密钥扫描：**只警告、不自动改写、不阻止**，返回 `{fileName, line, pattern}`（不含命中值） | agent md 必然含 prompt 与示例，是密钥泄漏高风险载体；私有 gist **不是加密** | 静默上传、自动删行、阻止上传 |
| 7 | 日志只记事件与错误码（`gistId` 只记前 8 位），禁止记 md/state/token/命中值 | AGENTS.md 日志分级；`describeError` 带 cause 链 code 对代理问题有诊断价值 | 记内容便于排查 |

## 契约草案（详见方案，不写实现）

新增错误码：`not_authenticated | unauthorized | insufficient_scope | not_found | rate_limited | network |
timeout | remote_invalid | too_large | local_invalid | conflict | busy | unknown`。

`ISubagentsService` 新增 4 个方法：

- `getConfigSyncStatus()`：只读本机状态与元数据，不联网。返回 `connected / gistIdShort / gistUrl /
  lastRemoteRevision / lastSyncedAt / localAgentCount / localFingerprint / localChangedSinceLastSync /
  skippedNested`。
- `syncConfigToGist({ force?, confirmSecretUpload? })`：返回 `ok | unchanged` + `gistUrl` + `remoteRevision`
  + `agentCount` + `secretWarnings?`。
- `previewConfigFromGist()`：只读远端 + 本地快照，返回计划（`entries[].kind = add | update | same |
  localOnly`、`stateChange`、`destructive`、`conflict`、`remoteSkipped`、`expectedRemoteRevision`），
  **不写任何文件**。
- `applyConfigFromGist({ strategy, expectedRemoteRevision, confirmReplace? })`：`replace` 缺
  `confirmReplace` 直接报错；`expectedRemoteRevision` 与远端不符 → `conflict`。

工厂新增可选端口：`credentialService?: Pick<ICredentialService, "load">`、`fetchImpl`（必须注入
`hostApiNetworkTransport.fetch`）、`gistDescription`、`maxFileBytes`（默认 512KB）、`maxTotalBytes`（默认 8MB）。
在 `packages/services/src/node.ts` 注册处注入（`credentialService`、`hostApiNetworkTransport` 在该作用域已是现成变量）。

本机元数据 `{storageRoot}/v2/subagents-config-sync.json`：`{ schemaVersion: 1, gistId?, lastRemoteRevision?,
lastLocalFingerprint?, lastSyncedAt? }`，`SubagentsService` 独占写入。

远端：`manifest.json` = `{ schemaVersion: 1, revision, updatedAt, agents: [{name, fileName, sha256, bytes}],
state: { fileName, sha256 } }`；`schemaVersion ≠ 1` → `remote_invalid`（拒绝写入）。

## 时序要点

**上传**：单飞检查 → `credentialService.load` → 本地快照（含 `skippedNested`）→ 指纹相同则 `unchanged`
（**零网络**）→ 密钥扫描（命中先弹窗，确认后带 `confirmSecretUpload` 重调）→ 无 gistId 则 `GET /gists` 发现
→ `GET /gists/{id}` 取 revision → `PATCH`（或首次 `POST`，`public:false`）→ **先写远端、后写本机 metadata**
→ 触发既有 `refresh()` + `refreshMentionStore()`。

**下载**：`preview` 读远端 + 本地 → 校验 sha256/大小/解析 → diff 出计划（**不写盘**）→ UI 确认 →
`apply` 复核 `expectedRemoteRevision` → 入队：备份 → 写 md（`atomicWriteText`）→ replace 时删 localOnly →
写 state（curated 合并/替换）→ 写 metadata → 任一步失败尝试回滚 → 既有刷新链路。

幂等键是**内容指纹**（不是时间戳）；`preview` 与 `apply` 各自读一次远端，`expectedRemoteRevision` 是两者
之间唯一的 stale 防护契约。

## 失败语义（本地一律零变更，除非已进入 apply）

未登录 → `not_authenticated`（不发网络）；401 → `unauthorized`（**不删凭据**）；403 缺 scope →
`insufficient_scope`；404 → 上传路径清 gistId 自动重建一次，再失败 `not_found`；403/429 且
`x-ratelimit-remaining: 0` → `rate_limited`（带 `retry-after`）；fetch 抛错 → `network`（message 带 cause
链 code，如 `UND_ERR_CONNECT_TIMEOUT`）；超时 → `timeout`（20s）；manifest/state/md 非法 → `remote_invalid`；
超限 → `too_large`；本地 md 解析失败 → `local_invalid`；revision 不符 → `conflict`；单飞命中 → `busy`
（不提示，按钮已禁用）；apply 写盘失败 → 尝试回滚，失败则回报 `backupDir` 供人工恢复。

## UI 约束

- 入口：扩展 `packages/ui/src/settings/SettingsResourceHeaderActions.tsx`（已有 `onImport`/`onExport`
  溢出菜单，`hasOverflowActions` 需并入新 action），挂到 `SubagentsSection.tsx:1784` 的**用户级分组 header**。
- 状态行：`data-testid="subagent-config-sync-status"`，仅在有元数据或已登录时渲染（gist 短 id / 上次同步 /
  本地已改动 / 跳过嵌套文件数）。
- 未登录引导：`SubagentsSectionProps` 加 `onOpenSyncConfigSettings?`，由 `SettingsPage.tsx` 复用既有
  `setActiveSettingsSection` 跳到「同步配置」。
- 同步状态全部为组件局部状态（`syncStatus / plan / secretWarnings / latestSyncRequestIdRef`），**不进
  `subagentsStore`**（那是服务端投影）。`syncStatus !== "idle"` 时禁用上传/下载/刷新/新建/行内编辑。
- 文案：私有 gist **非加密存储**必须如实写；密钥警告只列 `fileName + line + pattern`，不显示命中值。
- i18n：`zh-CN.ts` 与 `en-US.ts` 同步新增约 30 个 `settings.subagents.sync.*` key（见方案 6.4 清单）。
- testid：`subagent-config-upload` / `-download` / `-sync-status` / `-sync-confirm` / `-sync-replace-ack` /
  `-sync-secret-warning` / `-sync-go-login`，加进 `packages/shared/src/test-ids.ts`。

## 任务拆分（按依赖顺序）

| # | 工作项 | 触及文件 | 验证 |
|---|---|---|---|
| T1 | 落 spec | `specs/subagent-config-sync.md` | 评审 |
| T2 | 纯逻辑：manifest schema / 指纹 / diff→plan / 密钥扫描 | `subagents/subagentConfigSyncModel.ts`（新） | `node --import tsx --test test/subagentConfigSyncModel.test.ts` |
| T3 | gist 客户端 + 错误码映射 + 上限 | `subagents/subagentConfigSync.ts`（新） | 服务层测试 + 假 `fetchImpl`（200/401/403/404/429/非 JSON/超时） |
| T4 | 本机元数据读写 + 备份/回滚 | 同上 + `atomicWriteText` | 临时目录测试 + 注入 fs 故障 |
| T5 | 契约扩展 4 方法 + 类型 | `subagents/subagents.ts`、`services/src/index.ts` | `pnpm typecheck` |
| T6 | 组合与队列接入 | `subagentsService.ts` | 并发 `setEnabled` + `applyConfigFromGist` 不丢更新 |
| T7 | host 装配注入 | `services/src/node.ts` | `pnpm typecheck` + 桌面端真实 gist 手工验证 |
| T8 | UI（header action + 状态/确认/toast + 跳转 prop） | `SettingsResourceHeaderActions.tsx`、`SubagentsSection.tsx`、`SettingsPage.tsx` | `pnpm typecheck` / `lint` + 桌面端手工 |
| T9 | i18n + testid 常量 | `i18n/locales/*.ts`、`shared/src/test-ids.ts` | 双语目视 |
| T10 | 全量校验 | — | `architecture:check --changed`、`typecheck`、`lint`、`fmt:check` |

## 需拍板（3 条）

- **R1 下载默认策略**：推荐 merge（只增不删），代价是「A 机删掉的 agent 在 B 机仍存在」，需手动清理。
  备选：默认 replace + 强确认；或 merge 但把 `localOnly` 做成勾选项（v1 成本高）。
- **R2 state 里的模型覆盖是否同步**：推荐纳入（换机后「配置」才完整，`createAgentStateId` 与路径无关），
  spec 里写明「目标机缺该模型时由既有选择器兜底，不校验不裁剪」。备选：只同步 `disabledAgentIds`。
- **R3 是否本期修「create/update/delete 不走 writeQueue」**：推荐本期一并入队（改动小，顺带满足单一写入
  路径约束），UI 侧禁用作为第二道防线。备选：只做 UI 禁用（多窗口/手机远控下防线失效）。

## 非目标

逐条 cherry-pick、多 gist、自动/定时同步、工作区级同步、三方自动合并、改 `modelSmartConfig` 的公开 gist、
改既有 8 个方法语义。
