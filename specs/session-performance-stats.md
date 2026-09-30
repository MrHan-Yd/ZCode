# 会话统计（Session Performance Stats）

## 背景

聊天界面此前看不到当前会话的性能画像。模型用时、工具调用用时、首 token 延迟、输出速度这些数据只存在于开发者工具里（`DeveloperToolsPane` 通过 `session/debug` 拿到逐请求的 `generationDurationMs` / `tokensPerSecond`），是开发者开关下的逐请求表格，用户在聊天界面没有入口，也拿不到整个会话的累计口径。

本次在输入框底部工具条右侧、上下文用量（ⓘ）左侧加入一个常驻的「输出速度」入口，悬停/聚焦展开「会话统计」面板。

数据落点选择持久层而不是进程内观察：`model_usage` 已有 `duration_ms` / `time_to_first_token_ms` / `output_tokens` / `query_source` / `status` 列，`tool_usage` 已有 `duration_ms` 列，并都有 `session_id` 索引。基于 SQLite 聚合意味着打开历史会话立刻有真实数据，也不需要新增写入路径。

## 产品规则

1. **入口形态**：工具条右侧紧凑文本按钮，内容为会话输出速度 `{n} tok/s`；位于上下文用量图标左侧，属于同一条「会话级状态」带。窄屏沿用工具条既有的紧凑折叠策略。

2. **面板四行，均为整个会话的累计口径**，只统计主链模型请求（`model_usage.query_source = 'main_turn'`）：

   | 行                    | 口径                                                              |
   | --------------------- | ----------------------------------------------------------------- |
   | 模型用时              | 主链模型请求 `duration_ms` 之和（含首 token 等待）                |
   | 工具调用用时          | 该会话 `tool_usage.duration_ms` 之和（不含权限等待）              |
   | 首 token 平均（TTFT） | 主链模型请求 `time_to_first_token_ms` 的算术平均                  |
   | 输出速度（TPS）       | Σ `output_tokens` ÷ Σ（`duration_ms` − `time_to_first_token_ms`） |
   - TPS 的分子分母取同一批请求：只有两项计量都存在且 `duration_ms > time_to_first_token_ms` 的请求才计入。不能用请求总时长替代生成时长（沿用 `calculateOutputTps` 的既有约束）。
   - 工具与模型时长分别累加：并发的工具调用按各自时长相加，因此两项之和不等于墙钟时长。这是刻意选择——面板表达「模型花了多少、工具花了多少」，不是时间轴。

3. **入口数字**：会话运行中显示流式实时估算；空闲时显示上面的累计 TPS。两者都取不到时不渲染入口（新建的草稿会话、30 天保留期之外的历史会话、只有工具没有主链请求的会话）。

4. **实时估算口径**（显示投影，不是事实）：只统计当前处于流式态的行（`assistantText` / `reasoning`），token 数由字符数按共享常量 `ESTIMATED_TOKEN_CHAR_DIVISOR` 估算，时间从该流式行创建时刻起算，因此不含首 token 等待。观测窗口不足时不产出数值，入口沿用上一次显示值，避免首帧出现无意义的巨大数值。

5. **面板只读**：不提供任何操作按钮，不写任何状态。缺计量的行显示 `--`。

6. **无会话不渲染**：没有 sessionId 时不显示入口。

## 状态所有者

- **累计事实（唯一所有者）**：CLI 进程持有的 SQLite `model_usage` / `tool_usage` 表。本次不新增表、不新增写入路径，只新增一条只读聚合查询。UI 通过 `session/performance` 只读 RPC 读取，不在 renderer 缓存或派生第二份累计值。
- **实时估算**：renderer 内的显示投影，只存在于组件实例里（样本缓冲 + 1 秒时钟）。不写回、不持久化、不在流式结束后继续参与显示；每一轮结束后入口回到权威累计值。
- **轮询开关**：`ChatSessionStats` 组件。运行中按 1 秒轮询；面板打开时轮询；一轮结束后的短暂 settle 窗口内再取一次，保证刚结束那轮已计入。空闲且面板关闭时不产生请求（远程 workspace 因此没有常驻流量）。

  轮询失败**不终止**：app 冷启动时 agent 往往还没就绪，前几次必然失败；若按「连续失败 N 次就放弃」收口，入口要等下一次依赖变化才恢复，表现为「刚才还有、现在没了」。对端不支持该方法时也按同一节奏重试——`enabled` 已经把空闲时段排除掉了。

数据流：

```text
CLI 运行时 → model_usage / tool_usage（SQLite，唯一事实）
                      │
                      └─ session/performance（只读 RPC，按需轮询）
                                   │
renderer：ChatSessionStats ────────┴─ 入口数字（空闲=累计 TPS）
        └─ 流式行字符估算（仅显示投影）─ 入口数字（运行中=实时估算）
                      └─ 面板四行（只读权威值）
```

## 接口

```ts
// packages/shared/src/session-performance.ts
export const sessionPerformanceSnapshotSchema = z
  .object({
    sessionId: z.string(),
    summary: z.object({
      modelMs: z.number().nonnegative(),
      toolMs: z.number().nonnegative(),
      averageTtftMs: z.number().nonnegative().nullable(),
      tokensPerSecond: z.number().nonnegative().nullable(),
      modelRequestCount: z.number().int().nonnegative(),
      toolCallCount: z.number().int().nonnegative(),
    }),
  })
  .strict();

/** 流式期间的字符→token 估算，与 CLI 侧 estimateTokens 同口径（CJK 双倍权重）。 */
export function estimateOutputTokensFromCharCounts(
  charCount: number,
  wideCharCount: number,
): number;
export function averageTtftMs(sumMs: number, sampleCount: number): number | null;
```

```ts
// packages/shared/src/zcode-protocol/index.ts
zcodeProtocolMethods.sessionPerformance = "session/performance";
// params: { sessionId: string }，result: SessionPerformanceSnapshot
```

```ts
// apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts
export interface UsageStorePort {
  // ...
  querySessionPerformance(
    input: SessionPerformanceQueryInput,
  ): Promise<SessionPerformanceQueryResult>;
}
```

```ts
// packages/services/src/zcode-agent/zcodeAgent.ts
readSessionPerformance(
  params: ZCodeAgentSessionTarget,
): Promise<SessionPerformanceSnapshot>;
```

- 无该 RPC 的对端（旧版 remote CLI）返回方法不存在错误：UI 侧静默隐藏入口，不冒泡、不阻塞输入。
- 请求参数只有 `sessionId`：workspace 由既有的 `ZCodeAgentSessionTarget` 承载，与 `readSessionDebug` 一致。

## 验收场景

1. 打开一个有历史的会话：入口显示累计 TPS（落库数据），面板四行是真实值。
2. 发送一轮：运行中入口数字按秒刷新且不抖动；该轮结束后入口回到累计值，且新值已包含刚完成的一轮。
3. 新建空会话（无任何主链请求）：不渲染入口。
4. 对端不支持该 RPC：入口静默隐藏，聊天与输入不受影响。
5. 会话只有工具调用、没有主链模型请求：面板的时长行显示 `--` 之外的可用项，TPS 行显示 `--`。
6. 并发多个工具调用：工具耗时按各自时长累加，不因重叠而互相扣减。
7. zh-CN / en-US：标题、四行标签与时长单位随 locale 变化；`5分51秒` / `5m 51s`。

## 已知限制

- 用量表按 `USAGE_RETENTION_DAYS = 30` 天滚动清理，保留期之外的会话统计为 0，入口隐藏。
- 工具耗时不含权限等待（与 `tool_usage.duration_ms` 的既有口径一致）。
- 实时估算基于字符而非真实 tokenizer，只用于流式期间的即时反馈；面板数值始终来自持久层。
- 子代理会话有独立 `session_id`，不计入父会话统计。
- 面板统计的是整个会话累计，不提供按轮次拆分。

## E2E 锚点

- `TID_CHAT_SESSION_STATS_TRIGGER`（`packages/shared/src/test-ids.ts`）：工具条入口按钮，`data-chat-toolbar-popover-trigger="true"`。
- `TID_CHAT_SESSION_STATS_PANEL`：会话统计面板根节点。
