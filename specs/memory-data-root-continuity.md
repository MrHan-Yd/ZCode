# 记忆目录与数据目录搬迁的连续性

## 背景

桌面端允许把数据根从家目录搬到自定义位置(`~/.zcode/v2/setting.json` 的 `dataBaseDir`,启动时由 `desktopDataBaseDirBootstrap` 读入并 `setDataBaseDir`)。搬迁后:

- **设置**始终写在 `resolveUserHomeDir()/.zcode/v2/setting.json`(家目录,固定);
- **记忆**写在 `<数据根>/cli/memories/projects`(`memoryService.ts:20`),跟随 `dataBaseDir`。

两者解耦是刻意的(设置必须能从固定位置读到,才能知道数据根去哪了)。但结果是:**改一次 `dataBaseDir`,此前积累的全部 Project Memory 立刻"失联"**——不在目录列表里、也不参与会话注入,而 UI 只显示「暂无已保存的工作区记忆」,读起来像"你从来没存过"。真实案例:某机器把数据根从家目录改到 `D:\ZCode\data`,7 个项目的记忆全部不可见,而它们完好地留在 `F:\windows-user\.zcode\cli\memories` 下。

存储层其实已经承认这种双根结构(`storage/adapters/rootsResolver.ts`:R1 = 家目录 `.zcode`「永远存在」,R2 = 自定义数据目录),但那是给存储用量扫描用的;记忆服务只认搬移后的单根。

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

## 验收场景

1. 数据根 = 家目录(默认)→ 探测结果里没有差异根,页面无提示。
2. 数据根被改到 `D:\ZCode\data`,家目录下存在旧记忆 → 列表为空(或只列当前根的内容),同时提示"另一根有 N 个项目 / M 个文件,当前不生效"。
3. 把旧根的记忆**拷贝**到当前根 → 列表出现这些项目;因为旧根仍留有内容,提示**继续存在**(它描述的就是"那份副本当前不生效")。要消除提示需清理旧根,或把它移出候选根。
4. 把旧根的记忆**移走**(而非拷贝)或删除 → 另一根不再有内容,提示消失。
5. 另一根存在但其中项目都没有 `.md` 文件 → 不计入摘要,不产生提示。
6. 另一根路径不存在 → 静默跳过,不报错。

## 已知限制

- 不自动迁移:提示只告知与指引,搬迁仍需人工执行(见规则 4)。
- 只比较"家目录"与"当前数据目录"两个根,不做任意多历史根的追溯。
- 会话注入侧仍只读当前根,与列表口径一致;提示中的记忆在复制前确实不生效。
