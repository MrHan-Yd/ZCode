# 记忆目录与数据目录搬迁的连续性

## 背景

桌面端允许把数据根从家目录搬到自定义位置(`~/.zcode/v2/setting.json` 的 `dataBaseDir`,启动时由 `desktopDataBaseDirBootstrap` 读入并 `setDataBaseDir`)。搬迁后:

- **设置**始终写在 `resolveUserHomeDir()/.zcode/v2/setting.json`(家目录,固定);
- **记忆**写在 `<数据根>/cli/memories/projects`(`memoryService.ts:20`),跟随 `dataBaseDir`。

两者解耦是刻意的(设置必须能从固定位置读到,才能知道数据根去哪了)。但结果是:**改一次 `dataBaseDir`,此前积累的全部 Project Memory 立刻"失联"**——不在目录列表里、也不参与会话注入,而 UI 只显示「暂无已保存的工作区记忆」,读起来像"你从来没存过"。真实案例:某机器把数据根从家目录改到 `D:\ZCode\data`,7 个项目的记忆全部不可见,而它们完好地留在 `F:\windows-user\.zcode\cli\memories` 下。

存储层其实已经承认这种双根结构(`storage/adapters/rootsResolver.ts`:R1 = 家目录 `.zcode`「永远存在」,R2 = 自定义数据目录),但那是给存储用量扫描用的;记忆服务只认搬移后的单根。

## 根归属:记忆跟随数据根,运行时状态留在本地根

上面那段"失联"只是表象。**真正的缺陷是运行时与设置页对"记忆根"的算法不一致:**

- 设置页:`getZCodeDataRootDir()` + `cli/memories/projects`,即 `<dataBaseDir>/.zcode/cli/memories/projects`(`packages/services/src/memory/memoryService.ts`)。
- 运行时(CLI):`<storage.dir>/cli/memories/projects`(`apps/zcode-cli/packages/core/src/memory/project-root.ts`),而 `storage.dir` 默认硬编码 `~/.zcode`(`apps/zcode-cli/packages/contracts/src/config/index.ts`),**完全不看 `ZCODE_DATA_BASE_DIR`**。

于是只要 `dataBaseDir ≠ 家目录`,agent 就持续把新记忆写进旧根,设置页持续把它读成"存在但不生效"。后果比"看不到"严重:设置页的职责是让用户审计「模型到底在用/记了什么」,而它列的内容与模型实际读写的内容不是同一份;提示里"复制到当前数据目录即可恢复"也成了跑步机——复制后列表好看了,模型用的仍是另一份,新记忆照旧写错地方。

因此明确根归属规则:

1. **记忆跟随数据根**。记忆是设置页可见、可编辑的用户数据,`storageCatalog` 已把它归在 `config` 类别(与 `logs` / `modelTrajectory` / `backups` 区分)。运行时解析记忆根时必须与设置页同根:设置了 `ZCODE_DATA_BASE_DIR` 时用 `<dataBaseDir>/.zcode/cli`,未设置(裸 CLI)时回退既有的 `storage.dir` 行为。
2. **其它运行时状态不跟随**。`cli/db`、`cli/log`、`cli/rollout`、`cli/agents`、`cli/plugins`、`cli/image-cache` 等是机器本地工作状态,继续留在 `storage.dir`。本次不改变「数据存储路径」这个设置对它们的语义。
3. **搬迁必须带上记忆**。`copyDataDirectory` 原先只复制 `.zcode/v2`,改数据根不会迁移 `cli/memories`——这正是上面案例里用户只能手工拷贝的原因。既然记忆按规则 1 属于数据根相对路径,搬家时就要一起复制。

## 产品规则

1. **目录列表仍然只反映"当前生效"的记忆** —— 也就是当前数据根。不做静默合并:列出另一根里并不参与注入的记忆,会让这个页面失去审计意义(它的价值就是让你看见"模型到底在用/记了什么")。
2. 当**另一根存在记忆、而它们当前不生效**时,在列表位置给出明确提示,包含:另一根的路径、项目数、文件数,以及"把它们复制到当前数据目录即可恢复"的指引。
3. 提示只在真的存在差异根时出现;数据根本就在家目录(默认)时不显示任何额外内容。
4. **不在 UI 里自动搬迁或提供一键导入**。写入用户数据目录属于会改变磁盘状态的破坏性操作,需要独立的确认与备份语义,不在本次范围;提示里给出可手工执行的路径。
5. 提示是一次只读探测:除列目录与 `lstat` 外不写任何东西。

## 状态所有者

- **当前生效的记忆根**:`memoryService.requireProjectMemoriesRoot()`(基于 `getZCodeDataRootDir()`),不变。
- **候选根集合**:新增纯函数 `resolveCandidateProjectMemoryRoots({ homeDir, dataBaseDir })` + `resolveInactiveProjectMemoryRoots(...)`(`packages/services/src/memory/roots.ts`)。家目录与数据目录解析到同一路径时只返回一个根,不产生"自己对自己"的提示。
- **提示的展示**:由 `MemorySettingsSection` 在目录加载成功后并发探测一次,结果只用于渲染,不进任何持久化状态。

## 接口

```ts
// packages/services/src/memory/memory.ts
interface ProjectMemoryInactiveRootSummary {
  rootId: "home" | "dataBaseDir";
  path: string;
  workspaceCount: number;
  fileCount: number;
}

interface ProjectMemoryRootsDescription {
  /** 当前生效的记忆根，提示里用它给出"复制到哪"。 */
  activeRootPath: string;
  inactiveRoots: ProjectMemoryInactiveRootSummary[];
}

interface IMemoryService {
  // ...已有 listProjectMemories / readProjectMemoryFile
  /** 描述根分布：当前生效根 + 存在记忆但不生效的其它根。只读探测，不参与列表与注入。 */
  describeProjectMemoryRoots(): Promise<ProjectMemoryRootsDescription>;
}
```

记忆服务只注册在本地 Host(`SettingsPage` 也明确用 `localHostServices.memoryService`,避免远程 workspace 误读本机数据),因此新增方法不涉及远端服务注册。

```ts
// apps/zcode-cli/packages/bootstrap/src/app/paths.ts
/**
 * 记忆根使用的 cliStorageRoot:设置了 ZCODE_DATA_BASE_DIR 时返回
 * `<dataBaseDir>/.zcode/cli`,否则回退传入值(裸 CLI 保持 storage.dir 行为)。
 */
export function getMemoryCliStorageRoot(
  cliStorageRoot: string,
  env: Record<string, string | undefined>,
): string;
```

唯一注入点:`resolveAppRuntimeConfig` 构造 `runtimeConfig.memory.cliStorageRoot`(`apps/zcode-cli/packages/bootstrap/src/app/runtime-config.ts`)。core 侧的记忆根解析(`resolveEnabledProjectMemoryRoot`)与日志字段都读这一个值,所以只改注入点即可让两条消费方一致。**不要**改 `storage.dir` 本身——那会连带搬走 `cli/db` 等运行时状态。

## 验收场景

1. 数据根 = 家目录(默认)→ 探测结果里没有差异根,页面无提示。
2. 数据根被改到 `D:\ZCode\data`,家目录下存在旧记忆 → 列表为空(或只列当前根的内容),同时提示"另一根有 N 个项目 / M 个文件,当前不生效"。
3. 把旧根的记忆**拷贝**到当前根 → 列表出现这些项目;因为旧根仍留有内容,提示**继续存在**(它描述的就是"那份副本当前不生效")。要消除提示需清理旧根,或把它移出候选根。
4. 把旧根的记忆**移走**(而非拷贝)或删除 → 另一根不再有内容,提示消失。
5. 另一根存在但其中项目都没有 `.md` 文件 → 不计入摘要,不产生提示。
6. 另一根路径不存在 → 静默跳过,不报错。
7. **两端口径一致**:数据根为 `D:\ZCode\data` 时,agent 读写的记忆落在 `<D:\ZCode\data>\.zcode\cli\memories\projects`,与设置页列表同根;`cli/db`、`cli/log` 等仍留在 `storage.dir`。
8. **搬迁带走记忆**:把数据根从家目录改到新位置 → 新根出现 `.zcode/cli/memories` 的完整副本;`setting.json` 及其原子写入中间态不复制;已存在的同名文件不被覆盖(`force: false`)。
9. **无记忆时搬家不失败**:源目录 `<old>/.zcode/cli/memories` 不存在 → 跳过,迁移照常成功。
10. **裸 CLI 行为不变**:未设置 `ZCODE_DATA_BASE_DIR` → 记忆根仍是 `<storage.dir>/cli/memories/projects`。

## 已知限制

- **记忆页仍不提供一键导入**。本页对"另一根存在但当前不生效"的记忆只做提示与指引(规则 4);"搬迁时带走记忆"是由「数据存储路径」设置走正规迁移流程完成的(验收 8),两件事不冲突。
- **搬迁只覆盖此后的数据根变更**。此前已经手工遗留在旧根、且新根没有的记忆,仍需人工拷贝一次;迁移不做反向回收,也不会删除旧根内容。
- 只比较"家目录"与"当前数据目录"两个根,不做任意多历史根的追溯。
- 会话注入侧与列表读同一个根(规则 1 落地后成立);旧根里的残留副本在人工复制前确实不生效。
