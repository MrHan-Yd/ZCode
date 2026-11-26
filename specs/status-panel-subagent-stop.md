# 状态面板运行中子智能体的停止入口

## 背景

「智能体」分区的行由会话投影 `snapshot.subagents.running[]` 驱动（子智能体目录投影），而 Stop 按钮过去只在行能按 `childSessionId` 匹配到一条 running 的 `backgroundWorks` 时才渲染。这条联接对经 Agent 工具执行器派发的后台子智能体成立，但对**直接进入 subagent port** 的启动不成立：

- 编排调度（`SubagentOrchestrationDispatchAdapter → subagentPort.start`）不经过 Agent 工具执行器，没有 `BackgroundTaskStarted`，`backgroundWorks` 里没有对应 work；
- 前台子智能体本来就不是后台任务，也不会产生 `BackgroundTaskStarted`（SendMessage 恢复的后台子智能体此前已在投影里单独补齐）。

结果是行在「运行中」，但看不到也点不到停止。用户只能停整个轮，无法停单个子智能体。

本次把 Stop 的可用性从「必须匹配到后台 work」改为「运行中的子智能体自身就带可停止身份」，并让运行时停止对前台/后台子智能体都安全。没有新增协议、RPC、持久化或第二份状态。

## 产品规则

1. **每个运行中的子智能体行都有 Stop**：`running / waiting / blocked` 三种运行态都可停止；行已经结束就不显示（行本来也会随投影消失）。
2. **停止身份**：
   1. 优先使用按唯一 `childSessionId` 精确匹配到的 running `backgroundWorks.workId`；
   2. 没有匹配时回退到该行自己的 `agentId`。这个等式是既有的运行时事实：`agentId ≡ runtime task registry taskId ≡ Agent 后台输出的 backgroundTaskId ≡ cancelBackgroundWork 的 workId`，不需要 UI 猜测。
   3. 两者都缺席（旧投影/冷恢复缺 `agentId`）时不显示 Stop——一个点了没反应的按钮比没有按钮更糟。
3. **不按标题或时间猜测**：同一 `childSessionId` 出现多条 running 子代理 work 时，仍按既有规则拒绝把它们当成同一条控制目标；但行自身的 `agentId` 是该子智能体的权威身份，照常可停。
4. **可停缺省**：`cancellable` 缺席即视为可停（`!== false`），与 Agent 行、Workflow 行一致，避免新字段缺席时按钮静默消失。
5. **唯一命令路径**：Stop 仍发既有的 v4 `cancelBackgroundWork { workId }`；不新增 `stopSubagent` 之类的第二条命令。所有入口（面板、composer 徽标、工作流详情页）共用同一实现。
   1. **终态判定以 registry 为准**：只要 runtime task registry 里还有该 `taskId`，`stopBackgroundTask` 是否「已终结」只看 registry。投影里的终态记录只用于 registry 完全查不到该任务的冷历史。否则 SendMessage 恢复（复用同一 `agentId`、只发 `SubagentSpawned(resumed)` 而不发新的 `BackgroundTaskStarted`）会让上一轮的终态记录把正在运行的重启 child 判成 already terminal，Stop 被拒绝而 child 继续跑。
6. **后台子智能体**（runtime task `isBackgrounded === true`）：沿用既有后台收口——写 stopped 产物、`BackgroundTaskCompleted`、`SubagentStopped(stopped)` 与父会话完成通知。
7. **前台子智能体**（`isBackgrounded === false`）：停止只中断该 child 的执行；**不**写后台 stopped 产物、**不**投递后台完成通知、**不**发 `BackgroundTaskCompleted`。终态、失败产物与 `SubagentStopped` 由跑它的前台执行路径自己写入（与用户按整轮 Stop 时该 child 的收口完全一致）。父轮的 Agent 工具调用以 `ToolCancelled` 结束，父轮继续运行。
8. **终态只信投影**：点击后 UI 不做本地乐观删除；行消失由 `SubagentStopped` → `snapshot.subagents.running` 驱动。
9. **失败如实保留**：命令被 core 拒绝（`not_found / not_running / cancel_not_supported`）时保留该行，只记录 `warn`；不回退成「已停止」，也不重试第二条路径。

## 状态所有者

- **child 的运行身份与前后台事实（唯一所有者）**：CLI runtime task registry（`RuntimeTaskSnapshot.agentId / isBackgrounded / status`）。UI 不根据时长、标题或 work 推导第二份前后台事实。
- **停止语义（唯一所有者）**：`SubagentPort.stopTask`（`apps/zcode-cli/packages/core/src/subagent/runner.ts`）。前台/后台分支只在 `stopTask` 内分派；`runtime.stopBackgroundTask` 只做 workId → taskType → `stopTask` 的路由。
- **停止句柄（唯一所有者）**：`packages/ui/src/v4/conversationStatusPanelModel.ts` 的 `buildConversationStatusPanelModel`。它产出 `runningSubagentWorks[].controlWorkId / cancellable`；组件只消费，不在渲染循环里再拼一次身份。
- **运行态投影（唯一所有者）**：`snapshot.subagents.running[]`（含 `agentId`）与 `snapshot.backgroundWorks`；都来自 CLI 事件归约。

## 事件顺序

```text
用户点击 Stop
  └─ UI: dispatchCommand("cancelBackgroundWork", { workId: controlWorkId })
       └─ CLI v4 handler → app.cancelBackgroundTask(workId)
            └─ runtime.stopBackgroundTask → runtimeTaskRegistry.get(workId)
                 ├ background child
                 │    └─ subagentPort.stopTask → finalizeBackgroundStopped
                 │         → BackgroundTaskCompleted + SubagentStopped(stopped) + 父通知
                 └ foreground child
                      └─ subagentPort.stopTask → abort(child)
                           → guardSubagentPromiseWithAbort 立即 reject
                           → 前台 catch 写失败产物 → registry=terminal → SubagentStopped(failed)
  └─ product-projection 归约 subagents.running / backgroundWorks
       └─ 面板行随投影消失（无本地乐观删除）
```

停止请求与子智能体自然结束并发时：registry 先进入终态的一方胜出；`stopTask` 对已终结任务返回原终态，不重复写产物、不重复通知（幂等边界沿用 runtime task registry 的终态判定）。

## 接口

无新增协议字段与命令。既有字段的语义在本 spec 固化：

```ts
// packages/shared/src/zcode-protocol-v4/snapshot.ts（既有）
interface RunningSubagentSummary {
  childSessionId: string;
  agentId?: string; // ≡ runtime taskId ≡ cancelBackgroundWork 的 workId
  status: "running" | "waiting" | "blocked";
  // ...
}

// packages/ui/src/v4/conversationStatusPanelModel.ts
interface ConversationStatusPanelRunningSubagent extends RunningSubagentSummary {
  /** 停止句柄：优先后台 work 的 workId，其次本行 agentId；都缺省即没有 Stop。 */
  controlWorkId?: string;
  cancellable?: boolean;
}
```

- `cancelBackgroundWork` / `app.cancelBackgroundTask` / `runtime.stopBackgroundTask` 的载荷与 ACK 不变。
- `SubagentPort.stopTask` 的返回值对前台任务可能是 `failed`（前台路径写入的终态）而不是 `cancelled`；调用方只依据「已离开 running」判断停止成功。

## 验收场景

1. **编排派发的子智能体**（无 `backgroundWorks`）：面板行出现 Stop；点击发 `cancelBackgroundWork { workId: agentId }`，随后行消失，编排步骤按取消接管。
2. **普通后台 Agent**（有 `backgroundWorks`）：使用 work 的 workId；work `cancellable === false` 时不显示 Stop。
3. **前台 Agent**（父轮正在等待工具结果）：Stop 只中断该 child；父轮收到 cancelled 的 Agent 工具结果并继续；不出现后台完成通知、不出现第二条 `BackgroundTaskCompleted`，子智能体行消失。
4. **已结束子智能体**：行上没有 Stop。
5. **缺少 agentId 且没有匹配 work**（旧投影 / 冷恢复）：不显示 Stop，不按标题或时间猜一个 workId。
6. **同一 childSessionId 有多条 running work**：不把任何一条 work 当成控制目标；行自身的 agentId 仍可停。
7. **命令被拒绝**：行保留，日志记录 `cancelBackgroundWork 被拒绝`，不做本地乐观更新。
8. **zh-CN / en-US**：可见文案「停止 / Stop」与可访问名称随 locale 变化；子智能体行的可访问名称说明停止的是子智能体，而不是通用后台任务。
9. **不回归**：Bash、Workflow、编排 run 级 Stop 的 workId 与收口路径不变；状态面板其余分区与 composer 徽标不受影响。
10. **恢复后的子智能体**：SendMessage 恢复的后台 child（同一 agentId，投影里仍留着上一轮终态记录）在运行中点击 Stop 会真正停止：命令 accepted，registry 进入终态，行消失；不能因投影终态被判成 already terminal 而只回 not_running。

## E2E 锚点

- Stop 按钮沿用 `TID_V4_BACKGROUND_WORK_CANCEL`（动态后缀为 `controlWorkId`）；回退到 `agentId` 时后缀就是该子智能体的 `agentId`。
- 行节点沿用 `data-background-task-kind="agent"`、`data-child-session-id`、`data-work-id`、`data-work-status`、`data-subagent-status`。
- 断言「没有 Stop」时用按钮节点缺席，而不是可见性；SSR / 无回调宿主同样不渲染按钮。

## 已知限制

- 前台子智能体的停止在父轮里表现为一次 `ToolCancelled` 工具结果，`SubagentStopped` 状态是 `failed`（与整轮 Stop 对该 child 的现有收口一致）；不为单个 child 引入新的「stopped」状态机。
- 旧版 CLI 若没有 `cancelBackgroundTask` 能力，Stop 会被 ACK 拒绝并保留该行；UI 不对此做降级猜测。
- 冷恢复的旧数据或 CLI 崩溃后遗留的 orphan running 行，`subagents.running[]` 里的 `agentId` 可能没有对应的 live registry 任务（legacy 冷种子甚至可能把 toolCallId 填进 `agentId`）。这类行会显示 Stop，但点击只会得到 not_found 的拒绝并保留该行。UI 目前没有 liveness 信号：运行态投影只说明「目录认为它在跑」，不说明「本进程能停它」。相对于为每条运行行隐藏停止入口（会让真实运行中的编排/前台 child 无法停止），这里选择保留可见 Stop 并如实记录拒绝。
- 本 spec 只覆盖「智能体」分区的运行中行。已结束目录（`SubagentDirectorySidePane`）不提供停止，历史行没有可停止的执行。
