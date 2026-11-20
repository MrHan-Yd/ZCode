# 会话时间线：编排子智能体复用 Agent 工具行

> 状态：已实现（2026-11-20），待桌面手工 E2E 验收。
>
> 范围：`packages/ui` 会话时间线中“编排派发的子智能体行”的展示方式。
>
> 不涉及：协议、RPC、CLI 投影、持久化、虚拟行。
>
> 取代：`specs/orchestrator-mode.md` Phase 5.7 中“未配对 subagent 行渲染为 Agent 卡片（`SubagentAgentCard`）”的呈现方式。投影来源、`parentToolCallId` 关联规则与状态面板编排分区均不变。

## 1. 背景与现状

会话时间线里有两条子智能体渲染路径：

1. **手动 Agent 工具调用**：模型发出 `Agent` / `Task` 工具行，`SubagentSpawned` 生成 `subagent` 行；`buildAssistantWorkRenderItems` 按 `parentToolCallId` 把两者配对为 `agentToolCall`，由 `ConversationAgentToolCallRow` 交给 `ToolCallBlock` 的 Agent 渲染器（`ToolCallBlocks/renderers/agent.tsx`）渲染。
2. **编排派发**：dispatcher 直接启动 child，`subagent` 行的 `parentToolCallId` 是 attempt key，不会与任何 `Agent` / `Task` 工具行配对；该行走 `ConversationRowView` 的 `subagent` 分支，由 `SubagentRowView` 渲染自定义卡片 `SubagentAgentCard`。

两条路径的 kind 标签、角色名、标题、状态词汇与“打开子会话”交互不一致，用户明确要求：编排子智能体在时间线里**就是原来手动调用子代理的那一行**，详细内容放到状态面板的「编排计划」分区。

## 2. 产品规则

1. **复用 Agent 工具行**：编排派发的子智能体在会话时间线中必须复用**手动 Agent 工具调用**的展示：同一个 `ToolCallBlock` 与 Agent 渲染器、同样的 kind 标签、角色名、标题、状态和“打开子会话”动作。不得再使用自定义 `SubagentAgentCard` 卡片。
2. **合成 Agent 工具节点**：`subagent` 行在 renderer 内合成一个旧 `ToolCallBlock` 可消费的 Agent 工具节点，字段映射见第 3 节。合成只发生在渲染派生层，不写入协议、不写回投影。
3. **打开子会话一致**：Agent 摘要动作仍是 `agentSummaryAction -> context.onOpenSubagentSession`，测试锚点沿用 `TID_V4_SUBAGENT_OPEN_SIDE_PANE`，并把 `subagentType` 作为 `authoritativeAgentType` 传入渲染器。
4. **细节留在状态面板**：stepId、角色、依赖、尝试次数、步骤状态、耗时、停止/重排、步骤错误等详细编排信息保留在状态面板的「编排计划」分区；会话时间线不重复这些细节，只保留 Agent 工具行的既有摘要（kind 标签 + 角色名 + 标题 + 状态 + 打开子会话）。
5. **零协议增量**：不新增协议字段、RPC 命令、持久化结构或虚拟行。`subagent` 行仍由 `SubagentSpawned` / `SubagentStopped` 投影驱动，配对算法（`pairSubagentRows`）不变。
6. **保留行锚点**：行包装层保留 `data-subagent-child-session-id`、`data-subagent-status`；行 test id 仍是既有 `TID_V4_ROW`（`v4-row-<rowId>`），且只出现一次。

## 3. 合成 Agent 工具节点映射

`SubagentRowView` 从 `SubagentRow` 派生一个 `TaskChatToolCallTreeNode`（`childToolCalls` 为空），形状与 `toolCallRowToLegacyNode` 的输出一致，供 `ToolCallBlock` 直接消费。建议用 `useMemo` 按 `row` 派生，不缓存到 store。

| 目标字段                                                             | 来源 / 值                                                                                                                                                   |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolCall.toolId`                                                    | `subagent:${row.childSessionId}`；`childSessionId` 缺失时回落 `subagent:${row.rowId}`（renderer 内稳定唯一键，不是协议 id）                                 |
| `toolCall.toolName`                                                  | `"Agent"`                                                                                                                                                   |
| `toolCall.kind`                                                      | `"Agent"`                                                                                                                                                   |
| `toolCall.input.description`                                         | `row.summaryText`                                                                                                                                           |
| `toolCall.input.subagent_type`                                       | `row.subagentType`                                                                                                                                          |
| `toolCall.status`                                                    | `running → in_progress`、`success → completed`、`failed → failed`、`cancelled → stopped`                                                                    |
| `toolCall.startedAt`                                                 | 透传 `row.startedAt`（缺席即 `undefined`）                                                                                                                  |
| `toolCall.title`                                                     | 不设置。让 `getAgentPrimaryText` 走 `input.description → input.subagent_type` 的既有回落                                                                    |
| `toolCall.output` / `content` / `error` / `display` / `snapshotRefs` | 一律不伪造，保持缺席                                                                                                                                        |
| `toolCall.raw`                                                       | `{ inputPreviewComplete: true, v4Status: row.status }`，与 `toolCallRowAdapter` 的 v4 行约定一致；不写 `error`、`rawOutput`、`display`、`status` 等伪造字段 |
| `childToolCalls`                                                     | `[]`                                                                                                                                                        |

派生后的可见结果必须与手动 Agent 行一致：

- **标题（primaryText）**：`row.summaryText`；为空时按 `getAgentPrimaryText` 回落到 `row.subagentType`，与手动行同一解析器。
- **kind 标签**：Agent 渲染器的 `chat.toolCall.agent.fallback`（中文“子智能体”，英文“SubAgent”）。
- **角色名**：`getAgentKindLabel(toolCall, "", authoritativeAgentType)`，其中 `authoritativeAgentType = row.subagentType`。不额外调用 `resolveSubagentDisplayName`，保证与手动行逐字一致。
- **状态词**：合成节点的 `toolCall.status` 仍按旧状态词表映射——`running → in_progress`、`success → completed`、`failed → failed`、`cancelled → stopped`——但**复用 Agent 渲染器的既有可见性**：Agent 工具行只在失败时显示状态词，因此时间线行仅在 `failed` 时出现「执行失败 / Failed」，`running` / `success` / `cancelled` 不显示状态词。这是有意复用，不为编排行新增状态标签。
- **摘要形态**：Agent 渲染器固定 `canToggle=false`；存在打开动作时整行摘要即动作入口，不存在动作时也不可展开。`childToolCalls` 为空、`output` / `content` 缺席，因此展开区不会出现伪造的活动内容或子工具。

状态映射与行锚点的事实分工：

- `data-subagent-status` 始终写投影原值（`running | success | failed | cancelled`），用于断言投影事实。
- 可见状态词只在 `failed` 时出现（「执行失败 / Failed」），其来源是 `ToolCallBlock` 的旧状态词表；运行中 / 已完成 / 已停止不显示状态词，与手动 Agent 行逐字一致。
- 两者不要求字面相同，但同一行的映射必须稳定。

## 4. 打开子会话动作

与 `ConversationAgentToolCallRow` 完全一致：

- 仅在 `row.childSessionId`、`context.sessionId`、`context.onOpenSubagentSession` 三者都存在时提供动作。
- `agentSummaryAction`：
  - `testId = testId(TID_V4_SUBAGENT_OPEN_SIDE_PANE, childSessionId)`（即 `v4-subagent-open-side-pane-<childSessionId>`）。
  - `onActivate` 调用 `context.onOpenSubagentSession({ rootSessionId: context.rootSessionId ?? parentSessionId, parentSessionId, childSessionId, subagentType, title })`。
  - `title` 取合成节点的 `getAgentPrimaryText(toolCall, "")`，与摘要行可见标题一致。
- 遥测与手动行一致：`runUserAction` 的 `featureId: "conversation.subagent"`、`action: "open_side_pane"`、`trigger: "button"`、`completed.resultSource: "local_commit"`、`failureStage: "subagent_open"`。
- 动作缺席时（无 `childSessionId` 或无宿主回调）不渲染任何“查看子会话/Open session”按钮，也不得退化成可展开卡片。
- `authoritativeAgentType = row.subagentType` 与 `agentSummaryAction` 同时传给 `ToolCallBlock`。

## 5. 详细信息的归属

「编排计划」分区（`ConversationStatusPanel` 的 `OrchestrationStatusSection`）继续是编排细节的唯一展示处，内容与锚点不变：

- run 头：`planId · rN`、run 状态、`完成 X/Y · N 运行中`、停止、重排。
- 步骤行：`data-orchestration-step-id`、`data-step-status`、状态词、标题、角色、等待依赖、重试次数、耗时、错误、查看子会话。
- 步骤行的状态图标与「进程」分区同一套语言：运行中 `→`、待执行 `○`、已完成 `✓` 且标题删除线、失败 `✕`、取消/阻塞 `⊘`；不使用旋转加载图标（2026-11-20 修订）。

会话时间线只保留 Agent 工具行摘要；以下内容**不得**出现在时间线行内：stepId、依赖、尝试次数、步骤级耗时、run 级进度、停止/重排按钮、步骤错误详情。时间线行也不显示耗时（手动 Agent 行同样不显示）。

## 6. 所有权与事件顺序

```text
CLI 投影
  SubagentSpawned / SubagentStopped
    → subagent row（parentToolCallId = attempt key，不与 Agent/Task 工具行配对）
    → 既有 snapshot / 行流，无新增协议

UI 渲染派生
  buildAssistantWorkRenderItems（配对算法不变）
    → 未 claim 的 subagent row 仍走 ConversationRowView 的 "subagent" 分支
    → SubagentRowView
        ├─ 合成 Agent 工具节点（renderer-local useMemo，不写 store）
        └─ ToolCallBlock(Agent renderer)
             ├─ kind 标签 / 角色名 / 标题 / 状态（与手动 Agent 行同源）
             └─ agentSummaryAction → context.onOpenSubagentSession

状态面板（并行只读）
  orchestrationState 只读投影
    → ConversationStatusPanel「编排计划」分区
    → 步骤细节 / 进度 / 停止 / 重排 / 查看子会话
```

- 时间线行不是第二事实源：节点全部由 `subagent` 行纯派生，投影更新即重算。
- 状态面板也不持有 run 状态；两处共享同一个只读投影，职责按“摘要 vs 细节”划分。

## 7. 组件改动范围

- `packages/ui/src/v4/ConversationRowView.tsx`：`SubagentRowView` 改为构造合成 Agent 节点并渲染 `ToolCallBlock`，保留行包装层锚点与 `RowShell`。
- 删除 `packages/ui/src/v4/SubagentAgentCard.tsx` 及所有引用/导入。
- 删除 `packages/ui/test/subagentRowViewRender.test.ts`（直接渲染旧卡片）；新增 `packages/ui/test/subagentRowAdapter.test.ts` 覆盖合成节点映射。
- 状态映射与节点构造抽成同目录纯函数 `packages/ui/src/v4/subagentRowAdapter.ts`；不新增跨包公开入口。

**不改动**：`packages/shared/src/zcode-protocol-v4/rows.ts`、`SubagentRow` schema、`conversationAssistantWorkItems.ts` 的配对逻辑、状态面板编排分区、CLI/Host/协议。

## 8. 验收场景与 E2E 锚点

### 场景 1：手动 Agent 行与编排子智能体行一致

同一会话内准备一次手动 `Agent` 工具调用和一次编排派发（步骤 child 无对应 Agent 工具行）：

- 两行都由 `ToolCallBlock` 渲染，均含 `data-testid="chat-tool-call-block"`（既有工具卡锚点）。
- 两行的 kind 标签、角色名、标题、状态词形态一致；编排行的标题等于 `summaryText`，角色名等于 `subagentType`。
- 两行都不出现 `frontend · running` 这类调试摘要，也不出现自定义卡片结构。
- 包装层都不额外增加水平内边距，左对齐一致。

### 场景 2：四种状态映射正确

用四份 `subagent` 投影分别置为 `running`、`success`、`failed`、`cancelled`：

| 投影状态    | 合成 `toolCall.status` | Agent 行可见状态词（zh / en） | 包装层 `data-subagent-status` |
| ----------- | ---------------------- | ----------------------------- | ----------------------------- |
| `running`   | `in_progress`          | 无（运行态不显示状态词）      | `running`                     |
| `success`   | `completed`            | 无（完成态不显示状态词）      | `success`                     |
| `failed`    | `failed`               | 执行失败 / Failed             | `failed`                      |
| `cancelled` | `stopped`              | 无（停止态不显示状态词）      | `cancelled`                   |

- 每行 `data-subagent-status` 仍分别为 `running` / `success` / `failed` / `cancelled`。
- 可见状态词只在 `failed` 时出现；该行为与手动 Agent 行一致，不是编排行专用逻辑。
- 失败行不显示伪造的错误详情；真实错误只出现在状态面板步骤行。

### 场景 3：打开子会话可用

- 有 `childSessionId` 且宿主注入 `onOpenSubagentSession` 时，点击摘要行触发一次 `onOpenSubagentSession`，参数 `parentSessionId`、`childSessionId`、`subagentType`、`title` 正确，`rootSessionId` 按 `context.rootSessionId ?? parentSessionId` 解析。
- 点击目标的选择器：`[data-testid="v4-subagent-open-side-pane-<childSessionId>"]`。
- 该动作的 DOM 位置与手动 Agent 行的摘要动作一致（`ToolSummaryRow` 的 action 区域），不是卡片内独立按钮。
- 无 `childSessionId` 或无回调时：动作缺席，行不可展开，无空按钮、无占位。

### 场景 4：状态面板编排计划仍完整

- 存在活动 run 时展开状态面板「编排计划」分区。
- run 头仍显示 `planId · rN`、run 状态、进度与停止/重排。
- 步骤行仍显示状态、标题、角色、等待依赖、尝试次数、耗时、错误与查看子会话。
- 对比时间线行：上述细节只出现在面板，不进入 Agent 工具行。

### 场景 5：无自定义卡片残留

- 代码层：不存在 `SubagentAgentCard` 文件、导入或测试引用。
- DOM 层：时间线编排行不出现自定义卡片的结构特征（例如卡片式 `BotIcon` + 独立按钮容器）；只存在 Agent 工具行结构。
- `data-subagent-name` 不再由时间线行输出；状态面板子智能体行仍保留自己的 `data-subagent-name`，两者不混淆。

### 场景 6：中英文文案正常

- 中文：kind 标签“子智能体”，失败行状态词「执行失败」，`aria-label`/tooltip 为“在右侧打开”等既有 Agent 行文案。
- 英文：kind 标签“SubAgent”，失败行状态词 “Failed”，`aria-label`/tooltip 为 “Open on the right”。
- 中英文下角色名、标题不出现原始 i18n key（例如 `chat.toolCall.agent.fallback`），也不出现 `undefined` 文案。

## 9. E2E 锚点清单

- 会话行：`[data-row-id="<rowId>"]`，`[data-testid="v4-row-<rowId>"]`（唯一）。
- 子代理投影事实：`[data-subagent-status="running|success|failed|cancelled"]`、`[data-subagent-child-session-id="<id>"]`。
- 工具卡：`[data-testid="chat-tool-call-block"]`。
- 打开子会话动作：`[data-testid="v4-subagent-open-side-pane-<childSessionId>"]`。
- 状态面板：`[data-status-section="orchestration"]`、`[data-orchestration-run-id]`、`[data-orchestration-run-status]`、`[data-orchestration-step-id]`、`[data-step-status]`。
- 选择功能一致性：包装层 `data-conversation-selectable="true"`，与手动 Agent 行相同。

## 10. 测试与验证要求

- 纯函数测试（`packages/ui/test/subagentRowAdapter.test.ts`）：
  - 四种投影状态到旧状态词表的映射。
  - `summaryText` 为空时 primaryText 回落到 `subagentType`。
  - 合成节点不包含 `output` / `content` / `error` / `display` / `childToolCalls`。
  - `raw` 仅包含 `inputPreviewComplete: true` 与 `v4Status`（投影原值）。
  - `toolId` 优先 `childSessionId`、缺失时回落 `rowId`；`startedAt` 只在存在时透传。
- 渲染测试：旧 `subagentRowViewRender.test.ts` 已删除（`tsx` 环境无法加载 `.png/.svg`）；「有/无 `childSessionId` 时动作出现/缺席」由后续桌面 E2E 或隔离浏览器渲染测试覆盖，不作为本轮单测门禁。
- 类型检查与 Lint：改动文件通过 `pnpm typecheck` 与 `pnpm lint`；如实报告既有失败。

## 11. 不在范围

- 不修改 `subagent` 协议 schema、事件投影、配对算法或 `parentToolCallId` 语义。
- 不把编排 run/step 状态并入时间线行，也不新增时间线行类型。
- 不改变状态面板编排分区的数据来源、折叠规则、停止/重排行为。
- 不改变手动 Agent 工具行现有渲染与交互。
- 不处理手机端专用布局：手机与桌面共用同一 `SubagentRowView` 与打开子会话回调。

## 12. 实现与验证记录（2026-11-20）

- 实现文件：`packages/ui/src/v4/subagentRowAdapter.ts`、`packages/ui/src/v4/ConversationRowView.tsx`（`SubagentRowView`）；删除 `packages/ui/src/v4/SubagentAgentCard.tsx` 与 `packages/ui/test/subagentRowViewRender.test.ts`。
- 定向测试：`packages/ui/test/subagentRowAdapter.test.ts` 6 项映射测试；展示相关 8 个测试文件合计 50/50 通过。
- 类型与格式：`pnpm exec tsc -b packages/ui --force` 通过；改动文件格式检查通过。
- 未执行：完整 Electron / 真实编排 E2E；时间线与手动 Agent 行的目视一致性、打开子会话动作仍待 `pnpm dev:desktop` 手工验收。
