# Git 工具入口与会话状态入口

> 文件名保留 `status-panel-git-tools-split.md` 以维持既有引用。2026-11-20 晚调整：Git 工具从原面板拆到标题栏（图标 + 徽标 + 浮层）；会话状态（进程 / 终端 / 工作流 / 编排 / 智能体）也改成**同一套标题栏图标 + 面板**：标题栏「会话状态」图标常驻，点击唤醒/收起会话区顶部右侧的状态面板。不再有常驻浮动面板、胶囊或 composer 触发器。

## 背景

Git 工具（更改 / 分支切换 / 提交 / 推送 / 拉取）是 workspace 级的事实型动作；会话运行状态（Goal / 会话计划 / 进程 / 终端 / 工作流 / 编排 / 智能体）是 pane 级的观察型事实。上一版把两者做成「右上 Git 卡片 + 右下状态卡片 + 两个常驻 chip」，暴露出三个问题：

1. **右上纵向堆叠过长**：Git 胶囊挂在标题栏图标下方，与标题栏共用右边缘，被读成第三条工具栏；`+5756 -1659` 这类大数字让胶囊宽度被内容撑到 320px 上限。
2. **右下状态 chip 位置错位**：输入框正上方是「当前回合在发生什么」的注意力区域，却常驻一条历史计划项（最近完成的 todo 原文 + 绿色对勾），读起来像「这些正在成功运行」。
3. **入口重复**：composer 已有 `ConversationBackgroundWorkTrigger` 负责实时活动计数，右下 chip 是第二条语义不同的通道。

本版语义：

- **Git 工具**：标题栏图标 + 计数徽标，点击在图标下方展开 Git 浮层；浮层是 Git 行的唯一渲染点。
- **会话状态**：标题栏「会话状态」图标（与 Git 图标同排，位于 Git 图标右侧）+ 会话区顶部右侧面板；点击图标展开/收起，面板内容与编排模式是否开启无关。
- 两个图标都在标题栏动作区，但两个浮层**互斥**：打开一个时若另一个正开着，先收起另一个。两者都贴着右上角展开，同时出现会互相遮挡。关闭其中一个不会自动打开另一个。

## 产品规则

### 1. Git 工具入口：标题栏图标 + 徽标 + 浮层

1. `WorkspaceHeaderActionSection` 在 `WorkspaceHelpMenuButton` 左侧渲染 `WorkspaceGitToolsEntry`：ghost 图标按钮（`GitBranch`，`size="icon-md"`，图标 `size-4`，`[app-region:no-drag]`），复用既有 `TID_GIT_TOOLS_ENTRY` 锚点。
2. 渲染条件只看 `gitTools !== null`（已包含非 Office、非仓库、Git 不可用、确实无事可做）。不再依赖「面板是否展开」，不再有 `mini` 兜底态；手机远控窄头部同样渲染这一个图标，不新增第二套入口。
3. 图标右上角渲染计数徽标（`resolveGitToolsBadge`，见接口）。徽标只显示计数，不显示 `+N -M`：
   - `changes`：`dirtyFileCount`；
   - `pushable`：`ahead`；
   - `behind`：`behind`；
   - `synced`：无徽标。
     计数上限显示 `99+`；徽标不使用 success / destructive 语义色，统一 `--color-accent`。
4. 点击图标切换 Git 浮层（`Popover`，`align="end"`、`side="bottom"`），按钮同步 `aria-expanded`。浮层根节点挂 `TID_GIT_TOOLS_PANEL`。
5. 浮层内容顺序固定，且是全 UI 唯一的 Git 行渲染点：
   1. 标题行「Git 工具」（复用 `chat.statusPanel.environment`）；
   2. **更改**：`dirtyFileCount > 0 || added + removed > 0` 时渲染；点击调用 `onOpenGitReview`；
   3. **分支切换**：`GitBranchSwitcher`；
   4. **提交或推送**：`GitActionMenu`；
   5. **拉取**：`GitPullAction`，仅 `canPull` 为真时渲染。
6. 「更改」行的大数字只在浮层内出现：`< 1000` 显示精确值；`≥ 1000` 用 `Intl.NumberFormat` compact（`+5.8k / -1.7k`）；完整值放进 tooltip 与 `aria-label`。颜色沿用 `--color-diff-added` / `--color-diff-removed`。
7. 浮层规格：`w-80`、`max-w-[calc(100vw-1rem)]`、`max-h-[min(60dvh,26rem)]`、`rounded-xl`、`popover` 背景、`popover-border` 边框、`shadow-md`、`p-2`。`Escape`、点击外部、再次点击图标都关闭浮层；关闭后焦点回到图标。
8. 浮层不新增第二个 Git 渲染点、不写打开意图 store；展开状态唯一所有者是 shell 的 `summaryPanelVariantOverride`（`"panel"` = 打开，其余 = 关闭）。

### 2. 会话状态入口：标题栏图标 + 会话区顶部面板

1. `WorkspaceHeaderActionSection` 在 Git 图标**右侧**渲染 `WorkspaceStatusEntry`：ghost 图标按钮（`ListChecks`，`size="icon-md"`，图标 `size-4`，`[app-region:no-drag]`），`data-testid` 为 `TID_CHAT_STATUS_ENTRY`，`aria-label` 与 tooltip 为「会话状态」。
2. 渲染条件只看 `activeSessionId` 是否存在（草稿/new task 不渲染）；图标常驻，不依赖当前是否有运行中的计划或智能体——这正是「即使不开启编排模式也能唤醒进程 / 智能体」的入口。
3. 点击图标切换会话状态面板：同一 session 再点一次收起；`aria-expanded` 与 `data-status-entry-open` 跟随开关状态。
4. 开关意图的唯一所有者是 `statusPanelOverlayStore`（`v4/statusPanelOverlayStore.ts`）：只保存一条 `{ sessionId, open }`，不复制业务事实。切到别的 session 时上一条自动失效；composer 的后台任务徽标也通过 `openStatusPanelOverlay(sessionId)` 打开同一面板。
5. 面板不重复后台任务计数：实时运行计数仍归 composer 的 `ConversationBackgroundWorkTrigger` 徽标。
6. 面板不再渲染 Git：Git 行全部在标题栏浮层（规则 1），状态面板里不出现 Git 分区、chip 或「Git 工具」标题。

### 3. 状态面板：顶部右侧的按需浮层

1. 只在 `statusPanelOverlayStore` 中当前 session 的状态为打开时渲染（`SessionPane` 的 `isDraft` 不渲染）；关闭时不占位。
2. 锚定会话区**顶部**右侧：容器 `absolute right-4 top-0 z-20 pt-4`，`w-80`、`max-w-[calc(100vw-1.5rem)]`、`max-h-[min(64dvh,32rem)]`、`rounded-2xl`、`popover` 背景、`shadow-md`。面板是覆盖式浮层：不平移正文、不改变内容列宽。
3. 面板右上角只有一个关闭按钮（`X`，`aria-label` 复用 `common.close`），点击调用 `closeStatusPanelOverlay(sessionId)`；再次点击标题栏图标同样收起。
4. 分区共用一个滚动视口，顺序固定为 Goal → 会话计划 → 进程 → 终端 → 工作流 → 编排 → 智能体；第一条可见分区不画上边线，后续分区 `separated` 只统计状态分区本身。
5. 没有任何状态分区时渲染空态 `chat.statusPanel.empty`（「当前没有进行中的计划、终端或智能体」），保证图标点击永远有反馈。
6. 各分区渲染条件不变：已结束工作流目录仍要求 `endedWorkflowRunCount > 0` 且宿主提供打开目录回调；已结束智能体目录同理（智能体分区只在有运行中或已结束智能体时出现）。

### 4. 子智能体规则保持不变

以下四组规则与 `specs/status-panel-subagent-identity.md` 规则 1–10 一致，本次不改：

1. **行布局**：状态图标引导，标题之下的信息行为 `状态词 → 角色名 → 时长 → TPS → Stop`；`running` = `ArrowRight`（静态）+「运行中」；`waiting` = `Circle` +「等待」；`blocked` = `CircleSlash` +「阻塞」。
2. **排序**：`running` → `waiting` → `blocked`，组内 `startedAt` 升序，缺失/非有限值排组末，相同值保持投影原序；排序结果同时用于 TPS 批量读的 id 顺序。
3. **分区头与收起态**：展开态 trailing `N 运行 · M 等待 · K 阻塞`；收起态 `最长时长 · 该子智能体 TPS · 状态摘要`，读数缺席时省略。
4. **数据口径**：状态唯一来源 `snapshot.subagents.running[].status`；TPS 唯一来源 `session/performanceBatch`。

### 5. 两个浮层互斥

1. Git 浮层与会话状态面板在右上角同一区域展开，**不允许同时打开**：打开一个时如果另一个开着，先收起另一个。
2. 互斥在两个「打开动作」上执行，不做双向联动：关闭 Git 浮层不会打开状态面板，收起状态面板也不会打开 Git 浮层。
3. 互斥只在 shell（`WorkspaceShellLayout`）一处编排，不改写各浮层的开关归属：
   - Git 打开（`onGitToolsPanelOpenChange(true)`）→ 调 `resetStatusPanelOverlay()` 收起状态面板，再写 `summaryPanelVariantOverride = "panel"`；
   - 任何入口打开状态面板（标题栏图标、composer 后台任务徽标）→ `statusPanelOverlayStore` 发出打开通知，shell 订阅 `subscribeStatusPanelOpened` 后写 `summaryPanelVariantOverride = null`。
4. 收起对方是静默的：不切换当前会话、不触发导航、不写协议、不持久化任何新字段。
5. Git 打开回调里只在 `open === true` 时收起状态面板；`open === false`（浮层自身关闭）不能顺手清空状态面板，否则会关掉用户刚打开的面板。

## 状态所有者

| 事实/职责          | 唯一所有者                                                             | 说明                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Git 工作区事实     | `useGitRepository` → `App` → `WorkspaceShellLayout`                    | `gitState.summary`、`gitDirtyFileCount`、`gitWorktreeChangeSummary`。                                                     |
| Git 模型与徽标     | `buildGitToolsModel` / `resolveGitToolsBadge`（`v4/gitToolsModel.ts`） | 纯函数；`WorkspaceShellLayout` 调用一次，结果传给标题栏。                                                                 |
| Git 入口可见性     | `shouldShowGitToolsEntry`                                              | 只决定唯一入口（标题栏图标）是否存在；可推送/可拉取判据由调用方传入。                                                     |
| Git 行渲染         | `WorkspaceGitToolsEntry` 的浮层（`v4/GitToolsPanel.tsx`）              | 「更改 → 分支切换 → 提交或推送 → 拉取」全 UI 唯一渲染点。                                                                 |
| Git 浮层展开/收起  | shell 的 `summaryPanelVariantOverride`                                 | 图标是唯一写者；`"panel"` = 展开，`null` = 收起；不写任何 store。                                                         |
| 状态面板开关意图   | `v4/statusPanelOverlayStore.ts` 的 `{ sessionId, open }`               | 标题栏图标、面板关闭按钮、composer 徽标是写者；只存 UI 意图。                                                             |
| 状态面板入口       | `WorkspaceStatusEntry`（标题栏，`activeSessionId` 存在即渲染）         | 点击调 `toggleStatusPanelOverlay(sessionId)`，`aria-expanded` 跟随。                                                      |
| 状态面板渲染       | `ConversationStatusPanel`（`SessionPane` 内）                          | 只读开关状态与会话投影；关闭时不渲染、不占位。                                                                            |
| 两个浮层互斥       | `WorkspaceShellLayout`                                                 | Git 打开回调调 `resetStatusPanelOverlay()`；订阅 `subscribeStatusPanelOpened` 后写 `summaryPanelVariantOverride = null`。 |
| 子智能体状态事实   | CLI 会话投影 `snapshot.subagents.running[].status`                     | UI 不缓存、不推导。                                                                                                       |
| 子智能体排序与计数 | `packages/ui/src/v4/subagentStatusModel.ts`                            | 纯函数；组件只消费结果。                                                                                                  |
| 子智能体名字       | `resolveSubagentDisplayName`                                           | 既有唯一实现。                                                                                                            |
| 子智能体 TPS       | `useSessionPerformanceBatch` + `resolveSubagentSpeedReadings`          | 既有批量只读轮询。                                                                                                        |

事件顺序：

```text
useGitRepository（工作区 Git 事实）
  → WorkspaceShellLayout → buildGitToolsModel（一次）
       ├─ WorkspaceHeaderActionSection
       │    └─ WorkspaceGitToolsEntry（图标 + 徽标，gitTools !== null 即渲染）
       │         ├─ 点击 → onGitToolsPanelOpenChange(true)
       │         │        → resetStatusPanelOverlay()（互斥：先收起状态面板）
       │         │        → summaryPanelVariantOverride = "panel"
       │         └─ 浮层：更改 → 分支切换 → 提交或推送 → 拉取
       └─ V4WorkspaceChatArea → SessionPane

标题栏「会话状态」图标（WorkspaceStatusEntry）
  → toggleStatusPanelOverlay(activeSessionId)
       → statusPanelOverlayStore = { sessionId, open }
       → subscribeStatusPanelOpened 通知（仅打开跃迁）
            → shell：summaryPanelVariantOverride = null（互斥：收起 Git 浮层）

statusPanelOverlayStore（sessionId 匹配的 pane 才消费）
  → SessionPane.statusPanelOpen
       └─ ConversationStatusPanel（open === true 才渲染，与编排模式无关）
            └─ 会话区顶部右侧浮层：Goal → 会话计划 → 进程 → 终端 → 工作流 → 编排 → 智能体
               （没有分区时显示 chat.statusPanel.empty 空态）

composer 后台任务徽标
  → openStatusPanelOverlay(sessionId)（与图标共用同一开关，不维护第二份打开状态）
```

## 接口

### Git 模型与徽标

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

/** 标题栏徽标的唯一摘要实现；不可见时返回 null。 */
export type GitToolsBadgeKind = "changes" | "pushable" | "behind" | "synced";

export interface GitToolsBadge {
  kind: GitToolsBadgeKind;
  /** changes: dirtyFileCount；pushable: ahead；behind: behind；synced: null。 */
  count: number | null;
}

export function resolveGitToolsBadge(model: GitToolsModel | null): GitToolsBadge | null;
```

### 状态面板开关

```ts
// packages/ui/src/v4/statusPanelOverlayStore.ts
export interface StatusPanelOverlayState {
  sessionId: string | null;
  open: boolean;
}

export function toggleStatusPanelOverlay(sessionId: string): void;
export function openStatusPanelOverlay(sessionId: string): void;
export function closeStatusPanelOverlay(sessionId: string): void;
export function useStatusPanelOverlayOpen(sessionId: string | null | undefined): boolean;
/** 只在面板从「关」变「开」时通知；shell 借此收起 Git 浮层。返回退订函数。 */
export function subscribeStatusPanelOpened(listener: (sessionId: string) => void): () => void;
export function resetStatusPanelOverlay(): void;
```

### 组件 props

```ts
// packages/ui/src/v4/ConversationStatusPanel.tsx
interface ConversationStatusPanelProps {
  /** 面板是否打开：由标题栏图标的握手状态驱动。 */
  open: boolean;
  /** 面板自己的关闭按钮。 */
  onClose?: () => void;
  // 其余状态分区 props 不变；Git props 全部删除。
}

// packages/ui/src/WorkspaceHeaderSections/shared.ts
interface WorkspaceHeaderActionSectionProps {
  /** 当前 pane 的会话 id；存在时渲染标题栏「会话状态」图标。 */
  activeSessionId?: string | null;
  gitTools?: GitToolsModel | null;
  gitToolsPanelOpen?: boolean;
  onGitToolsPanelOpenChange?: (open: boolean) => void;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  onRefreshGit?: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
}
```

### 删除

```text
packages/ui/src/v4/ConversationStatusPanel.tsx
  - 右上 Git 卡片与 GitStatusSection
packages/ui/src/v4/composer/ConversationStatusTrigger.tsx
packages/ui/src/v4/composer/conversationStatusEntryModel.ts
packages/ui/src/v4/gitToolsModel.ts
  - resolveGitToolsChip / GitToolsChip / shouldShowGitToolsHeaderEntry
packages/shared/src/test-ids.ts
  - 新增 TID_GIT_TOOLS_PANEL
  - TID_GIT_TOOLS_ENTRY 保留；TID_CHAT_STATUS_ENTRY 复用为标题栏状态图标
```

### 无协议改动

不新增 RPC、不修改 `packages/shared/src/zcode-protocol/**`、不新增持久化字段。Git 打开状态仍是 shell override；状态面板开关是 `statusPanelOverlayStore` 里的 UI 意图（按 sessionId 匹配，不持久化、不写协议）。

## 验收场景

1. **Git 入口唯一**：`gitTools` 非 null → 标题栏出现 `TID_GIT_TOOLS_ENTRY`，会话区不再出现 Git 胶囊或 Git 卡片；`gitTools` 为 null → 标题栏无图标，浮层不可打开。
2. **徽标优先级**：有未提交改动（含二进制/0 行改动）→ 徽标显示文件数；干净且 `ahead > 0` → 显示 `ahead`；干净且 `behind > 0` → 显示 `behind`；干净且可拉取 → 无徽标。计数 ≥ 100 显示 `99+`。
3. **Git 浮层**：点击图标 → `TID_GIT_TOOLS_PANEL` 出现，行顺序为「更改 → 分支切换 → `TID_GIT_ACTION_TRIGGER` → `TID_GIT_PULL_TRIGGER`（有上游时）」；`Escape` / 点击外部 / 再点图标均关闭，焦点回到图标。
4. **大数字缩写**：`added = 5756`、`removed = 1659` → 浮层「更改」行显示 `+5.8k / -1.7k`，tooltip 与 `aria-label` 保留精确值；`<1000` 时显示精确值。
5. **图标常驻、按需唤醒**：有 active session → 标题栏出现 `TID_CHAT_STATUS_ENTRY`；未点击时面板不渲染；点击后会话区顶部右侧出现 `TID_CHAT_STATUS_SECTIONS_PANEL`（`data-state="expanded"`），`aria-expanded="true"`；再点图标或点面板关闭按钮 → 面板消失。
6. **与编排模式无关**：没有编排 run 时，只要会话有计划 / 终端 / 智能体等内容，图标点击后同样能看到“进程 / 智能体”分区。
7. **空态**：点击图标但会话没有任何状态内容 → 面板显示「当前没有进行中的计划、终端或智能体」，不出现点击无响应。
8. **顶部锚点**：面板锚在会话区顶部右侧（`absolute right-4 top-0`），覆盖正文、不改变内容列宽，与输入框无关。
9. **两个浮层互斥**：状态面板开着时点 Git 图标 → Git 浮层出现，状态面板同时收起；Git 浮层开着时点「会话状态」图标（或 composer 后台任务徽标）→ 状态面板出现，Git 浮层同时收起。关闭其中一个不会重新打开另一个；两者不会在屏幕上同时出现。
10. **手机远控窄头部**：`simplifyForNarrowRemote = true` 时仍保留 Git 与状态两个图标。
11. **Office 模式**：`gitTools = null` → 无 Git 图标；状态图标照常。
12. **拆分窗格**：标题栏图标只唤醒当前 active session 的面板；开关状态按 sessionId 匹配，切到别的会话后旧面板不残留。
13. **子智能体规则不变**：running/waiting/blocked 排序、分区头计数、TPS 缺席省略等行为与 `specs/status-panel-subagent-identity.md` 一致；只有会话确实起过子智能体（运行中或已结束目录可开）时「智能体」分区才出现。
14. **中英文**：Git 浮层标题、状态图标 tooltip、面板分区名与空态随 locale 变化；`aria-label` 同步。

## E2E 锚点

- **Git 入口**：`TID_GIT_TOOLS_ENTRY = "git-tools-entry"`；`data-git-badge-kind="changes|pushable|behind|synced"`、`data-git-badge-count="<n|99+>"`（`synced` 不渲染计数）。
- **Git 浮层**：`TID_GIT_TOOLS_PANEL = "git-tools-panel"`；行锚点仍为 `TID_GIT_ACTION_TRIGGER`、`TID_GIT_PULL_TRIGGER`、`TID_GIT_COMMIT_DIALOG`、`TID_GIT_PULL_DIALOG`。
- **状态入口**：`TID_CHAT_STATUS_ENTRY = "chat-status-entry"`；`data-status-entry-open="true|false"`，`aria-expanded` 同步。
- **状态面板**：`TID_CHAT_STATUS_SECTIONS_PANEL = "chat-status-sections-panel"`；节点带 `data-state="expanded"`；只包含 `[data-status-section]` 状态分区（空态为 `data-status-section="empty"`）。
- **已删除锚点**：`data-summary-chip="git"`、`data-git-chip-kind`、`data-git-chip-count`、`data-display-mode`、`data-layout-mode` 不再由组件渲染；E2E 改为断言其不存在。
