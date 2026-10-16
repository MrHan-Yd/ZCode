# 状态面板运行中子智能体的名字

## 背景

状态面板「智能体」分区里，运行中的子智能体行只有任务标题（Agent 工具调用的 `description`）、时长与速度。标题回答的是「这次让它干什么」，不是「它是谁」：面板上扫一眼，看不出跑着的是 `backend-developer`、`code-reviewer` 还是 `Explore`。同一个名字在会话里其实已经出现过一次——Agent 工具行显示的就是它——但面板这一行没有。

本次把子智能体名补进这一行。名字是 runtime 已经报出的事实（`SubagentSpawned.agentType` → `snapshot.subagents.running[].subagentType`），没有新增协议、没有新增取数、没有新增持久化。

## 产品规则

1. **显示位置**：运行中子智能体行的信息行（标题之下那一行）里，排在时长之前——行内各项靠间距分隔（这一行没有 `·`），读作 `backend-developer  已运行 4 分 31 秒  201 tok/s  ■ 停止`。与 Stop 按钮同一行簇，容器已有 `flex-wrap`，窄面板下整段换行而不是挤掉 Stop。

2. **原样显示**：名字是用户/模型选定的子智能体名（`backend-developer`、`code-reviewer`、`general-purpose`、`Explore`…），照抄不改写、不本地化——它是标识符不是文案，本地化它等于改用户/模型说的话。因此它与同一会话里 Agent 工具行显示的名字逐字相同。

3. **没有名字就不显示**：`subagentType` 缺失、只有空白，或等于投影哨兵值 `subagent`（payload 缺 `agentType` 时 `product-projection` / `transcript-hydration` 落的兜底）时，整段不渲染。此时行与本次改动之前逐字相同：标题 + 时长 [+ 速度] [+ 停止]。理由：行的图标已经说明「这是子智能体」，再写一遍哨兵只是噪声；而 `subagent` 不是任何人的名字。

4. **只读展示**：名字不参与打开详情、停止、计数、目录入口中的任何一个判定。行仍然是「整行可点开子会话 + 独立的 Stop 按钮」这套既有交互。

5. **收起态不变**：分区收起时 trailing 仍然只有「运行最久的那个」的时长 · 速度 · 运行数，不显示名字——收起态是「一眼看总量」，不是「认人」。

6. **不新增取数**：名字随 `runningSubagents` 投影一起到达，不新增 RPC、不轮询、不缓存、不进 store。

## 状态所有者

- **事实（唯一所有者）**：CLI 会话投影 `snapshot.subagents.running[].subagentType`。来源是子智能体启动事件 `SubagentSpawned.agentType`（`core/src/subagent/runner.ts` 发出，取该次 Agent 工具调用请求的 `agentType`）；cold hydration 在字段缺失时落 `subagent` 哨兵。UI 不派生第二份身份。
- **显示策略（唯一所有者）**：`packages/ui/src/lib/subagentName.ts` 的 `resolveSubagentDisplayName`。面板不自己判哨兵、不自己 trim，避免两处各写一遍「什么算名字」。
- **渲染**：`packages/ui/src/v4/ConversationStatusPanel.tsx` 的 `SubagentStatusSection` 行。名字只活在这一次渲染里，不写回、不持久化。

## 接口

```ts
// packages/ui/src/lib/subagentName.ts
/** payload 缺 agentType 时投影落的兜底值；它不是任何子智能体的名字。 */
export const SUBAGENT_UNNAMED_TYPE = "subagent";
/** 子智能体显示名：不是名字（空 / 只有空白 / 哨兵）时返回 undefined，调用方整段不渲染。 */
export function resolveSubagentDisplayName(subagentType: string | undefined): string | undefined;
```

无协议、无 RPC、无持久化改动；`subagentType` 早已在 `runningSubagentSummarySchema` 里。

## 验收场景

1. 跑一个 `backend-developer` 子智能体：面板行出现 `backend-developer`，与同一会话里 Agent 工具行显示的名字逐字相同。
2. 名字缺失（旧事件、投影兜底落 `subagent`）：行上不出现名字，也不出现 `subagent`，其余部分（标题、时长、速度、停止）照常。
3. 名字很长（用户自定义的长名）：行内截断（`max-w-40`），不撑破面板宽度，也不把时长/Stop 挤出这一行。这一行整体 `pointer-events-none`（整行点击由透明按钮承接），所以不给 `title` 提示——完整名字在打开的子会话页签上。
4. 同时跑多个子智能体：每行显示各自的名字，行之间靠名字 + 标题区分。
5. zh-CN / en-US：名字不随 locale 变化；时长、速度、停止的文案照旧随 locale 变化。
6. 子智能体结束：行消失，名字随之消失，不残留上一次的值。
7. 收起「智能体」分区：trailing 只有时长 · 速度 · 运行数，不出现名字。

## E2E 锚点

- 名字节点：`data-subagent-name="<name>"`（节点缺席即该行没有名字）。
- 行本身沿用既有锚点：`data-background-task-kind="agent"`、`data-child-session-id`、`data-work-id`。

## 已知限制

- 名字是**执行器类型**，不是这一次任务：同名并发多条时，行之间仍只能靠标题区分（与会话里的 Agent 工具行一致）。
- 名字只是展示，不参与权限、模型或工具范围；改名不影响任何运行决策。
- 本次只改运行中的行。「已结束的智能体」目录行（`SubagentDirectorySidePane`）不改：它列的是历史而不是「谁在跑」，需要时另立规则。
- 工作流子智能体不出现在这个分区（它们不走 `SubagentSpawned`，因此不在 `runningSubagents` 里），所以这里也看不到它们的名字。
