# 会话统计（Session Performance Stats）

## 背景

聊天界面此前看不到当前会话的性能画像。模型用时、工具调用用时、首 token 延迟、输出速度这些数据只存在于开发者工具里（`DeveloperToolsPane` 通过 `session/debug` 拿到逐请求的 `generationDurationMs` / `tokensPerSecond`），是开发者开关下的逐请求表格，用户在聊天界面没有入口，也拿不到整个会话的累计口径。

本次在输入框底部工具条右侧、上下文用量（ⓘ）左侧加入一个常驻的「输出速度」入口，悬停/聚焦展开「会话统计」面板。

后续调整：同一份「输出速度」在入口与面板用了两个不同口径（入口是运行中的实时估算，面板是整会话累计），两个数同时可见时容易被读成「算错了」。面板因此把累计口径明确命名为「平均输出速度（TPS）」，并新增「当前输出速度」行，让两个口径并列可见、来源可辨。

数据落点选择持久层而不是进程内观察：`model_usage` 已有 `duration_ms` / `time_to_first_token_ms` / `output_tokens` / `query_source` / `status` 列，`tool_usage` 已有 `duration_ms` 列，并都有 `session_id` 索引。基于 SQLite 聚合意味着打开历史会话立刻有真实数据，也不需要新增写入路径。

## 产品规则

1. **入口形态**：工具条右侧紧凑文本按钮，内容为会话输出速度 `{n} tok/s`；位于上下文用量图标左侧，属于同一条「会话级状态」带。窄屏沿用工具条既有的紧凑折叠策略。按钮取值是「当前输出速度，拿不到时回落到平均输出速度」，与面板第五行同一口径；运行中它与面板第四行可以不同值。

2. **面板五行：前四行是整个会话的累计口径**（只统计主链模型请求 `model_usage.query_source = 'main_turn'`），**第五行是运行中的实时估算**：

   | 行                    | 口径                                                                                   |
   | --------------------- | -------------------------------------------------------------------------------------- |
   | 模型用时              | 主链模型请求 `duration_ms` 之和（含首 token 等待）                                     |
   | 工具调用用时          | 该会话 `tool_usage.duration_ms` 之和（不含权限等待）                                   |
   | 首 token 平均（TTFT） | 主链模型请求 `time_to_first_token_ms` 的算术平均                                       |
   | 平均输出速度（TPS）   | Σ provider `output_tokens` ÷ Σ（`duration_ms` − `time_to_first_token_ms`），整会话累计 |
   | 当前输出速度          | 运行中的流式实时估算（口径见规则 4）；不在流式态时显示 `--`                            |
   - 「平均」与「当前」是同一现象的两个口径，**数值天然不同**：分子一是 provider 的真实 `output_tokens`、一是按字符折算的估算值；时间窗一是整会话累计、一是当前流式行的近几秒。两者不能互相换算，也不能为了「看起来一致」把一处改成另一处的算法——第四行回答「这个会话平均多快」，第五行与入口回答「此刻多快」。缺计量的行显示 `--`。
   - 平均 TPS 的分子分母取同一批请求：只有两项计量都存在且 `duration_ms > time_to_first_token_ms` 的请求才计入。不能用请求总时长替代生成时长（沿用 `calculateOutputTps` 的既有约束）。
   - 工具与模型时长分别累加：并发的工具调用按各自时长相加，因此两项之和不等于墙钟时长。这是刻意选择——面板表达「模型花了多少、工具花了多少」，不是时间轴。

3. **入口数字**：会话运行中显示流式实时估算；空闲时显示上面的累计平均 TPS（即面板第四行）。

   **何时渲染入口**（`canRenderSessionStatsEntry`）：没有 `sessionId` 不渲染；有 `sessionId` 但既没有主链请求、也没有工具调用记录（新建的草稿会话、30 天保留期之外的历史会话）且没有实时估算值时不渲染。**已有记录就渲染**，即使两个速度口径都算不出来：此时入口显示 `--`，但面板仍打得开、时长行有意义——「只有工具调用、没有主链请求」的会话属于这一类（见场景 5），入口对它是唯一的面板入口，不能因为速度算不出来就连时长一起藏掉。

4. **实时估算口径**（显示投影，不是事实）：只统计当前处于流式态的行（`assistantText` / `reasoning`），token 数由字符数按共享常量 `ESTIMATED_TOKEN_CHAR_DIVISOR` 估算，时间从该流式行创建时刻起算，因此不含首 token 等待。观测窗口不足时不产出数值，入口沿用上一次显示值，避免首帧出现无意义的巨大数值。同一读数同时供入口按钮与面板第五行；不在流式态时两者都不显示实时值（入口回落累计平均，面板第五行显示 `--`）。

5. **面板只读**：不提供任何操作按钮，不写任何状态。缺计量的行显示 `--`。

6. **无会话不渲染**：没有 sessionId 时不显示入口。

## 状态所有者

- **累计事实（唯一所有者）**：CLI 进程持有的 SQLite `model_usage` / `tool_usage` 表。本次不新增表、不新增写入路径，只新增一条只读聚合查询。UI 通过 `session/performance` 只读 RPC 读取，不在 renderer 缓存或派生第二份累计值。
- **实时估算**：renderer 内的显示投影，只存在于组件实例里（样本缓冲 + 1 秒时钟）。不写回、不持久化、不在流式结束后继续参与显示；每一轮结束后入口回到权威累计平均值，面板第五行回到 `--`。入口与面板第五行读的是同一个读数，不各自维护一份样本。
- **轮询开关**：`ChatSessionStats` 组件。运行中按 1 秒轮询；面板打开时轮询；一轮结束后的短暂 settle 窗口内再取一次，保证刚结束那轮已计入。空闲且面板关闭时不产生请求（远程 workspace 因此没有常驻流量）。

  轮询失败**不终止**：app 冷启动时 agent 往往还没就绪，前几次必然失败；若按「连续失败 N 次就放弃」收口，入口要等下一次依赖变化才恢复，表现为「刚才还有、现在没了」。对端不支持该方法时也按同一节奏重试——`enabled` 已经把空闲时段排除掉了。

数据流：

```text
CLI 运行时 → model_usage / tool_usage（SQLite，唯一事实）
                      │
                      └─ session/performance（只读 RPC，按需轮询）
                                   │
renderer：ChatSessionStats ────────┴─ 入口数字（运行中=实时估算，否则=累计平均）
        └─ 流式行字符估算（仅显示投影）┬─ 面板「当前输出速度」行（不在流式态=--）
                                      └─ 面板「平均输出速度」等四行（只读权威值）
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

```ts
// packages/ui/src/v4/composer/sessionStatsSpeeds.ts
// 会话统计里「输出速度」的显示投影：集中决定每个显示面读哪个口径（面板两行 + 入口）。
export interface SessionStatsSpeeds {
  /** 整会话累计平均（持久层权威值）。 */
  average: number | null;
  /** 运行中的流式实时估算；不在流式态时为 null。 */
  current: number | null;
  /** 入口按钮取值：current ?? average。 */
  trigger: number | null;
}
export function resolveSessionStatsSpeeds(
  summary: Pick<SessionPerformanceSummary, "tokensPerSecond"> | null,
  liveSpeed: number | null,
): SessionStatsSpeeds;

/** 入口渲染门禁：无 sessionId、或既无记录又无实时值时不渲染（见产品规则 3）。 */
export function canRenderSessionStatsEntry(input: {
  sessionId: string | null;
  summary: Pick<SessionPerformanceSummary, "modelRequestCount" | "toolCallCount"> | null;
  speeds: SessionStatsSpeeds;
}): boolean;
```

- 无该 RPC 的对端（旧版 remote CLI）返回方法不存在错误：UI 侧静默隐藏入口，不冒泡、不阻塞输入。
- 请求参数只有 `sessionId`：workspace 由既有的 `ZCodeAgentSessionTarget` 承载，与 `readSessionDebug` 一致。

## 验收场景

1. 打开一个有历史的会话：入口显示累计平均 TPS（落库数据），面板前四行是真实值。
2. 发送一轮：运行中入口数字按秒刷新且不抖动；该轮结束后入口回到累计平均值，且新值已包含刚完成的一轮。
3. 新建空会话（无任何主链请求）：不渲染入口。
4. 对端不支持该 RPC：入口静默隐藏，聊天与输入不受影响。
5. 会话只有工具调用、没有主链模型请求：面板的时长行显示可用项，两个速度行都显示 `--`。
6. 并发多个工具调用：工具耗时按各自时长累加，不因重叠而互相扣减。
7. zh-CN / en-US：标题、五行标签与时长单位随 locale 变化；`5分51秒` / `5m 51s`。
8. 运行中打开面板：「平均输出速度」是持久层累计、「当前输出速度」是实时估算，两者可以是不同数值（口径不同，不允许被「修成一致」）；停止后「当前输出速度」回到 `--`，入口回到累计平均值。

## 已知限制

- 用量表按 `USAGE_RETENTION_DAYS = 30` 天滚动清理，保留期之外的会话统计为 0，入口隐藏。
- 工具耗时不含权限等待（与 `tool_usage.duration_ms` 的既有口径一致）。
- 实时估算基于字符而非真实 tokenizer，只服务入口与面板「当前输出速度」行；另外四行始终来自持久层。因此「当前」与「平均」并存且数值不同是预期表现，不是显示故障。
- 累计行只在工作**完成**时前进：`model_usage` 只在整个请求结束时落行，`tool_usage` 的进行中行 `duration_ms` 为空。所以进行中的请求/工具对时长行贡献为 0，长工具调用或子代理等待期间面板可整段不动；加上「首 token 平均」与「平均输出速度」是整会话平均、样本多了之后收敛，这两行基本上不再变化。
- 子代理会话有独立 `session_id`，不计入父会话统计。
- 面板统计的是整个会话累计，不提供按轮次拆分。

## E2E 锚点

- `TID_CHAT_SESSION_STATS_TRIGGER`（`packages/shared/src/test-ids.ts`）：工具条入口按钮，`data-chat-toolbar-popover-trigger="true"`。
- `TID_CHAT_SESSION_STATS_PANEL`：会话统计面板根节点。
