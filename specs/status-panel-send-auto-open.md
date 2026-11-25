# 发送消息后自动打开会话状态面板

## 范围

用户发送消息后，当前会话有未完成内容时自动打开既有会话状态面板，省去再次点击标题栏图标。沿用 `specs/status-panel-git-tools-split.md` 的面板、标题栏入口、关闭按钮和 Git 浮层互斥规则，不新增弹窗、设置项、RPC 或持久化字段。

## 产品规则

1. **只由成功接纳的本地发送触发**：Enter 与发送按钮走同一条 Composer 提交路径。在 `sendText`、带 `firstInput` 的 `createSession` 或新目标 `sendGoalCommand` 返回 `accepted` 后，为本次发送保留一次自动打开机会。普通发送、运行中排队、guide 和立即发送使用相同规则。
2. **发送成功时已有未完成内容**：立即打开当前会话的状态面板，并展开有未完成内容的对应分区；不折叠其他分区，不导航详情页，不抢输入框焦点。
3. **发送成功时没有未完成内容**：先不打开空面板。如果同一会话随后投影出未完成待办或活动工作，则补弹一次；不使用定时等待、轮询或模拟任务状态。
4. **每次发送最多一次**：自动打开前先消耗该次机会。后续进度、状态词、流式文本、计数和时长更新不能再次打开或强制展开分区。再次成功发送可以获得新的一次机会。
5. **显式操作优先**：从本次提交开始，用户主动操作任一面板入口、关闭状态面板或打开 Git 浮层，都取代尚未消费的自动打开意图。即使操作发生在发送 ACK 返回之前，旧 ACK 或稍后到达的内容也不能重新顶开面板。自动打开后手动关闭同样不会被本次发送的更新重开。Composer 后台徽标的单工作流详情直达也是显式入口：先取消本 pane 的自动意图，仍直接打开原详情，不额外关闭或打开状态面板。
6. **全部完成不触发**：仅有 `4/4` 一类已完成 Todo、历史会话计划或已结束智能体/工作流目录时，不自动打开。已经自动打开的面板在工作完成时继续保留，便于查看结果；不新增自动关闭规则。
7. **只作用于发送所在的可见、focused、可编辑 pane**：只读详情、隐藏页签和非 focused pane 不自动打开。切换会话、workspace identity、远程 attachment 或失去可见/focused 状态时废弃旧意图；返回旧会话不复活。草稿首发在 `accepted` 后绑定到实际创建/预热提升的 session，再由匹配该 session 的投影决定是否打开。
8. **拒绝与控制命令不触发**：`blocked`、确认待定、rejected/stale/failed/noop、网络结果未知、仅创建空会话、模式切换、空 `/plan`、`/compact`、恢复已有 Goal 及其他非消息操作都不补发自动打开机会。相同 commandId 的重复确认不重置已消费机会。

## 未完成内容口径

判断复用 `buildConversationStatusPanelModel` 的只读结果，不用 `hasStatusContent` 判断：该字段也包含可回看的历史内容。

| 分区         | 自动打开条件                                                               |
| ------------ | -------------------------------------------------------------------------- |
| Goal         | 当前状态为 `active`、`verifying` 或 `notSatisfied`                         |
| 进程（Todo） | 至少一项为 `pending` 或 `inProgress`（模型的 `waitingCount > 0`）          |
| 终端         | 模型中有 `runningBashWorks`                                                |
| 工作流       | 模型中有 `runningWorkflowRuns`（`pending`/`running` 与既有精确身份降级行） |
| 编排         | 模型中有 `activeOrchestrationRuns`                                         |
| 智能体       | 模型中有 `runningSubagentWorks`，包含 `running`、`waiting`、`blocked`      |

`verified`、`paused`、`failed` Goal 本身不触发；历史 `ExitPlanMode` 计划和已结束目录不触发。后台工作与子智能体的身份联接仍由现有模型负责，不新增按标题、路径或时间猜测。

## 状态所有者与接口

- **业务事实**：CLI/runtime 及当前会话投影；Renderer 不新增任务队列、计数缓存或运行状态。
- **面板打开状态**：现有 `statusPanelOverlayStore`，仍只有一条 `{ sessionId, open }`。
- **显式 UI 操作代次**：同一 overlay store 的单调意图 revision；toggle/open/close/reset 记录操作，读取 revision 不订阅或写业务事实。Git reset 即使面板本来为空，也使旧自动意图失效。
- **每次发送的机会与 stale 防护**：每个 `SessionPane` 的 `useStatusPanelSendAutoOpen` 持有一个纯门控对象，只保存提交 ticket、发送来源 scope、accepted commandId、目标 session 和消费标记；不保存未完成内容副本。
- **分区折叠状态**：仍是 pane-local；Goal、进程、终端、工作流、编排、智能体分别控制。自动打开只展开本次判断为未完成的分区，消费以后不干预用户折叠操作。
- **唯一打开路径**：门控允许后调用现有 `openStatusPanelOverlay(sessionId)`，shell 收到原 `subscribeStatusPanelOpened` 通知后收起 Git 浮层。保留手动徽标的单工作流详情直达，不把该直达规则用于自动打开。

作用域 key 使用 `workspaceIdentity?.trim() || workspacePath`，再关联 `remoteSessionId` 与 `sessionId`。scope 切换使提交 ticket 失效，防止切走再返回后旧 ACK 获得新机会；草稿只有已确认目标 session 的单向提升例外。无预热的新 Goal 首发沿用已有“先创建空会话、绑定 pane、再提交目标消息”的顺序：空创建成功后可先为该 ticket 记录明确路由目标，以允许这次单向绑定，但空创建本身不创建自动打开机会，仍须等目标消息的 accepted。分区的会话切换重置先于自动展开执行，不能把同帧首发活动的自动展开覆盖掉。

```text
用户提交（Enter / 发送按钮）
  → pane-local ticket：冻结 scope 与显式 UI 操作代次
  → 现有配置屏障 → Host owner/lease 路由 → CommandInbox admission
  → accepted ACK（commandId + 实际目标 session）
       ├─ 原 scope 已离开 / 用户显式操作 / 重复确认：废弃自动意图
       └─ 当前 pane 的一次性自动意图
            ├─ 无未完成内容：等待现有投影更新
            └─ 未完成内容 + 匹配 session + 可见 focused pane
                 → 先消费机会 → 展开对应分区 → openStatusPanelOverlay
                      → shell 收起 Git 浮层 → 既有面板显示

Desktop：desktop-continuous 在线投影 ──┐
                                       ├─ 同一个 CLI owner、同一个只读模型与 UI 门控
手机：web-remote-replayable 恢复投影 ───┘
```

手机客户端自己的成功发送可以触发；桌面发送或纯重连恢复本身不为手机创建新的机会。重放内容只能消费该客户端已经保留且尚有效的一次性意图，不能重放发送动作。CLI command admission、队列、owner/lease、序号与 stale run 规则均不变。

## 验收场景

1. 当前有 `pending`/`inProgress` Todo，面板关闭；成功发送后面板出现，进程分区展开。
2. 仅有全部完成 Todo；成功发送后面板仍关闭。随后新 Todo 出现时补弹一次。
3. 发送成功时无待办/活动工作；模型稍后创建 Todo 或启动智能体时自动打开，不显示空态窗口。
4. 智能体分别为 running/waiting/blocked；成功发送后智能体分区展开；只剩已结束目录时不打开。
5. 同时存在待办、终端、工作流、活动编排、Goal；展开各未完成分区，内容/停止/目录入口与既有面板一致。
6. 自动打开后关闭、折叠或打开 Git；多次进度与文本刷新不会重开，也不会强制展开已折叠分区；下一次成功发送可再次打开。
7. 等待 ACK 时手动打开再关闭状态面板，或在没有状态面板时打开 Git；ACK 和后续内容不能重新打开状态面板。
8. 每次发送最多一次，相同 commandId 重复确认无第二次机会；面板原本打开时不产生重复打开通知。
9. rejected、确认待定、网络错误和空 `/plan` 不触发；`sendGoalCommand` 的 accepted 可以触发，`/compact`/恢复 Goal 等控制命令不触发。
10. 排队、guide 和立即发送的 accepted 都可触发，仍使用原 admission 与草稿清理语义。
11. 草稿预热提升与无预热 `createSession(firstInput)` 首发，绑定后新待办出现时自动打开；创建空会话本身不打开。
12. 发送中切到别的会话、同路径不同远程 identity、不同 attachment、隐藏/focus 切换；旧 ACK/旧投影不能打开新 pane；切走再返回不复活旧 ticket。
13. Desktop continuous 与手机 replayable 各验证一次发送及延迟内容；手机故意缺帧后通过原 same-sub recovery 恢复，仍最多弹一次。
14. 不抢输入焦点、不改变正文列宽；中英文、浅色/深色、桌面和窄屏的现有布局不变。

## 正式验证入口

- 纯门控与未完成判定：`packages/ui/test/statusPanelSendAutoOpen.test.ts`。
- 既有 overlay 及 UI 操作代次：`packages/ui/test/statusPanelOverlayStore.test.ts`。
- 真实 SessionPane / Composer 浏览器交互：`packages/ui/test/statusPanelSendAutoOpen.browser.test.ts`。`test/fixtures/statusPanelSendAutoOpenFixture.tsx` 只装配真实组件；Data / Transport / Actions / Scenarios / LifecycleScenarios 按职责分拆，均为正式测试且单文件不超过 400 行。只连接本地虚构服务，不启动真实 Agent，不提交真实用户数据。
- 浏览器矩阵在 Desktop continuous 与手机 replayable 各覆盖 24 个场景，包括普通发送、排队、guide、StrictMode、预热首发、无预热 `firstInput`、无预热新 Goal 和单工作流详情直达；两种交付语义共用同一份 UI 门控断言。
- 新测试和 fixture 纳入 `packages/ui/tsconfig.test.json`，执行入口纳入 `pnpm test:desktop-regressions`。
- 必跑 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；改动文件单独格式检查。
