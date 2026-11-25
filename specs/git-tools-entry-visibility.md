# Git 工具入口的显示判据

## 背景

Git 工具（更改 + 分支切换 + 提交 + 提交并推送 + 推送 + 拉取）由工作区标题栏的 Git 浮层承载，入口是否出现由 `shouldShowGitToolsEntry` 决定。历史上这个判据是：

```
if (added + removed <= 0) return null;   // added/removed 只统计 unstaged + staged 的行级增减
```

也就是说入口的可见性被绑定在**「工作区有未提交的行级改动」**上。后果是：

- **提交之后工作区变干净 → 整块 Git 工具消失**，连「推送」也没有了；
- 而 `GitActionMenu`（提交/推送的唯一组件）在**整个 UI 里只有这一个渲染点**、`gitService.push` 也只有这一个调用点 —— 于是**提交后用户没有任何地方可以点推送**，只能去终端或外部工具。

这是把「有未提交改动」当成了「有 Git 事情可做」。真正无事可做的状态应该是：**既没有未提交改动，也没有可推送/待拉取的提交**。

顺带暴露的同类问题：判据只看行级增减，那么**纯二进制改动、或 0 行改动的未跟踪文件**会有文件数但行数为 0，入口同样会消失，而这时用户还需要提交它们。

2026-11-20 晚起，Git 入口收敛为**工作区标题栏唯一图标 + 计数徽标 + 按需浮层**（见 `specs/status-panel-git-tools-split.md` 规则 1）。不再有展开态 Git 分区、收起态 Git chip、标题栏兜底图标三套入口。本文件负责**这个唯一入口什么时候出现、徽标显示哪一种计数、浮层内显示哪些行**。

## 产品规则

1. **有效仓库即保留入口**：Git 可用且 workspace 属于仓库时显示标题栏 Git 图标，便于随时查看独立 Git 图谱。干净、无上游和 detached HEAD 也不隐藏；非仓库、Git 不可用及既有 Office 模式排除规则不变。图标与浮层仍由同一个模型决定。详见 `specs/git-graph-filters.md`。
2. **待提交改动按未提交文件数判定，不只看行级增减**。文件数（`gitDirtyFileCount`，按 path 去重）或行级增减任一非零即视为有改动。
3. **可推送性复用 `canPushGitBranch`**，不在这里另写一套：菜单里「推送」项的启用条件、`resolveGitActionMenuPrimaryAction` 的主按钮选择都用它。否则「新分支尚无 upstream」等边界会与按钮自身状态对不上。
4. 落后上游（`behind > 0`）也保留入口：那同样是需要用户处理的状态。
5. **有上游分支（`canPullGitBranch`）也保留入口**（v3.17.3 起，取代原先「干净且与上游同步就不显示」的规则）。
   - 原因：`behind` 只在 fetch/push/pull **之后**才更新，而本应用没有任何后台 fetch。干净工作区 + 别人刚推送过 + 自己还没 fetch 时 `behind` 仍是 0，旧判据会把这种状态判成「无事可做」而隐藏入口 —— 而「想拉取别人的提交」恰恰是最需要这个入口的场景。
   - 代价：配置了上游的干净仓库现在会一直显示 Git 图标。这是有意接受的：浮层并非空段（有分支切换与「拉取」行，「拉取」在此同时也是「检查远端有无更新」），「更改」行在没有改动时不再渲染；图标不显示徽标。
   - 非仓库和 Git 不可用仍然不显示；Git 图谱独立入口加入后，游离 HEAD 且干净的仓库也保留标题栏入口。
6. **Git 浮层内的行**：`更改`（有改动时）→ `分支` → `Git 图谱` → `提交或推送` → `拉取`（有上游时，见 `specs/git-pull.md`）。拉取是与提交/推送并列的独立动作，所以占独立一行，不藏在「提交或推送」的弹窗里；`canPull` 由调用方按 `canPullGitBranch` 算好后传入模型。浮层是全 UI 唯一的 Git 行渲染点。
7. **标题栏图标右上角最多一个计数徽标**，由 `resolveGitToolsBadge` 按以下优先级只选一种：
   - **更改**（`dirtyFileCount > 0 || added + removed > 0`）：计数为 `dirtyFileCount`，图标 `GitBranch`。纯二进制/0 行改动的未跟踪文件归入此类，**允许计数 > 0 而行级增减为 0**，不能因为行数为 0 就落到远程摘要。
   - 否则 **未推送提交**（`hasPushableCommits`）：计数为 `ahead`。
   - 否则 **落后远端**（`behind > 0`）：计数为 `behind`。
   - 否则 **已同步**（`canPull`）：无徽标。
   - 以上都不满足的有效仓库仍有图标，但无徽标；图谱和分支入口仍可访问。
   - 徽标只显示计数，不显示 `+N -M`；计数 ≥ 100 显示 `99+`；不使用 success / destructive 语义色。
   - 「更改」优先于所有远程摘要，不叠加显示。
8. **「更改」行只在真有改动时渲染**（`dirtyFileCount > 0` 或 `added + removed > 0`）。规则 5 让干净仓库也会打开浮层，继续无条件挂一行「+0 -0」会让这段看起来是空的。
9. **唯一入口**：
   - 标题栏 `GitBranch` 图标：`gitTools !== null` 时始终渲染（不再受面板展开/收起或窄屏 auto 影响）；点击切换 Git 浮层（`TID_GIT_TOOLS_PANEL`），按钮同步 `aria-expanded`。
   - 不再渲染 Git chip、不再渲染右上 Git 卡片；`TID_GIT_TOOLS_ENTRY` 是 Git 工具的唯一入口锚点。
   - 打开浮层不改变 Git 事实，隐藏/显示入口也不改变任何 Git 状态；展开状态只写 shell 的 `summaryPanelVariantOverride`（`"panel"` = 打开，其余 = 关闭）。唯一的额外写入是互斥：打开时调 `resetStatusPanelOverlay()` 收起会话状态面板，不写其他 store、不写会话状态卡片的本地状态。

## 状态所有者

- **数据来源不变**：`gitSummary` / `gitDirtyFileCount` / `gitWorktreeChangeSummary` 仍由 `useGitRepository` 提供、`WorkspaceShellLayout` 计算并逐层传入。
- **判据仍是纯函数** `shouldShowGitToolsEntry`（`packages/ui/src/v4/gitToolsEntryVisibility.ts`）。它刻意不含任何运行时依赖（只用 type import），这样规则可以被单测直接加载；可推送性与可拉取性由调用方算好（`canPushGitBranch` / `canPullGitBranch`）传入，避免在这个文件里复制判定。
- **Git 模型只构建一次**：`buildGitToolsModel`（`packages/ui/src/v4/gitToolsModel.ts`）在 `WorkspaceShellLayout` 调用，产出 `GitToolsModel | null`；标题栏图标、徽标与浮层共用这一份，不在多处各算一次可见性。
- **徽标摘要的唯一实现**：`resolveGitToolsBadge(model)` 按规则 7 选计数；原 `resolveGitToolsChip` 删除，不保留第二套摘要实现。
- **展开状态唯一所有者**：shell 的 `summaryPanelVariantOverride`。标题栏图标是唯一写者；没有第二个打开状态、没有 `gitToolsPanelStore`。它与会话状态面板互斥：Git 打开时 shell 调 `resetStatusPanelOverlay()`，状态面板打开时 shell 写 `summaryPanelVariantOverride = null`（`specs/status-panel-git-tools-split.md` 规则 5）。
- **`gitSummary.behind` 仍然只由 fetch/push/pull 推进**，本改动不引入任何后台 fetch；规则 5 是对「该值不可靠」的补偿，不是把它变成实时值。

## 接口

无协议改动。Git 模型与可见性判据：

```ts
// packages/ui/src/v4/gitToolsModel.ts
export interface GitToolsModel {
  summary: GitRepositorySummary;
  dirtyFileCount: number;
  added: number;
  removed: number;
  hasPushableCommits: boolean;
  canPull: boolean;
  isClean: boolean;
}

export function buildGitToolsModel(input: {
  isOfficeMode?: boolean;
  gitSummary?: GitRepositorySummary | null;
  gitDirtyFileCount?: number;
  gitWorktreeChangeSummary?: { added: number; removed: number } | null;
}): GitToolsModel | null;

export type GitToolsBadgeKind = "changes" | "pushable" | "behind" | "synced";

export interface GitToolsBadge {
  kind: GitToolsBadgeKind;
  /** changes: dirtyFileCount；pushable: ahead；behind: behind；synced: null。 */
  count: number | null;
}

export function resolveGitToolsBadge(model: GitToolsModel | null): GitToolsBadge | null;
```

`shouldShowGitToolsEntry` 的签名不变；标题栏图标与 Git 浮层直接消费 `GitToolsModel`。

标题栏图标的显隐输入只有 `gitTools`（非 null）；徽标输入是 `resolveGitToolsBadge(gitTools)`；点击回调是 `onGitToolsPanelOpenChange(true)`。Git 行回调（`onRefreshGit` / `onOpenGitReview` 等）只传给浮层内的 `GitToolsPanel`。

## 验收场景

1. 干净、有上游、`ahead = 0 / behind = 0` → **显示** Git 图标（规则 5）：无徽标；浮层可打开，「更改」行不渲染，「拉取」行可点。
2. **提交之后（ahead > 0，工作区干净）→ 仍显示 Git 入口**：徽标显示 `ahead`；浮层「提交或推送」主按钮为「推送」。
3. 只有未暂存的二进制改动（文件数 1、`added + removed = 0`）→ 显示 Git 图标，徽标显示 `1`，可以提交；浮层「更改」行显示 `+0 -0`，不显示「已同步」。
4. 有跟踪分支且 `ahead = 0`，但 `behind > 0` → 显示 Git 图标，徽标显示 `behind`。
5. 分支尚无 upstream（跟踪分支为空）→ 显示 Git 图标（与「推送」项可用一致）；徽标计数为 `ahead`（通常为 0，此时不显示徽标）。
6. 非 Git 仓库或 Git 不可用 → 标题栏无 Git 图标；游离 HEAD 且工作区干净 → 显示 Git 图标，无徽标，图谱可打开。
7. 窄屏 / 手机远控 → 标题栏仍保留 Git 图标与徽标（不再依赖 Git chip），点击打开同一个浮层。
8. 有改动且有未推送提交 → 徽标只显示文件数，不叠加远程摘要。
9. 有上游时浮层出现独立的「拉取」行；提交弹窗与推送弹窗里都不再出现拉取入口；没有上游时不渲染该行，推送一次后出现。
10. 展开/关闭往返：点图标 → 浮层出现且 `aria-expanded="true"`；`Escape` / 点击外部 / 再点图标 → 浮层关闭，`aria-expanded="false"`，焦点回到图标。
11. 只有 Git 事情可做（无状态内容）→ 标题栏图标可打开浮层；composer 不渲染状态触发器。
12. Git 与状态都存在 → 两个标题栏图标各自可打开自己的浮层，但两者互斥：打开 Git 浮层会收起会话状态面板，打开会话状态面板（图标或 composer 后台任务徽标）会收起 Git 浮层，两者不会同时可见（见 `specs/status-panel-git-tools-split.md` 规则 5）。

## E2E 锚点

- 标题栏 Git 图标：`TID_GIT_TOOLS_ENTRY`（`git-tools-entry`），节点缺席即入口不可见。
- 徽标：`data-git-badge-kind="changes|pushable|behind|synced"`、`data-git-badge-count="<n|99+>"`（`synced` 不渲染计数）。
- Git 浮层：`TID_GIT_TOOLS_PANEL`（`git-tools-panel`）。
- Git 行锚点沿用：`TID_GIT_ACTION_TRIGGER`、`TID_GIT_PULL_TRIGGER`、`TID_GIT_COMMIT_DIALOG`、`TID_GIT_PULL_DIALOG`。
- 已移除：`data-summary-chip="git"`、`data-git-chip-kind`、`data-git-chip-count`、`TID_GIT_TOOLS_POPOVER`，断言其不存在。

## 已知限制

- 有效仓库现在为图谱保留入口；`behind` 仍需 fetch/push/pull 后才能更新，本改动不增加后台 fetch。远程分支候选来自目标仓库已有的 tracking refs，不承诺远端实时状态。
- `behind > 0` 与「有上游」都会保留入口，且主按钮在这些状态下可以拉取（见 `specs/git-pull.md`）；本文件只负责「入口不被误隐藏」，拉取自身的交互与结果展示不在范围内。
- 标题栏图标是工作区级、不是 pane 级：拆分窗格共享同一个 `summaryPanelVariantOverride`，一个窗格打开浮层会同时改变另一窗格的入口态；这是有意的工作区级语义。
- 不做「提交后自动提示推送」之类的引导，只保证入口不被误隐藏。
