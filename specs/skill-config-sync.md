# 技能配置 ↔ GitHub 私有 Gist 同步（skill config sync）

## 背景

设置页「技能」的技能目录存在用户级 `~/.zcode/skills/<dir>/SKILL.md`（兼容来源 `~/.agents/skills`）
与工作区级 `<workspace>/.zcode/skills`（兼容来源 `<workspace>/.agents/skills`）。
换机器要逐个复制目录，且技能常带脚本、references 等附属文件。

已有的「远端同步」（`RemoteSkillSyncDialog`）只在本机 ↔ SSH/WSL workspace 之间传归档，不是云同步。
本改动复用 MCP / 子智能体同一套 GitHub 私有 gist 机制（`packages/services/src/config-sync/`），
提供**上传到 GitHub**、**从 GitHub 下载**、**从备份还原**，与 MCP 设置页入口同形。

各功能的 gist、元数据、备份互相独立：`zcode-skill-config-sync` 与 `zcode-mcp-config-sync` 互不影响。

## 数据流

```
本机（唯一事实源）                                     GitHub（登录账号）
~/.zcode/skills/                                     私有 gist
  <skill>/SKILL.md                        ──上传──▶  ├─ manifest.json
  <skill>/scripts/run.py                  ◀─下载──   ├─ skill.<skill%2fscripts%2frun.py>
  <skill>/references/notes.md                        └─ skill.<skill%2fSKILL.md>
（`.zcode` 优先；目录名/技能名未被覆盖时并入 `.agents/skills`）

{数据存储路径}/.zcode/v2/skill-config-sync.json       本机元数据：gistId / revision / fingerprint
{数据存储路径}/.zcode/v2/skill-config-sync-backup/    应用前备份（整份 skills 根目录）
```

## 产品规则

1. **默认不联网**：打开技能设置页只读本机状态；只有点「上传到 GitHub」「从 GitHub 下载」才出网。
2. **私有 gist**：`public: false`，`description` 固定 `zcode-skill-config-sync`（工作区级为
   `zcode-skill-config-sync:<项目目录名>`）。
3. **凭据复用登录账号**：token 从凭据库 `github:oauth:access_token` 只读获取；未登录时零网络请求。
4. **同步单位是文件**：条目名 = `<skill 相对目录>/<文件相对路径>`（统一 `/` 分隔）。
   `SKILL.md` 是技能身份；只有包含 `SKILL.md` 的目录才算技能。
5. **远端文件名可逆**：`skill.` + 对 `% \ / 与控制字符` 做百分号转义的条目名。
   例：`my-skill/scripts/run.py` → `skill.my-skill%2fscripts%2frun.py`。
   manifest 记录 `name ↔ fileName`，往返精确。
6. **文本原样、二进制 base64**：文件内容能按 UTF-8 无损往返且不含 NUL 时按原文上传；
   否则上传为 JSON 封装 `{"$zcodeSkillSync":"base64","data":"<base64>"}`，下载时解码写回字节。
7. **只同步常规文件**：符号链接、目录、设备文件与超过单文件上限（512KiB）的文件跳过，
   并计入状态行的 skipped 数量（不阻断其余文件的同步）。
8. **上传即镜像**：远端文件集合 = 本次快照；远端多出的 `skill.*` 在本轮删除。
   本地指纹未变化且已有 gistId 时返回 `unchanged`，零网络请求。
9. **下载必须两阶段**：先预览计划（不写盘），用户确认后应用；`merge` 保留本地独有文件，
   `replace` 镜像远端并删除本地独有文件，且必须带二次确认。
10. **应用前备份、失败回滚**：备份对象是本次写入的 skills 根目录（整目录）。
11. **不做定时/自动同步**，不做逐条挑选。
12. **与「远端同步」并存**：SSH/WSL 同步继续走既有归档通道，本功能只处理 GitHub gist。

## 作用域

| | 用户级 | 工作区级 |
| --- | --- | --- |
| 生效读取根 | `~/.zcode/skills`，未覆盖的目录/名称再从 `~/.agents/skills` 并入 | `<workspace>/.zcode/skills`，回退规则同上 |
| 写入/备份根 | `~/.zcode/skills` | `<workspace>/.zcode/skills` |
| gist description | `zcode-skill-config-sync` | `zcode-skill-config-sync:<label>` |
| 元数据分片 / 备份子目录 | `user` / 根目录 | `workspaces[label]` / `ws-<label>/` |

作用域模型与 MCP 完全一致（见 `specs/mcp-config-sync.md`「作用域」）。
远程 workspace 不提供入口：页面显示的是远端 host 的技能，而同步固定在本机 host 执行。

## 状态所有者

- **access token**：`GithubAuthService`（凭据库 `github:oauth:access_token`）；本改动只 `load`。
- **技能目录**：`SkillsService` 与 `SkillSyncService` 的既有写入路径；本改动的应用写盘经
  `SkillSyncService` 自己的写队列串行，不出现「同步写盘期间用户删技能」的交错。
- **同步元数据与备份**：`{数据存储路径}/.zcode/v2/skill-config-sync*.json` 与
  `skill-config-sync-backup/`，由 `SkillSyncService` 独占。
- **远端 gist**：本机元数据里的 `gistId` 权威；description 仅用于一次性发现。

## 接口

`packages/services/src/skill-sync/skillConfigSyncModel.ts`（纯逻辑）

- `SKILL_CONFIG_GIST_DESCRIPTION`、`SKILL_CONFIG_PROFILE`
  （`fileNameFor` / `nameFromFileName` / `isValidContent` / `maxFileBytes` 512KiB /
  `maxTotalBytes` 16MiB / `extraFileNames: []`）。
- `skillSyncItemFileName(name)` / `skillSyncItemNameFromFileName(fileName)`。
- `encodeSkillSyncItemContent(buffer)` / `isBinarySkillSyncContent(name, content)`：
  文本 / base64 封装的判定与编码。
- `isValidSkillItemName(name)`：非空、无 `..`/绝对路径/空段。
- `validateSkillSyncGroups(items)`：远端全集里每个技能目录都必须包含 `SKILL.md`。

`packages/services/src/skill-sync/skillConfigSync.ts`

- `resolveSkillSyncRoots({ homeDir, workspacePath? })`：读取根（ZCode 优先、agents 兜底）与写入根。
- `createSkillConfigSync(options)` → `ConfigSyncOperations`；端口由 `SkillSyncService` 注入
  （`readSnapshot` / `writeSkillFiles` / `removeSkillFiles` / `skillsRoot` / `dataDir` /
  `credentialService` / `fetchImpl` / `enqueueWrite`）。

`ISkillSyncService` 增加 6 个方法（channel 仍是 `skill-sync`），形状与 MCP 一致：

```ts
getConfigSyncStatus(params?: { workspacePath?: string }): Promise<ConfigSyncStatus>;
syncConfigToGist(params?: {
  confirmSecretUpload?: boolean;
  workspacePath?: string;
}): Promise<ConfigSyncResult<ConfigSyncUploadResult>>;
previewConfigFromGist(params?: {
  workspacePath?: string;
}): Promise<ConfigSyncResult<ConfigSyncDownloadPlan>>;
applyConfigFromGist(params: {
  strategy: "merge" | "replace";
  expectedRemoteRevision: number;
  confirmReplace?: boolean;
  workspacePath?: string;
}): Promise<ConfigSyncResult<ConfigSyncDownloadResult>>;
listConfigSyncBackups(params?: { workspacePath?: string }): Promise<ConfigSyncBackupList>;
restoreConfigSyncBackup(params: {
  backupDir: string;
  workspacePath?: string;
}): Promise<ConfigSyncResult<ConfigSyncRestoreResult>>;
```

## 写入语义

- 逐文件写：`writes` 中的每个条目按条目名解析到 skills 根内的安全相对路径
  （`normalizeSkillSyncRelativePath` / `resolveSkillSyncPathWithin`），`mkdir -p` 后写文件。
- `removals` 删除对应文件，并向上清理空目录（不越过 skills 根）。
- 应用时先按技能分组校验：任一被写入的技能组必须包含 `SKILL.md`，否则中止并回滚。
- 路径穿越（`..`、绝对路径、盘符、反斜杠）一律拒绝。

## UI

- 入口：技能设置页「已安装」分组 header 的 `SettingsResourceHeaderActions` 溢出菜单，
  与 MCP 相同：上传 / 下载 / 从备份还原 / 刷新 / 导入 / 新建。
- 门控：仅本机 workspace（`remoteSessionId` / `remoteTarget` 为空）；用户分区同步用户级，
  工作区分区需要真实 `workspacePath`。
- 状态行复用 `ConfigSyncStatusRow`；下载确认、备份还原、疑似密钥确认复用
  `ConfigSyncDownloadDialog` / `ConfigSyncRestoreDialog` / `ConfigSyncSecretWarningDialog`。
- testid：`skill-config-upload` / `skill-config-download` / `skill-config-restore` /
  `skill-config-sync-status` / `skill-config-sync-go-login` / `skill-config-sync-confirm` /
  `skill-config-sync-restore-confirm` / `skill-config-sync-secret-warning`。
- 应用/还原成功后：刷新技能列表与共享 skill store，并让延迟草稿会话失效。

## 验收场景

1. 未登录点上传：零网络请求，返回 `not_authenticated`，状态行显示未登录引导。
2. 首次上传含嵌套目录的技能：创建私有 gist，`revision = 1`，文件包含 `manifest.json` 与每个
   `skill.<encoded>`；`SKILL.md` 与附属文本文件内容逐字节一致。
3. 本地未变化再点上传：返回 `unchanged`，零网络请求。
4. 本地删掉一个技能文件再上传：PATCH 同一 gist，`revision + 1`，远端对应文件置 `null`。
5. 新机器无元数据：按 description 发现 gist，预览显示全部 `add`，应用后技能目录完整出现。
6. merge 下载：远端 A、本地 A(不同)/B → A 更新、B 保留。
7. replace 下载：缺 `confirmReplace` 返回错误且本地零变更；确认后本地独有文件被删除。
8. 二进制文件（如图片）往返后字节一致；远端内容是 base64 封装。
9. 符号链接文件不出现在计划里，状态行 skipped 计数 +1。
10. 远端文件路径含 `..` 或绝对路径：拒绝写入，本地零变更。
11. 401 / 网络失败 / revision 冲突：本地零变更，错误码映射与 MCP 一致。
12. 应用后从备份还原：技能根目录回到应用前状态，并留下安全备份。
13. 项目级上传：description 为 `zcode-skill-config-sync:<label>`，元数据写进工作区分片。
14. `~/.agents/skills` 里未被 `~/.zcode/skills` 覆盖的技能也参与上传；下载写回 `.zcode/skills`。

## 非目标

多 gist、逐条挑选、自动/定时同步、把技能并入 MCP 或子智能体的 gist、
改变既有 SSH/WSL 技能归档同步语义、同步技能启用状态（启用状态在 agent 侧单独存储）。
