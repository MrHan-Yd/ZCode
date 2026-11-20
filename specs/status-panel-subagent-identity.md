# 状态面板运行中子智能体的身份与状态

## 背景

状态面板「智能体」分区里，运行中的子智能体行过去只有任务标题（Agent 工具调用的 `description`）、时长与速度。两个信息缺口：

1. **身份**：标题回答的是「这次让它干什么」，不是「它是谁」：面板上扫一眼，看不出跑着的是 `backend-developer`、`code-reviewer` 还是 `Explore`。同一个名字在会话里其实已经出现过一次——Agent 工具行显示的就是它——但面板这一行没有。
2. **状态**：`snapshot.subagents.running[].status` 已经区分 `running / waiting / blocked`，但面板行把它们一律画成同一行，也按同一组排序。用户看不出「谁在跑、谁在等、谁被阻塞」。

本次把子智能体名与状态一起补进这一行。名字是 runtime 已经报出的事实（`SubagentSpawned.agentType` → `snapshot.subagents.running[].subagentType`），状态是 runtime 已经报出的事实（`snapshot.subagents.running[].status`）；没有新增协议、没有新增取数、没有新增持久化。速度仍使用既有的 `session/performanceBatch` 累计平均（见 `specs/session-performance-stats.md` 规则 7）。

## 产品规则

1. **行布局**：运行中子智能体行用状态图标引导，与「进程」分区同一套图标语言：

   ```text
   [状态图标] 标题
              [状态词] [角色名] [时长] [TPS] [Stop]
   ```

   读作 `→ 更新入口 / 运行中  backend-developer  4 分 31 秒  201 tok/s  ■ 停止`。标题之下的信息行各项靠间距分隔（这一行没有 `·`），与 Stop 按钮同一行簇；容器已有 `flex-wrap`，窄面板下整段换行而不是挤掉 Stop。

2. **状态图标与状态词表达同一事实**，不允许只靠颜色或图标表达状态：

   | status    | 图标                     | 状态词     | 颜色                                      |
   | --------- | ------------------------ | ---------- | ----------------------------------------- |
   | `running` | `ArrowRightIcon`（静态） | 「运行中」 | 图标 `foreground`；状态词 `text-warning`  |
   | `waiting` | `CircleIcon`             | 「等待」   | `text-[var(--color-foreground-subtlest)]` |
   | `blocked` | `CircleSlashIcon`        | 「阻塞」   | `text-[var(--color-destructive)]`         |
   - 图标与「进程」分区一致：进行中用 `→`、待执行用 `○`、不可继续用 `⊘`；运行中**不使用旋转加载图标**，静态箭头即可表达「当前项」。
   - 状态图标前置在行首，状态词仍在信息行保留；状态词随 locale 变化，图标是语义装饰，`aria-hidden`，可读文本由状态词承担。

3. **原样显示名字**：名字是用户/模型选定的子智能体名（`backend-developer`、`code-reviewer`、`general-purpose`、`Explore`…），照抄不改写、不本地化——它是标识符不是文案，本地化它等于改用户/模型说的话。因此它与同一会话里 Agent 工具行显示的名字逐字相同。

4. **没有名字就不显示**：`subagentType` 缺失、只有空白，或等于投影哨兵值 `subagent`（payload 缺 `agentType` 时 `product-projection` / `transcript-hydration` 落的兜底）时，名字整段不渲染。此时行仍显示状态图标、状态词、时长、TPS（如有）与 Stop。理由：分区标题与行内状态词已经说明「这是子智能体」，再写一遍哨兵只是噪声；而 `subagent` 不是任何人的名字。

5. **排序**：
   1. 主排序 `running`（0）→ `waiting`（1）→ `blocked`（2）；
   2. 同状态内按 `startedAt` 升序；
   3. `startedAt` 缺失或非有限值排在该状态组末尾（不抢到组首）；
   4. `startedAt` 相同的保持投影原序（稳定排序），不因每次投影刷新而跳位。

   排序结果同时用于行渲染与 TPS 批量读的 id 顺序；`resolveSubagentSpeedPollIds` 的 32 上限截断因此优先保留运行中，再等待，再阻塞。

6. **展开态分区头**：trailing 显示 `N 运行 · M 等待 · K 阻塞`，只列非零项，顺序固定 running/waiting/blocked，各项用 `·` 分隔。至少一项非零。

7. **收起态 trailing**：显示 `最长时长 · 该子智能体 TPS · 状态摘要`。
   - 「最长时长」取所有运行中子智能体中已运行时间最长的那一个（按 `now - startedAt`，不区分状态）；
   - TPS 必须来自同一个 `childSessionId`；读数缺席时省略该段；
   - 「状态摘要」与展开态相同（`N 运行 · M 等待 · K 阻塞`，只列非零项）。
   - 分区内没有运行中子智能体（只剩已结束）时，不显示状态摘要与 TPS，只保留「已结束 · N ›」页脚。

8. **TPS 是唯一速度口径**：行上的速度与收起态 trailing 的速度都只读 `session/performanceBatch` 返回的该子会话累计平均（`query_source = 'subagent'`，Σ `output_tokens` ÷ Σ（`duration_ms` − `time_to_first_token_ms`））。不显示实时估算、不显示 token 累计、不新增第二个速度字段。读数缺席（没有已完成请求、计量缺失、超出保留期、旧 CLI 不支持批量读）时整段不渲染，既不显示 `0` 也不显示 `--`。

9. **只读展示**：状态、名字与 TPS 都不参与打开详情、停止、计数、目录入口中的任何一个判定。行仍然是「整行可点开子会话 + 独立的 Stop 按钮」这套既有交互。

10. **不新增取数**：名字与状态随 `runningSubagents` 投影一起到达；TPS 沿用既有批量只读轮询。不新增 RPC、不轮询、不缓存、不进 store。

## 状态所有者

- **身份事实（唯一所有者）**：CLI 会话投影 `snapshot.subagents.running[].subagentType`。来源是子智能体启动事件 `SubagentSpawned.agentType`（`core/src/subagent/runner.ts` 发出，取该次 Agent 工具调用请求的 `agentType`）；cold hydration 在字段缺失时落 `subagent` 哨兵。UI 不派生第二份身份。
- **状态事实（唯一所有者）**：CLI 会话投影 `snapshot.subagents.running[].status`（`running | waiting | blocked`）。UI 不根据时长、标题、TPS 或 work 状态推导第二份状态。
- **名字显示策略（唯一所有者）**：`packages/ui/src/lib/subagentName.ts` 的 `resolveSubagentDisplayName`。面板不自己判哨兵、不自己 trim。
- **排序与状态计数（唯一所有者）**：`packages/ui/src/v4/subagentStatusModel.ts` 的 `sortRunningSubagentsByStatus` / `countSubagentStatuses`。组件只消费结果，不在渲染循环里各写一遍排序或计数。
- **速度事实**：`session/performanceBatch`（只读聚合）→ `useSessionPerformanceBatch` → `resolveSubagentSpeedReadings`。读数只活在 `SubagentStatusSection` 内，不写回、不持久化、不进全局 store。
- **渲染**：`packages/ui/src/v4/ConversationStatusPanel.tsx` 的 `SubagentStatusSection` 行。名字、状态、TPS 只活在这一次渲染里。

## 接口

```ts
// packages/ui/src/lib/subagentName.ts
/** payload 缺 agentType 时投影落的兜底值；它不是任何子智能体的名字。 */
export const SUBAGENT_UNNAMED_TYPE = "subagent";
/** 子智能体显示名：不是名字（空 / 只有空白 / 哨兵）时返回 undefined，调用方整段不渲染。 */
export function resolveSubagentDisplayName(subagentType: string | undefined): string | undefined;
```

```ts
// packages/ui/src/v4/subagentStatusModel.ts
export type RunningSubagentStatus = RunningSubagentSummary["status"]; // "running" | "waiting" | "blocked"

export const SUBAGENT_STATUS_ORDER: readonly RunningSubagentStatus[] = [
  "running",
  "waiting",
  "blocked",
] as const;

/** 规则 5：状态优先级优先，组内 startedAt 升序，缺失排在该组末尾，稳定。 */
export function sortRunningSubagentsByStatus<
  T extends { status: RunningSubagentStatus; startedAt?: number },
>(subagents: readonly T[]): T[];

export interface SubagentStatusCounts {
  running: number;
  waiting: number;
  blocked: number;
}

export function countSubagentStatuses(
  subagents: readonly { status: RunningSubagentStatus }[],
): SubagentStatusCounts;

/** 只列非零项；空摘要不渲染。 */
export function hasSubagentStatusSummary(counts: SubagentStatusCounts): boolean;
```

```ts
// packages/ui/src/i18n/locales/zh-CN.ts / en-US.ts
"chat.statusPanel.subagentStatus.running": "运行中" | "Running"
"chat.statusPanel.subagentStatus.waiting": "等待" | "Waiting"
"chat.statusPanel.subagentStatus.blocked": "阻塞" | "Blocked"
"chat.statusPanel.subagentStatusSummary.running": "{count} 运行" | "{count} running"
"chat.statusPanel.subagentStatusSummary.waiting": "{count} 等待" | "{count} waiting"
"chat.statusPanel.subagentStatusSummary.blocked": "{count} 阻塞" | "{count} blocked"
```

- 状态词不复用 `subagentDirectory.status.*`：目录页使用「等待中 / 已阻塞」，本分区使用「等待 / 阻塞」，避免为了面板改动历史目录文案。
- TPS 显示沿用 `formatSessionSpeedValue` 与 `data-subagent-speed` 锚点，不新增速度字段。
- 无协议、无 RPC、无持久化改动；`subagentType` 与 `status` 早已在 `runningSubagentSummarySchema` 里。

## 验收场景

1. 跑一个 `backend-developer` 子智能体：面板行出现「运行中」、`backend-developer`、时长、TPS（有读数时）与 Stop；名字与同一会话里 Agent 工具行显示的名字逐字相同。
2. 名字缺失（旧事件、投影兜底落 `subagent`）：行上不出现名字，也不出现 `subagent`；状态图标、状态词、时长、TPS、Stop 照常。
3. 名字很长（用户自定义的长名）：行内截断（`max-w-40`），不撑破面板宽度，也不把时长/TPS/Stop 挤出这一行。这一行整体 `pointer-events-none`（整行点击由透明按钮承接），所以不给 `title` 提示——完整名字在打开的子会话页签上。
4. 状态为 `running`：行首显示静态 `ArrowRightIcon`，「运行中」；状态为 `waiting`：行首显示 `CircleIcon` +「等待」；状态为 `blocked`：行首显示 `CircleSlashIcon` +「阻塞」；颜色按规则 2，且状态词始终存在；整个分区不出现旋转加载图标。
5. **排序**：同时跑 2 个 `running`（startedAt 10、20）、1 个 `waiting`（startedAt 5）、1 个 `blocked`（startedAt 1）→ 行顺序为 running(10)、running(20)、waiting(5)、blocked(1)；不按 startedAt 把 waiting/blocked 排到 running 前面。
6. **startedAt 缺失**：某状态组内存在缺失 `startedAt` 的行 → 该行排在同组末尾；不抢到组首。
7. **分区头摘要**：2 running + 1 waiting + 1 blocked → 「2 运行 · 1 等待 · 1 阻塞」；只有 3 running → 「3 运行」；只有 2 waiting → 「2 等待」；不出现「0 阻塞」。
8. **收起态**：收起「智能体」分区 → trailing 为「最长时长 · 该子智能体 TPS · 状态摘要」；TPS 缺席时省略 TPS 段；没有运行中子智能体时只保留「已结束 · N ›」。
9. **TPS 与状态独立**：给 `waiting` 的子智能体已有已完成请求 → 它仍显示自己的 TPS；状态词不因 TPS 有无而变化。
10. 子智能体结束：行消失，名字、状态与 TPS 随之消失，不残留上一次的值。
11. zh-CN / en-US：名字不随 locale 变化；状态词、时长、TPS、Stop 的文案随 locale 变化（「运行中/等待/阻塞」与「Running/Waiting/Blocked」）。
12. 对端不支持 `session/performanceBatch`（旧版 remote CLI）：行上不出现速度，状态、名字、时长、Stop 与目录入口全部照常。

## E2E 锚点

- 状态：每个运行中子智能体行 `<li>` 上挂 `data-subagent-status="running|waiting|blocked"`；同一行的既有 `data-work-status` 必须与新状态一致（不再硬编码 `running`），避免两个属性互相矛盾。
- 状态摘要：分区头 trailing 的摘要节点挂 `data-subagent-status-summary="running:N,waiting:M,blocked:K"`（只用于断言，不参与渲染）。
- 名字：`data-subagent-name="<name>"`（节点缺席即该行没有名字）。
- 速度：`data-subagent-speed="true"`（展开时在行内，收起时在「智能体」分区 trailing；节点缺席即没有读数）。
- 行本身沿用既有锚点：`data-background-task-kind="agent"`、`data-child-session-id`、`data-work-id`、`data-status-section="agent"`。

## 已知限制

- 名字是**执行器类型**，不是这一次任务：同名并发多条时，行之间仍只能靠标题区分（与会话里的 Agent 工具行一致）。
- 状态是**当前值，不是历史**：分区只显示 `snapshot.subagents.running[].status`，不显示状态切换历史、等待原因（等权限/等回答）或阻塞原因。
- 名字、状态只是展示，不参与权限、模型或工具范围；改名或状态变化不影响任何运行决策。
- 本次只改运行中的行。「已结束的智能体」目录行（`SubagentDirectorySidePane`）不改：它列的是历史而不是「谁在跑」，其状态词与排序另立规则。
- 工作流子智能体不出现在这个分区（它们不走 `SubagentSpawned`，因此不在 `runningSubagents` 里），所以这里也看不到它们的名字或状态。
- TPS 是累计平均且只在请求结束时前进；子智能体刚开始跑的一段时间里行上只有状态、名字与时长。
