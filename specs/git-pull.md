# Git 工具的一键拉取（pull）

## 背景

右上角 Git 工具一直只有「提交 / 提交或推送 / 推送」三个动作，没有拉取。`git-tools-entry-visibility.md` 把这件事记在已知限制里：落后远端（`behind > 0`）虽然能让入口保留下来，但用户没有任何地方能点「拉取」，只能去终端或外部工具。

更糟的是这个缺口会让入口**看起来可用但点不动**：工作区干净、`ahead = 0`、`behind > 0` 时，`resolveGitActionMenuPrimaryAction` 既选不出 `commit`（无改动）也选不出 `push`（`canPushGitBranch` 要求 `ahead > 0` 或没有 upstream），返回 `null`，主按钮置灰——而这时唯一该做的事，正是拉取。

本次新增拉取动作，并把「拉取完到底拿回来多少东西」变成用户能看到的结果：有更新就报数量，没更新就明确说「已是最新」，失败就给出可读原因。

## 产品规则

1. **拉取是一个独立动作**，与推送同级，入口有三处，交互沿用既有 Git 操作：
   - 提交弹窗的动作列表（与「提交 / 提交并推送 / 推送」同一个 Command 列表，同一套键盘导航）；
   - 主按钮：当选不出提交也选不出推送、但可拉取时（干净 + `behind > 0`），主按钮变成「拉取」；
   - 推送弹窗底部提供「拉取」次要按钮（干净 + `ahead > 0` + `behind > 0` 时主按钮是推送，拉取仍需可达）。
2. **入口可用性分两档**，不要混成一个判据：
   - 「可拉取」（`canPullGitBranch`，即有上游）决定**主按钮**是否变成拉取、推送弹窗是否给出拉取按钮——这两处是主动作，不能指向一个必然失败的操作；
   - **提交弹窗里的「拉取」项只要求仓库可用**（`isGitAvailable && isRepository`）。没有上游时它仍可点开，由弹窗说明「先推送一次建立跟踪关系」；直接置灰只会留下一个没有解释的灰按钮，而弹窗里那段提示永远没人看得到。弹窗的确认按钮在无上游时保持禁用。
3. **可拉取性由纯函数 `canPullGitBranch` 判定**：`headRefType === "branch"` 且分支名非空且**存在上游分支**。不做 `behind > 0` 的限制——`behind` 来自上一次 fetch 的本地快照，可能已经过期；真正有没有东西要拉，以 `git pull` 的结果为准。入口显隐判据见 `specs/git-tools-entry-visibility.md`。
4. **拉取结果按「本次 pull 是否改变了当前分支的 HEAD」判定**（`headBefore !== headAfter`）：
   - 变了 → `updated: true`，并附带本次拉取量：提交数（`rev-list --count oldHead..newHead`）、文件数 / 增删行数（`diff --numstat oldHead newHead` 聚合）。取不到就置 `null`，UI 只展示取到的部分。
   - 没变 → `updated: false`，UI 提示「已是最新版本」，不静默。
   - 采用 HEAD 判定而不是比对远程跟踪引用：如果用户（或其它工具）此前已 fetch 过，本地跟踪引用不会再移动，但 pull 仍然会快进 HEAD——只比跟踪引用会把这种情况误报成「已是最新」。
5. **任一侧 HEAD 读不到时按「有更新、数量未知」上报**，不下「无变化」的结论。拉取后的 `rev-parse` 超时/失败会返回 `null`，若因此报「已是最新」，会把真的快进过的分支说成没变；反过来只是多报一次数量未知的拉取。对应地，此时 `commitCount` / `fileCount` / `added` / `removed` 全为 `null`，**不能给 0**——0 会被渲染成「0 个提交」，把"不知道"说成"没有"。
6. **不覆盖用户的 pull 策略**：执行 `git pull --no-edit`。`--no-edit` 只避免 merge 提交信息拉起编辑器导致命令挂死；是否 merge / rebase / 只允许快进仍由仓库自身的 `pull.rebase` / `pull.ff` 决定。
7. **预期内的失败给出稳定的错误码**（`GitPullIssueCode`），UI 按码选本地化文案；未识别的失败回落到原始 Git 输出。错误码随 RPC 的 `code` 字段透传（`channelServer` 的 passthroughKeys 已包含 `code`）。
8. **失败详情保留原始 Git 输出**。错误正文 = 一句说明 + 原始输出（`formatGitPullErrorMessage`）：只留那句话会丢掉 Git 列出的冲突文件、被覆盖的路径等关键线索，而弹窗的「错误详情」是唯一能承载它们的出口。
9. **拉取期间不刷新仓库状态，改到弹窗关闭时刷新一次**。`GitActionMenu` 活在条件渲染的 Git 段里；拉取成功后 `behind` 归零、工作区变干净——那正是隐藏条件，立即刷新会把整块 Git 段（连同刚渲染出结果的面板）卸载掉，用户根本读不到拉取量。失败同样保留弹窗：那是唯一能看到冲突原因与原始输出的地方。因此：
   - `handlePullSubmit` 只更新弹窗状态 + 发 toast；
   - `closePullDialog` 在**本次会话真的跑过拉取**时补一次刷新（ref 标记，纯取消关闭不刷新）；
   - toast 里同时带上文件数与增删行数：toast 不受卸载影响，是拉取量的冗余通道（面板被卸载时数量信息不丢）。
10. **拉取量是整仓口径，不按 workspace 裁剪**。`diff --numstat base target` 覆盖整个仓库；monorepo 子目录作为 workspace 时，弹窗里的文件数会包含工作区之外的文件。变更列表必须按 workspace 裁剪（那些条目要驱动 stage/discard），但拉取量描述的是「这次 pull 从远端带回来了多少」，整仓口径更符合语义，因此刻意不裁。

### 错误码与场景对应

| 触发条件                         | 错误码                    | 识别方式                                                                                                            |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| HEAD 游离                        | `detached-head`           | 拉取前状态：`headRefType !== "branch"`                                                                              |
| 仓库没有可用 remote              | `no-remote`               | 无上游 + `git remote` 为空；或 stderr 命中 no remote repository specified / does not appear to be a git repository  |
| 分支没有上游分支                 | `no-upstream`             | 无上游 + 存在 remote；或 stderr 命中 there is no tracking information                                               |
| 上游分支在远端已被删除           | `upstream-branch-missing` | stderr 命中 no such ref was fetched / couldn't find remote ref / your configuration specifies to merge with the ref |
| 本地未提交改动会被覆盖           | `dirty-working-tree`      | stderr 命中 overwritten / commit your changes or stash them / unstaged changes                                      |
| 合并冲突（含冲突未解决时再拉取） | `merge-conflict`          | stderr 命中 CONFLICT / Automatic merge failed / unmerged files / unresolved conflict / pulling is not possible      |
| 分支已分叉且未配置策略           | `diverged`                | stderr 命中 reconcile divergent branches / Not possible to fast-forward                                             |
| 认证或权限失败                   | `authentication-failed`   | stderr 命中 Authentication failed / could not read Username / Permission denied (publickey) / 401 / 403             |
| 网络不可达                       | `network-error`           | stderr 命中 Could not resolve host / unable to access / Connection timed out / Network is unreachable               |
| 超时                             | `timeout`                 | 命令 `timedOut`                                                                                                     |
| 已有未完成的 merge / rebase      | `operation-in-progress`   | stderr 命中 MERGE_HEAD exists / you have not concluded your merge / rebase in progress                              |
| 其它                             | `unknown`                 | 兜底，展示原始 Git 输出                                                                                             |

这里的 `timeout` 不使用 `ensureGitCommandSucceeded` 的通用超时文案，而是先判 `timedOut` 再分类，保证超时也有本地化提示。`merge-conflict` 覆盖「冲突未解决时再次拉取」：Git 第二次不再打 `CONFLICT`，只说 `Pulling is not possible because you have unmerged files`，但引导动作与首次冲突相同，归到同一个码。

## 状态所有者

- **Git 事实的唯一所有者仍是 repo 层的 `getStatus` 快照**。`pull` 不新增状态：它在执行前后各读一次 `HEAD`，中间跑一次 `git pull`，然后 `invalidate(workspacePath)` 让后续读取重新走 Git。拉取量是对这两次 HEAD 的差集计算，不落盘、不缓存。
- **UI 的进行中/结果状态归 `GitActionMenu` 组件本地状态**：`pullDialogOpen` / `pullResult` / `pullError`，与既有 `pushDialogOpen` / `pushError` 同级。进行中复用既有的 `mutationPending`——同一时刻只会打开一个弹窗，不与 push/commit 并发。
- **重复拉取靠 UI 串行**：`mutationPending` 期间按钮禁用，这与 push / commit 的既有做法一致。不在 repo 层加超时兜底（Git 自身的 `index.lock` 只会把并发拉取变成难读的失败）。

## 接口

`packages/shared/src/git.ts`：

```ts
export interface GitPullRequest extends GitRepositoryRequest {}

export type GitPullIssueCode =
  | "detached-head"
  | "no-remote"
  | "no-upstream"
  | "dirty-working-tree"
  | "merge-conflict"
  | "diverged"
  | "authentication-failed"
  | "network-error"
  | "timeout"
  | "operation-in-progress"
  | "unknown";

export interface GitPullResult {
  branchName: string | null;
  trackingBranchName: string | null;
  remoteName: string | null;
  updated: boolean;
  commitCount: number | null;
  fileCount: number | null;
  added: number | null;
  removed: number | null;
  summary: GitRepositorySummary; // 拉取后的状态快照
}
```

- `IGitService.pull(params: GitPullRequest): Promise<GitPullResult>`，`GitCliRepo.pull(workspacePath)` 同名。
- 失败通过异常抛出（`Error` 带 `code`），成功一律 resolve；「无更新」是成功结果（`updated: false`），不是错误。
- `detached-head` / `no-remote` / `no-upstream` 是**拉取前**的判定，属于预期内分支，用 `ensureRepositoryAvailable` 之外的显式判断给出，避免把「没有上游」误报成 Git 命令失败。
- 超时与输出上限单独放宽（`DEFAULT_GIT_PULL_TIMEOUT_MS` / `DEFAULT_GIT_PULL_OUTPUT_BYTES`）：拉取要等网络，且可能伴随 hooks。
- 拉取命令额外注入 `GIT_TERMINAL_PROMPT=0`：本进程 stdio 没有 tty，明确关掉 Git 自带的交互式账号提示，让认证失败变成可分类的快速失败而不是等待。

## 验收场景

1. 落后远端，点击拉取 → 拉取成功，弹窗展示拉取到的提交数与文件/行数，toast 同样带上这两项；关闭弹窗时仓库状态刷新，`behind` 归零。
2. 已经是最新，点击拉取 → `git pull` 成功但 HEAD 未变 → 弹窗与 toast 明确提示「已是最新版本」，不是静默关闭。
3. 干净 + `ahead = 0` + `behind > 0` → 入口仍显示，且**主按钮可点**，文案为「拉取」。
4. 工作区有未提交改动且有可提交文件 → 主按钮仍是提交；提交弹窗动作列表里可点「拉取」。
5. 干净 + `ahead > 0` + `behind > 0` → 主按钮是推送；推送弹窗底部可点「拉取」。
6. 分支没有上游分支 → 主按钮不会变成拉取；提交弹窗里的「拉取」项仍可点开，弹窗给出「没有上游分支，请先推送一次」的说明，确认按钮禁用。
7. 仓库没有任何 remote（或 remote 的 URL 指向非 Git 仓库）→ `no-remote` 文案。
8. 本地改动会被拉取覆盖 → `dirty-working-tree` 文案，提示先提交或暂存。
9. 拉取产生合并冲突 → `merge-conflict` 文案；**冲突未解决时再次拉取**（Git 报 `unmerged files`）仍是 `merge-conflict`，不是 `unknown`。关闭弹窗后刷新，冲突文件能被看到。
10. 上游分支在远端已被删除 → `upstream-branch-missing` 文案（提示重新推送重建或清除上游），不是 `unknown`。
11. 认证/权限失败 → `authentication-failed` 文案；网络不可达 → `network-error` 文案；命令超时 → `timeout` 文案。
12. 拉取进行中按钮显示 loading 且不可重复点击；失败后面板保留错误详情（含原始 Git 输出）并支持复制，且弹窗不会被拉取自身触发的刷新卸载。
13. 非 Git 仓库 / Git 不可用：拉取入口不可用或直接给出失败提示，不崩溃。
14. monorepo 子目录作为 workspace：拉取量的文件数按整仓口径统计（可包含工作区之外的文件），这是规则 10 的既定语义，不是缺陷。

## 已知限制

- 「拉取量」按 HEAD 差集计算：merge 策略下会把 merge 提交本身也计入提交数（比远端实际新增多 1）；`pull.rebase=true` 且本地有提交被重写时，提交数会包含被重写的本地提交。默认（快进或 merge）场景数字准确。
- 只做单分支的拉取，不支持指定 remote / 分支，也不做 `--prune`。拉取不会清理远端已删除分支留下的本地跟踪引用。
- `behind` 仍由 `git status` 的快照给出，拉取不会顺带刷新其它分支的跟踪引用。
