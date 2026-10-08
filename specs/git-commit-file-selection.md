# 提交范围选择（逐文件勾选）

## 背景

提交弹窗此前只有一个「包含未暂存的更改」二元开关，提交范围恒等于弹窗列出的**全部**文件。用户无法把不想进本次提交的文件排除掉（本地临时配置、调试日志、无关的生成产物）。底层 `GitCommitRequest.paths` 与 `IGitService.stagePaths` 早已支持按文件子集提交（`gitCliRepo.commit` 带 pathspec 分支），缺的只是 UI，以及"生成消息"与勾选范围的一致性。

## 产品规则

1. 提交弹窗在「包含未暂存的更改」下方新增文件清单，每个文件一行复选框，**默认全部勾选** —— 默认行为与改动前逐字节一致。
2. 取消勾选的文件不参与本次提交：既不 `git add`，也不进入 commit 的 paths。
3. 清单头部提供「全选 / 取消全选」（三态：全选、部分选中、全不选）；勾选数为 0 时提交与提交并推送置灰。
4. 「包含未暂存的更改」关闭时，清单只列已暂存文件，勾选作用于该子集；重新打开该开关时恢复全部勾选。
5. 勾选集合是**弹窗会话内的临时状态**：关闭弹窗、打开弹窗、切换分支刷新、切换「包含未暂存的更改」后一律重置为全选。不持久化、不跨会话记忆。
6. 只有 1 个文件时不渲染清单：此时勾选没有实际自由度，清单只是噪声（总数已由开关行右侧计数表达）。
7. 自动生成提交消息的 diff 范围与勾选一致 —— 不把被排除的文件写进消息，否则消息会描述并未提交的改动。
8. 清单与计数按 `stagePath` 去重：同一文件同时处于 staged / unstaged 时只出现一行、只计一次。这也是头部 `+/-` 的取值口径从"两条记录相加"收敛为"单条记录"的原因（此前会把它算两遍）。

## 状态所有者

- **弹窗文件数据**（`stagedFiles` / `unstagedFiles` / `includeUnstaged`）仍由 `GitActionMenu` 持有，本次不迁移。
- **新增的排除集合**（`excludedPaths`）由 `GitActionMenu` 持有，key 为 `GitBranchCommitPreviewFile.stagePath`（= `GitFileChange.path`，仓库内绝对路径），与 `GitCommitRequest.paths` 同一坐标系，不做二次路径变换。
- 弹窗组件只读该集合并回调，不复制状态；唯一写入路径是 `onToggleFileSelection` / `onSetAllFilesSelected`。

## 接口

```ts
// packages/shared/src/git.ts
interface GitGenerateCommitMessageRequest {
  // ...
  /** 本次不参与提交的路径；缺省（或空数组）表示不排除任何文件。 */
  excludePaths?: string[];
}
```

- `filterCommitMessageFilesByCurrentSession({ ..., excludePaths })`：排除集合复用既有的路径归一化（绝对路径 / workspace 相对 / repo 相对都能匹配），与会话范围过滤叠加。
- 提交侧**不改协议**：复用既有 `GitCommitRequest.paths`，传勾选子集即可。
- UI 侧新增纯函数（`packages/ui/src/git-action-menu/display.ts`）：按 `stagePath` 去重、按排除集合过滤、收集 stage paths、判断是否全选。

## 验收场景

1. 默认打开弹窗（>1 个文件）→ 全部勾选，提交内容与改动前一致（同样是全部文件）。
2. 取消勾选一个未暂存文件 → 提交后该文件仍留在工作区未提交，其余文件进入本次提交。
3. 取消勾选全部文件 → 提交与提交并推送置灰，勾选数为 0 时不会发出提交请求。
4. 关闭再打开弹窗 → 勾选恢复全选。
5. 「包含未暂存的更改」关闭 → 清单只显示已暂存文件；重新打开后恢复全选且包含未暂存文件。
6. 提交消息为空时点提交 → 生成的消息描述范围与勾选一致（被排除的文件不出现在消息里），随后按勾选子集提交。
7. 只有 1 个文件 → 不渲染清单，UI 与改动前一致。

## 布局约束

提交弹窗宽度固定 `max-w-md`，文件清单必须在这个宽度内自洽，不能靠撑宽弹窗容纳内容：

1. **长路径**：按 `splitCommitPreviewFilePath` 拆成「目录 + 文件名」两段渲染。目录先截断、文件名优先保留并带完整路径 `title`——同名文件分布在不同目录时，文件名才是区分依据。目录只能收缩不能伸展，否则短目录会把文件名挤到行尾。
2. **横向不许溢出**：弹窗外壳（`DialogContent`）是 grid 容器，子项默认 `min-width: auto`，长内容会把行撑出弹窗边框。`form` 必须显式 `min-w-0`，清单滚动容器再加 `overflow-x-hidden` 兜底。
3. **大量文件**：清单高度上限 `min(40vh, 18rem)`（约 10 行）并在内部滚动，表头与底部提交动作始终留在视野内；`form` 自身再按 `calc(100dvh - 3rem)` 封顶兜底，保证窗口很矮时提交动作仍可达。各区块 `shrink-0`，避免滚动时被压扁。
4. 计数与 `+/-` 用 `shrink-0`，永远完整可见；只有路径段参与收缩。

## 已知限制

- 头部 `+/-` 行数在存在会话变更摘要（`activeTaskChangeSummary`）时仍以摘要为准，不随勾选变化；摘要只在无摘要时回落到勾选文件的合计。
- 排除集合不持久化：没有"永久忽略某文件"的机制。`getIgnoredPaths` 读的是 `.gitignore`，与提交过滤无关，本次不改。
- 已暂存文件被取消勾选时不会被 `git restore --staged`：它只是不进本次 commit，暂存态保持原样。
