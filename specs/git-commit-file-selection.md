# 提交范围选择（逐文件勾选 + 分组）

## 背景

提交弹窗最初只有一个「包含未暂存的更改」二元开关，提交范围恒等于弹窗列出的**全部**文件；用户无法把不想进本次提交的文件排除掉（本地临时配置、调试日志、无关的生成产物）。底层 `GitCommitRequest.paths` 与 `IGitService.stagePaths` 早已支持按文件子集提交（`gitCliRepo.commit` 带 pathspec 分支），缺的只是 UI。

清单加上逐文件勾选后，那个开关与本清单成了同一件事的两种表达：它切换的是"要不要把未暂存的文件列进来"，而清单里已经能看到有哪些文件。本次把它彻底折叠进清单——「已暂存的更改」作为一个分组出现，勾它就等于"只提交索引里已暂存的内容"，开关本身删除。

## 产品规则

1. 提交弹窗的文件清单**一行一个路径**，默认全部勾选。同一路径**只出现在一个分组里**（归属见规则 4）。
2. 取消勾选的文件不参与本次提交：既不 `git add`，也不进入 commit 的 paths。
3. 清单头部提供「全选 / 取消全选」（三态：全选、部分选中、全不选）；勾选数为 0 时提交与提交并推送置灰。
4. **归属规则**（唯一一条，保证分组不重叠），组间顺序固定为「已暂存的更改」→「更改」→「未进行版本管理的文件」，空组不渲染：
   - **已暂存的更改**：文件在索引里有改动（出现在 `stagedChanges` 源），**即使它同时还有未暂存的修改**。行内显示索引里的增删行数；若同一路径在 `unstagedChanges` 源里也出现，标 `hasUnstagedRemainder`，行内显示「另有未暂存改动」提示。
   - **更改**：已跟踪、有未暂存改动、且索引里没有该文件的改动。行内显示未暂存的增删行数。冲突条目（`section === "conflicted"`）落在这里。
   - **未进行版本管理的文件**：`git status --porcelain` 的 `??` 条目（`isUntracked === true`）。
5. **提交模式由分组决定**：
   - 「更改」「未进行版本管理的文件」的行：先 `git add` 这些路径，再提交它们**工作区当前**的内容。
   - 「已暂存的更改」的行：不 `git add`，只提交**索引里**已暂存的那份内容。
   - 请求参数由 `resolveCommitRequestMode(selectedRows)` 推导：`paths` = 全部勾选路径；`worktreePaths` = 勾选的「更改」/「未跟踪」路径；`stagedPaths` = 勾选的、带余量标记的「已暂存的更改」路径；`stagedOnly = worktreePaths.length === 0 || stagedPaths.length > 0`。
   - 这条口径的意义：没有任何部分暂存时 `worktreePaths` 非空、`stagedPaths` 为空 → `stagedOnly: false`，走 `git add` + pathspec 提交，**与改动前的默认代码路径完全一致**；清单里只有已暂存行时（没有任何要 `git add` 的路径）→ `stagedOnly: true` 走临时 index plumbing，与改动前"自动关掉开关"的行为一致。
6. **相对改动前的两处行为变化**（有意为之）：
   - 部分暂存的文件：改动前它会被整份工作区内容提交（`git add` 把未暂存的部分一并带进 commit）；现在只提交索引里那半段，未暂存的余量留在工作区。这是 `git commit` 的原生语义，也让 `git add -p` 在弹窗里第一次真正生效。
   - 这类文件的未暂存余量**不出现在清单里**（规则 1 禁止同一路径占两行），靠「另有未暂存改动」提示。要在弹窗里连同余量一起提交，需要先去 Git 面板把它全部暂存。
   - 不暂存任何内容的用户感知不到变化：那时「已暂存的更改」是空组不渲染，清单与改动前逐字节相同。
7. 勾选集合是**弹窗会话内的临时状态**：关闭弹窗、打开弹窗、切换分支刷新后一律重置为全选。不持久化、不跨会话记忆。
8. 只要存在可提交行就渲染清单，**含只有 1 个文件的情况**：清单是唯一展示待提交文件路径的地方，隐藏它会让用户只看到一个数量、无法确认具体提交的是哪个文件。
9. 自动生成提交消息的 diff 范围与勾选一致：被排除的文件不写进消息；`stagedPaths` 里的路径只取已暂存 diff，不把并未提交的未暂存余量写进消息。
   - **消息跟着勾选作废**：机器生成的那份消息只在它生成时那批勾选下有效。勾选一变（逐文件、组级、整体全选），若消息仍是机器写的那份（用户没编辑过），立即清空——下次「提交」按当前勾选重新生成，与「消息为空时提交」同一条代码路径。用户在输入框里动过文本后，那是用户自己的内容，不再随勾选变化清空。
   - **两个执行点**，缺一不可：勾选变化时由 effect 清空输入框（用户看得见）；提交入口自己再判一次过期（过期即按"消息为空"处理）。只靠 effect 会留下"勾选刚变、effect 还没跑就按回车"的同帧竞态，那一帧会把上一批勾选的消息提交出去。
   - 这条口径的意义：生成的提交消息是"本次要提交什么"的描述，它不是用户内容。留着上一批勾选的消息，提交时就会写出并未提交的改动（例如只勾了「更改」却把未勾选的未跟踪文件写进消息）。
10. 每个组头一行复选框，三态口径与整体「全选」一致（全选 / 部分选中 / 全不选），点击只作用于该组文件，不影响其他组；组头右侧计数按组内口径显示「N 个文件」或「已选/N 个文件」。
11. 组头可折叠：折叠只隐藏该组文件行，**不改变勾选状态**。折叠集合是弹窗会话内的临时 UI 状态，关闭弹窗即重置为全部展开，不持久化。
12. 折叠用仓库既有的 `Collapsible`（tw-animate-css 的 `animate-collapsible-down/up`，300ms ease-in-out，基于 `--radix-collapsible-content-height`），箭头旋转同节奏。**弹窗高度的伸缩由这次内容动画连带驱动**（`DialogContent` / `form` 高度都是 auto），不再单独给弹窗加 height transition——对 auto 高度再加 transition 只会引入一层无法收敛的二次动画。遵循仓库约定，`prefers-reduced-motion: reduce` 下通过 `data-zcode-commit-file-group` 标记关闭这两层关键帧。

## 状态所有者

- **弹窗文件数据**（`stagedFiles` / `unstagedFiles`，两份 per-source 预览）由 `GitActionMenu` 持有。
- **排除集合**（`commitExcludedStagePaths`）由 `GitActionMenu` 持有，key 为 `GitCommitFileRow.stagePath`（= `GitFileChange.path`，仓库内绝对路径），与 `GitCommitRequest.paths` 同一坐标系，不做二次路径变换。因为归属规则保证一行一路径，key 仍可用裸路径。
- 弹窗组件只读该集合并回调，不复制状态；唯一写入路径是 `onToggleFileSelection` / `onSetAllFilesSelected` / `onSetFilesSelected`。
- **机器消息的勾选快照**（`generatedCommitMessageSelectionKey`）由 `GitActionMenu` 持有：它记录输入框里那份消息是为哪批勾选生成的（`buildCommitMessageSelectionKey(排除集合)`）。勾选 key 与它不一致时清空消息并清掉它本身（规则 9）；用户编辑文本时同步清掉（此后消息算用户内容）。生成成功时写入，是唯一写入点。
- **行、分组与提交模式都是派生视图**，没有独立状态：
  - `buildCommitFileRows({ stagedFiles, unstagedFiles })` 按规则 4 合成行并排序；
  - `groupCommitFileRows(rows)` 只负责按组切分渲染；
  - `resolveCommitRequestMode(selectedRows)` 从勾选结果推导 `paths` / `worktreePaths` / `stagedPaths` / `stagedOnly`。
- **折叠集合**（`collapsedGroupIds`）由弹窗组件本地持有（纯 UI 状态），关闭弹窗重置，不上抛给 `GitActionMenu`。

## 接口

```ts
// packages/ui/src/git-action-menu/display.ts
type GitCommitFileGroupId = "staged" | "changes" | "untracked";

interface GitCommitFileRow {
  stagePath: string;
  repoRelativePath: string;
  workspaceRelativePath: string;
  kind: GitFileChange["kind"];
  group: GitCommitFileGroupId;
  /** 索引里已暂存、但工作区还有未纳入本次提交的改动：只能按索引内容提交，不做 git add。 */
  hasUnstagedRemainder: boolean;
  added: number;
  removed: number;
}

interface GitCommitFileGroup {
  id: GitCommitFileGroupId;
  files: GitCommitFileRow[];
}

/** 按规则 4 合成行：有已暂存内容的路径只在「已暂存的更改」出现一次。 */
function buildCommitFileRows(options: {
  stagedFiles: readonly GitBranchCommitPreviewFile[];
  unstagedFiles: readonly GitBranchCommitPreviewFile[];
}): GitCommitFileRow[];

/** 按固定顺序分组，空组被过滤。 */
function groupCommitFileRows(rows: readonly GitCommitFileRow[]): GitCommitFileGroup[];

/** 从勾选结果推导提交请求参数（规则 5）。 */
function resolveCommitRequestMode(rows: readonly GitCommitFileRow[]): {
  paths: string[];
  worktreePaths: string[];
  stagedPaths: string[];
  stagedOnly: boolean;
};

/** 勾选快照 key：同一组路径在任何顺序 / 重复下得到同一个 key（规则 9 作废判断用）。 */
function buildCommitMessageSelectionKey(paths: Iterable<string>): string;

/** 输入框里那份消息是否已对不上当前勾选。key 为 null（无机器消息 / 用户已编辑）一律不算过期。 */
function isGeneratedCommitMessageStale(options: {
  generatedSelectionKey: string | null;
  currentSelectionKey: string;
}): boolean;
```

```ts
// packages/shared/src/git.ts
interface GitGenerateCommitMessageRequest {
  // ...
  /** 只提交索引内容的路径：生成消息时只取已暂存 diff，不叠加未暂存余量。 */
  stagedPaths?: string[];
}
```

- 提交侧**不改协议**：复用既有 `GitCommitRequest.paths` 与 `GitCommitRequest.stagedOnly`，按下条规则取值。
- 「已暂存的更改」里带余量标记的路径进 `stagedPaths` 时，`git add` 只作用于 `worktreePaths`，所以索引里那半段不会被工作区内容覆盖。
- 既有纯函数 `excludeCommitPreviewFiles` / `collectCommitPreviewStagePaths` / `resolveCommitPreviewSelectionState` 按 `stagePath` 工作，改成对任意带 `stagePath` 的行生效后原样复用。

## 验收场景

1. 默认打开弹窗 → 全部勾选；提交内容与改动前一致（同样是全部文件）。
2. 取消勾选一个未暂存文件 → 提交后该文件仍留在工作区未提交，其余文件进入本次提交。
3. 取消勾选全部文件 → 提交与提交并推送置灰，勾选数为 0 时不会发出提交请求。
4. 关闭再打开弹窗 → 勾选恢复全选。
5. 一个文件既已暂存又有未暂存改动 → **只出现在「已暂存的更改」一组**（不在「更改」重复出现），行内带「另有未暂存改动」提示；提交后只有索引里那半段进入 commit，工作区余量保持未暂存。
6. 只勾选「已暂存的更改」组 → `worktreePaths` 为空、`stagedOnly: true`，不发生 `git add`，只提交索引内容。
7. 未暂存任何内容的仓库（全部改动都在工作区）→ 清单只显示「更改」与「未进行版本管理的文件」两组，布局与改动前一致；提交时先 `git add` 全部勾选路径，一次提交全部。
8. 点「未进行版本管理的文件」组头复选框 → 只取消勾选该组，其他组勾选不变。
9. 只有未跟踪文件（或只有已跟踪改动）→ 只渲染非空的那一组，另一组不占位、不出现空表头。
10. 折叠「未进行版本管理的文件」→ 该组文件行以 300ms 高度动画收起，组头复选框、计数与整体全选状态都不变；再展开后勾选与折叠前一致。清单未超出高度上限时，弹窗高度同步伸缩。
11. 提交消息为空时点提交 → 生成的消息描述范围与勾选一致；带余量标记的路径不会被描述它未暂存的那部分。
12. 清单已经超出高度上限（`min(40vh, 18rem)`）时折叠某一组 → 弹窗高度不变，只在清单内部滚动区域变化（此时没有可伸缩的弹窗高度，属预期）。
13. 生成消息后改变勾选（勾上/取消任意一行、任一组的组头全选、整体全选）→ 机器写的那份消息被清空，✨ 按钮回到「生成」，提交时按当前勾选重新生成；用户在输入框里编辑过的消息（哪怕只改一个字）在勾选变化后原样保留。
14. 生成消息后不改勾选直接提交 → 复用刚生成的消息，不重复请求模型。

## 布局约束

提交弹窗宽度固定 `max-w-md`，文件清单必须在这个宽度内自洽，不能靠撑宽弹窗容纳内容：

1. **长路径**：按 `splitCommitPreviewFilePath` 拆成「目录 + 文件名」两段渲染。目录先截断、文件名优先保留并带完整路径 `title`——同名文件分布在不同目录时，文件名才是区分依据。目录只能收缩不能伸展，否则短目录会把文件名挤到行尾。
2. **横向不许溢出**：弹窗外壳（`DialogContent`）是 grid 容器，子项默认 `min-width: auto`，长内容会把行撑出弹窗边框。`form` 必须显式 `min-w-0`，清单滚动容器再加 `overflow-x-hidden` 兜底。
3. **大量文件**：清单高度上限 `min(40vh, 18rem)`（约 10 行）并在内部滚动，表头与底部提交动作始终留在视野内；`form` 自身再按 `calc(100dvh - 3rem)` 封顶兜底，保证窗口很矮时提交动作仍可达。各区块 `shrink-0`，避免滚动时被压扁。
4. 计数与 `+/-` 用 `shrink-0`，永远完整可见；只有路径段参与收缩。
5. **分组缩进**：组头是「折叠箭头（20px）+ 组复选框 + 组名 + 组计数」，文件行用 `pl-8`（32px）与组复选框左边缘对齐。缩进只吃掉少量目录宽度，文件名优先保留的规则不变；组头的组计数与文件行的 `+/-` 都用 `shrink-0`，不参与收缩。
6. **余量提示**：带 `hasUnstagedRemainder` 的行在文件名后显示「另有未暂存改动」，用 `shrink-0` 且不参与收缩；它只解释"为什么这行的行数比你改的少"，不是可交互控件。

## 已知限制

- 页头 `+/-` 行数在存在会话变更摘要（`activeTaskChangeSummary`）时仍以摘要为准；没有摘要时按勾选行的合计，而带余量标记的行只计已暂存的那部分。
- 排除集合不持久化：没有"永久忽略某文件"的机制。`getIgnoredPaths` 读的是 `.gitignore`，与提交过滤无关，本次不改。
- 已暂存文件被取消勾选时不会被 `git restore --staged`：它只是不进本次 commit，暂存态保持原样。
- 部分暂存文件的未暂存余量不在清单里（规则 1 的归属互斥）。要从弹窗里连余量一起提交，需要先在 Git 面板把它全部暂存。
- 混合模式（同时勾了「已暂存的更改」与工作区行）依赖既有 plumbing 分支"按真实 index 逐个 `update-index --cacheinfo`"的实现，rename 的 `originalPath` 清理也由它覆盖；普通分支的 rename 处理弱于它，这是改动前就存在的差异。
