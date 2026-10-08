# 单个文件的暂存 / 取消暂存 / 撤销更改

## 背景

Review 面板（`GitPane`）一直是**只读审阅**：能切来源、展开 diff、复制路径、在文件管理器/文件树里定位，但不能对单个文件做 Git 写操作。后端 `IGitService.stagePaths` / `unstagePaths` / `discardPaths` 早已实现并跑真实 `git add` / `git restore`（`gitCliRepo.ts:1435/1456/1465`），前端唯一的引用是 `packages/ui/src/hooks/useGitActions.ts` —— 一个**没有任何消费者的死 hook**，五个方法全是弹 toast 的占位。

结果是：想撤销一个文件的本地改动、或把某个文件先暂存起来，只能退出到外部终端。本次把这三个动作接到 Review 面板的文件右键菜单。

## 产品规则

1. 文件右键菜单新增三项：**暂存此文件 / 取消暂存 / 撤销更改**。菜单顺序：写操作组在前，只读动作（文件管理器、复制路径、文件树）在后，中间用分隔线隔开。
2. 只在**可写来源**上提供：`unstaged` 与 `staged`。`branch`（与分支比较）和 `last-turn`（某一轮会话的快照）是只读对比，不提供任何写操作——它们的 `GitPaneDataset.readonly` 为 `true`，菜单项整体不出现。
3. 单个文件维度：
   - **暂存此文件**：仅未暂存文件可用。
   - **取消暂存**：仅已暂存文件可用。
   - **撤销更改**：仅**未暂存、且未跟踪、且不是新增**的文件可用。
4. **未跟踪文件不提供「撤销更改」。** `repo.discard` 走的是 `git restore --worktree -- <path>`，对未跟踪路径会直接失败；"撤销"一个从未被 Git 记录的文件在语义上等于**删除磁盘文件且不可恢复**，是另一套能力（需要独立的删除确认文案与后果说明），不在本次范围。
5. **撤销更改必须二次确认**：它丢弃工作区改动且不可恢复。复用项目统一的 `useConfirmDialog`（`confirmVariant: "destructive"`）——与 `DeleteAllArchivedTasksButton`、`BotsDialog` 等破坏性操作保持一致。暂存与取消暂存可逆，不做确认。
6. 操作只作用于**被右键的那一个文件**，不做批量、不做目录。
7. 操作成功后刷新 Git 数据集与 diff 缓存，让列表与展开内容都反映新状态。
8. 操作进行中（`pending`）禁用该文件的三个菜单项，避免并发重复提交同一动作。
9. 失败不静默：保留当前列表，用 toast 给出具体原因。

## 状态所有者

- **动作发起方**：`GitPane`。它同时持有 `gitService` 与被右键的文件项，是发起写操作的位置。
- **数据集**：仍由 `useGitRepository` / 上层 `onRefresh` 拥有。`GitPane` 不缓存数据集副本，做完只调 `onRefresh()`——`useGitRepository` 返回新的 `revision` 后，`GitPane` 现有的 effect 会清空 diff 缓存（`GitPane.tsx:166`）。
- **可用性判定**：抽成纯函数 `resolveGitPaneFileActions`（`GitPane/helpers.ts`），输入 `readonly / isStaged / isUntracked / kind / pending`，输出三个布尔。渲染与测试共用同一份规则，避免 UI 与测试各写一套。

## 接口

复用既有 RPC，无协议改动：

```ts
gitService.stagePaths({ workspacePath, paths: [change.path] });
gitService.unstagePaths({ workspacePath, paths: [change.path] });
gitService.discardPaths({ workspacePath, paths: [change.path] });
```

`GitRepositoryRequest` 只要求 `workspacePath`；远端 workspace 的路径解析由服务层 `normalizeInputPath` 负责，UI 不自行拼路径。

## 验收场景

1. 未暂存来源、右键一个已修改文件 → 三项可用（暂存 / 撤销可用，取消暂存禁用）。
2. 已暂存来源、右键一个文件 → 只有取消暂存可用。
3. 未跟踪文件 → 暂存可用，撤销禁用。
4. `branch` 或 `last-turn` 来源 → 右键菜单里不出现写操作组。
5. 点撤销 → 弹出破坏性确认；取消 → 不发生任何 Git 写操作。
6. 确认撤销 → 工作区该文件改动被丢弃，列表刷新后该文件从当前来源消失；已展开的 diff 一并收起。
7. 暂存/取消暂存 → 文件在两个来源间移动，无需确认。
8. 操作失败（例如路径已被外部删除）→ 不变更列表，toast 报出原因。
9. 操作进行中再次右键 → 三个菜单项均为禁用态。

## 已知限制

- 不支持未跟踪文件的撤销（见规则 4）。
- 不支持对已暂存文件执行「撤销更改直到 HEAD」：那需要 `restore --staged --worktree` 的组合语义，影响面更大，本次不开放。想撤销已暂存文件的改动，先在菜单里取消暂存，再撤销。
- 未提供批量或按目录操作；`useGitActions.ts` 这个死 hook 本次不动（它是另一个独立清理项）。
