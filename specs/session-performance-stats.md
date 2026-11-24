# 会话统计（Session Performance Stats）

## 背景

聊天界面此前看不到当前会话的性能画像。模型用时、工具调用用时、首 token 延迟、输出速度这些数据只存在于开发者工具里（`DeveloperToolsPane` 通过 `session/debug` 拿到逐请求的 `generationDurationMs` / `tokensPerSecond`），是开发者开关下的逐请求表格，用户在聊天界面没有入口，也拿不到整个会话的累计口径。

本次在输入框底部工具条右侧、上下文用量（ⓘ）左侧加入一个常驻的「输出速度」入口，悬停/聚焦展开「会话统计」面板。

后续调整：同一份「输出速度」在入口与面板用了两个不同口径（入口是运行中的实时估算，面板是整会话累计），两个数同时可见时容易被读成「算错了」。面板因此把累计口径明确命名为「平均输出速度（TPS）」，并新增「当前输出速度」行，让两个口径并列可见、来源可辨。

数据落点选择持久层而不是进程内观察：`model_usage` 已有 `duration_ms` / `time_to_first_token_ms` / `output_tokens` / `query_source` / `status` 列，`tool_usage` 已有 `duration_ms` 列，并都有 `session_id` 索引。基于 SQLite 聚合意味着打开历史会话立刻有真实数据，也不需要新增写入路径。

再后续扩展（子智能体）：状态面板的「智能体」分区过去只有时长和运行数，看不出某个子智能体「多快」。子代理的模型请求记在**子会话自己的** `session_id` 上（`query_source = 'subagent'`），父会话的累计口径（`main_turn`）看不到它们。本次因此新增一条批量只读 RPC，让面板按子会话读它们各自的累计平均 TPS（见产品规则 7）。

为什么不复用父会话的实时估算：父会话快照**刻意不内嵌子会话的行**（`subagentRow.childSessionId` 只作为「可下钻订阅 `conversation/<childSessionId>`」的锚点，见 `packages/shared/src/zcode-protocol-v4/rows.ts`），`runningSubagentSummary` 也只带 `childSessionId` / `title` / `status` / `startedAt`。要让面板显示子智能体的实时速度，只能让 renderer 为每个运行中的子智能体各订阅一条子会话 token 流——工作量随并发子代理数增长，而面板是常驻挂载的。因此这里选择读持久层累计值：一个数字，一次/秒的批量请求。

## 产品规则

1. **入口形态**：工具条右侧紧凑文本按钮，内容为会话输出速度 `{n} tok/s`；位于上下文用量图标左侧，属于同一条「会话级状态」带。窄屏沿用工具条既有的紧凑折叠策略。按钮取值是「当前输出速度，拿不到时回落到平均输出速度」，与面板第五行同一口径；运行中它与面板第四行可以不同值。

2. **面板五行：前四行是整个会话的累计口径**（只统计主链模型请求 `model_usage.query_source = 'main_turn'`），**第五行是当前轮的实时估算**：

   | 行                    | 口径                                                                                   |
   | --------------------- | -------------------------------------------------------------------------------------- |
   | 模型用时              | 主链模型请求 `duration_ms` 之和（含首 token 等待）                                     |
   | 工具调用用时          | 该会话 `tool_usage.duration_ms` 之和（不含权限等待）                                   |
   | 首 token 平均（TTFT） | 主链模型请求 `time_to_first_token_ms` 的算术平均                                       |
   | 平均输出速度（TPS）   | Σ provider `output_tokens` ÷ Σ `duration_ms`，整会话端到端累计，与请求日志同口径 |
   | 当前输出速度（估算）  | 当前轮已产出内容的字符估算（口径见规则 4）；最近 3 秒没有新增输出时显示 `--`       |
   - 「平均」是成功请求的端到端产出速率，包含等待、隐藏推理、传输和本地处理时间，不宣称纯模型解码速度；「当前」只描述客户端最近观测到的字符增量，数值天然不同。实时值与入口使用 `≈ {n} tok/s`，不得把估算标成 provider 的真实输出速度。缺计量的行显示 `--`。
   - 平均 TPS 的分子分母取同一批成功请求：只有 `duration_ms > 0` 的请求才计入，复用 `calculateRequestLogAverageTps`。TTFT 是否缺失、为零或接近总耗时都不影响选样；输入、缓存 token 和单列 reasoning token 不额外加入输出分子。
   - 首字（TTFT）仍独立展示首次客户端内容观测延迟，缺少文本/思考增量时由 provider 里程碑 `timeToFirstContentMs` 回填（见 `specs/model-request-logs.md`）。首次观测不等于全部输出开始生成的时刻，因此不能从整轮输出的分母中扣除它。
   - 工具与模型时长分别累加：并发的工具调用按各自时长相加，因此两项之和不等于墙钟时长。这是刻意选择——面板表达「模型花了多少、工具花了多少」，不是时间轴。

3. **入口数字**：会话运行中显示当前轮的实时估算；空闲时显示上面的累计平均 TPS（即面板第四行）。

   **何时渲染入口**（`canRenderSessionStatsEntry`）：没有 `sessionId` 不渲染；有 `sessionId` 但既没有主链请求、也没有工具调用记录（新建的草稿会话、30 天保留期之外的历史会话）且没有实时估算值时不渲染。**已有记录就渲染**，即使两个速度口径都算不出来：此时入口显示 `--`，但面板仍打得开、时长行有意义——「只有工具调用、没有主链请求」的会话属于这一类（见场景 5），入口对它是唯一的面板入口，不能因为速度算不出来就连时长一起藏掉。

4. **实时估算口径**（显示投影，不是事实）：按**当前轮累计**统计模型已产出的内容——`assistantText` / `reasoning` 的正文与 `toolCall` 的入参 `inputText` 都算输出；token 数由字符数按共享常量 `ESTIMATED_TOKEN_CHAR_DIVISOR` 估算（CJK 双倍权重）。速度取最近 3 秒采样窗口两端的累计读数差除以跨度，因此衡量的是「这一轮最近还在以多快速度产出」；观测窗口不足时不产出数值，入口沿用上一次显示值，避免首帧出现无意义的巨大数值。同一读数同时供入口按钮与面板第五行。
   - **不按行状态过滤**：同一轮内已经结束的正文/思考/工具入参继续计入累计值。旧口径只统计 `state = "streaming"` 的行，每次换段（思考结束 → 正文开始、正文结束 → 工具入参开始）都会让读数瞬间大幅下降，观测窗要滑过 3 秒才恢复，读起来就是「只有一开始有、过一会只剩平均」。累计口径只测量「当前轮又新增了多少」，与行的生命周期解耦。
   - **工具入参算输出**：agent 轮里大量输出就是工具调用参数（写文件、改代码），它们同样由模型逐 token 生成、也在界面上逐字展示；只看正文会让长时间写文件的阶段一直显示 `--`。
   - **换轮和快照边界必须显式重置**：采样携带 `sessionId`、窗口末行 `turnId` 与窗口首行 `rowId` 组成的作用域标识。切会话、换轮、重连补历史或窗口裁切时丢弃旧样本，即使新轮首次累计值大于旧轮也不能相减。读数回落或清零同样重开；新作用域首个读数只作为基线，不产生瞬时速度。
   - **没有输出就没有当前速度**：工具执行、等待首 token 等阶段没有新增字符，3 秒窗口滑过读数差归零后显示 `--`（入口回落累计平均）。这与「模型回答结束」同一语义，不是故障。

   **估算只在采样时刻发生**：旧实现每提交一帧快照就重算一遍（流式期间数量级 30 次/秒，CLI 侧 mirror flush 为 32ms），而唯一的消费方每秒只读一次。现在每帧只把最新快照挂进读数器（一次赋值，不扫正文），字符扫描留到 1 秒时钟取样本那一刻；没有任何人读时（入口不渲染、会话不在流式态）一次估算都不发生。理由是扫描成本与**已输出正文长度**成正比：本机实测 2k 字符 0.08ms、10k 字符 0.25ms、40k 字符 1.46ms 一次，逐帧重算会把长回答每个帧窗的约 1.5% ~ 9% 预算花在一个每秒只读一次的数上。按轮累计后每分钟要重扫的不再是单个流式行，读数器因此按 `rowId` 缓存每行上次算出的 token 数：行文本长度不变就直接复用，一秒内只重算仍在增长的 1~2 行。

5. **面板只读**：不提供任何操作按钮，不写任何状态。缺计量的行显示 `--`。

6. **无会话不渲染**：没有 sessionId 时不显示入口。

7. **子智能体的输出速度**：状态面板「智能体」分区里，每个运行中的子智能体行显示它**自己那个子会话**的累计平均 TPS；收起态 trailing 显示「运行最久的那个子智能体」的速度（与同一处显示的时长同指一个子智能体）。
   - **位置**：展开行的信息行里，顺序为「状态图标 → 状态词 → 子智能体名 → 时长 → TPS → Stop」（`● 运行中  backend-developer  4分31秒  201 tok/s  ■ 停止`），各项靠间距分隔、不使用 `·`，与 Stop 按钮同一行簇；状态词、名字、排序与摘要的完整规则见 `specs/status-panel-subagent-identity.md`。收起态 trailing 是 `{最长时长} · {该子智能体速度} · {状态摘要}`（状态摘要为 `N 运行 · M 等待 · K 阻塞`，只列非零项）。
   - **唯一速度口径**：本分区只使用这条累计平均 TPS，不显示实时估算、不显示 token 累计、不新增第二份速度字段；状态（`running/waiting/blocked`）来自 `snapshot.subagents.running[].status`，与速度读数相互独立。
   - **口径**：该子会话 `model_usage` 中 `query_source = 'subagent'` 且 `status = 'completed'`、`duration_ms > 0` 的请求，换算与面板第四行及请求日志同一公式（Σ `output_tokens` ÷ Σ `duration_ms`）。这是成功请求的端到端累计平均，不是客户端实时估算，也不使用卡片的运行墙钟时长。
   - **取数**：新增批量只读 RPC `session/performanceBatch`（一次请求覆盖多个会话），面板按 1 秒轮询。**上限**：≤1 请求/秒、单请求 ≤32 个会话、只在「有运行中子智能体」且「智能体分区已挂载」时发（见状态所有者）。
   - **缺席就是不显示**：该子智能体还没有已完成请求、计量缺失，或已超出 30 天保留期时不显示数字——既不显示 `0`（会被读成「卡住了」），也不显示 `--`（那是面板五行的行语义，这里没有行）。状态、名字、时长、Stop 与目录入口照常显示；数字只在请求结束边界前进，因此子智能体刚开始跑的一段时间里行上只有状态、名字与时长。
   - **与父会话四行的边界不变**：子代理请求记在子会话 id 上，**不计入**父会话的时长/速度行；本规则只让面板能读到每个子会话自己的累计。
   - **对端不支持该 RPC**（旧版 remote CLI）：行上不出现速度，其余部分（状态、名字、时长、Stop、目录入口）照常工作；不做任何提示，也不阻塞面板。

## 状态所有者

- **累计事实（唯一所有者）**：CLI 进程持有的 SQLite `model_usage` / `tool_usage` 表。本次不新增表、不新增写入路径，只新增一条只读聚合查询。UI 通过 `session/performance` 只读 RPC 读取，不在 renderer 缓存或派生第二份累计值。
- **实时估算**：renderer 内的显示投影，只存在于组件实例里（样本缓冲 + 1 秒时钟 + 按行 token 缓存）。不写回、不持久化；每一轮结束后入口回到权威累计平均值，面板第五行回到 `--`。入口与面板第五行读的是同一个读数，不各自维护一份样本。换轮（窗口末行 `turnId` 变化）时缓存与采样窗一起重置，旧轮的读数不会落到新一轮。
- **轮询开关**：`ChatSessionStats` 组件。运行中按 1 秒轮询；面板打开时轮询；一轮结束后的短暂 settle 窗口内再取一次，保证刚结束那轮已计入。空闲且面板关闭时不产生请求（远程 workspace 因此没有常驻流量）。

  轮询失败**不终止**：app 冷启动时 agent 往往还没就绪，前几次必然失败；若按「连续失败 N 次就放弃」收口，入口要等下一次依赖变化才恢复，表现为「刚才还有、现在没了」。对端不支持该方法时也按同一节奏重试——`enabled` 已经把空闲时段排除掉了。

- **子智能体速度读数（规则 7）**：
  - **事实所有者**：仍是 CLI 进程的 SQLite `model_usage`（子代理请求的行记在子会话 id 上，`query_source = 'subagent'`）。本次不新增表、不新增写入路径；批量 RPC 只做同一份只读聚合，参数换成「一次要多个 session_id」，每个 id 用哪套 `query_source` 由 CLI 侧按该会话**是不是子会话**（`session.parentID` 存在）裁决，不下发也不信任客户端指定的口径。
  - **显示所有者**：状态面板「智能体」分区组件（`SubagentStatusSection`）。读数只活在这个组件里，不写回、不持久化、不进全局 store；分区卸载即停轮询。
  - **时序与去重**：分区挂载且有运行中子智能体 → 立即读一次，之后每 1 秒一次；下一次请求在收到上一次响应后才排期（不重叠）。响应按 `scopeKey`（workspace 身份 + 本次请求的 id 集合）判归属，key 不匹配的响应整体丢弃——切会话/切 workspace 后旧结果不能落到新面板上。
  - **结束即丢键**：子智能体离开运行集合后，它的读数在同一次渲染里被过滤掉，不留下任何「上次多少」的缓存值。
  - **失败保留上一次成功读数**：瞬时失败不清空数字（与入口同一条理由），但对端整个方法不存在时行上永远不出现速度（规则 7 的降级）。
  - **有界**：轮询只在「有运行中子智能体」时存在，单请求 id 数上限 32（超上限由 wire schema 拒绝，UI 侧先按输入顺序截断，保留运行最久的那些）。轮询关闭时（无运行中子智能体 / mini 形态 / 分区未挂载）不产生任何请求，远程 workspace 因此没有常驻流量。

数据流：

```text
CLI 运行时 → model_usage / tool_usage（SQLite，唯一事实）
                      │
                      ├─ session/performance（只读 RPC，按需轮询）
                      │            │
                      │            └─ renderer：ChatSessionStats ─┬─ 入口数字（运行中=实时估算，否则=累计平均）
                      │                     └─ 当前轮字符估算（仅显示投影）┬─ 面板「当前输出速度」行（最近 3 秒无新增=--）
                      │                                                   └─ 面板「平均输出速度」等四行（只读权威值）
                      │
                      └─ session/performanceBatch（只读 RPC，批量；≤1 次/秒，≤32 会话）
                                   │
renderer：SubagentStatusSection ───┴─ 每个运行中子智能体行「{n} tok/s」（子会话自己的累计平均）
                                      ├─ 行内状态词来自 snapshot.subagents.running[].status（与速度独立）
                                      └─ 收起态 trailing 取「运行最久」那个子智能体的读数 + 状态摘要
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

/** 批量读取的上限：一笔请求最多覆盖这么多会话（见状态所有者的「有界」）。 */
export const SESSION_PERFORMANCE_MAX_SESSIONS = 32;
export const sessionPerformanceBatchParamsSchema = z
  .object({ sessionIds: z.array(z.string().min(1)).min(1).max(SESSION_PERFORMANCE_MAX_SESSIONS) })
  .strict();
export const sessionPerformanceBatchResultSchema = z
  .object({
    /** 只回有读数的会话，顺序同请求；查不到的 id（子智能体刚结束/保留期外/不在本进程）整体缺席，不报错。 */
    entries: z.array(sessionPerformanceSnapshotSchema),
  })
  .strict();
```

```ts
// packages/shared/src/zcode-protocol/index.ts
zcodeProtocolMethods.sessionPerformance = "session/performance";
// params: { sessionId: string }，result: SessionPerformanceSnapshot
zcodeProtocolMethods.sessionPerformanceBatch = "session/performanceBatch";
// params: { sessionIds: string[] }（1..32），result: { entries: SessionPerformanceSnapshot[] }
```

```ts
// apps/zcode-cli/packages/contracts/src/interfaces/session-store.port.ts
export interface SessionPerformanceQueryInput {
  sessionID: SessionId;
  /**
   * 计入该会话自身累计的 model_usage.query_source 集合。主会话是 ['main_turn']；
   * 子智能体的子会话是 ['subagent']——子代理请求记在子会话 id 上，用主链口径会读出全 0。
   */
  querySources: readonly SessionPerformanceQuerySource[];
}
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
readSessionPerformanceBatch(
  params: ZCodeAgentSessionTarget & { sessionIds: readonly string[] },
): Promise<{ entries: SessionPerformanceSnapshot[] }>;
```

```ts
// packages/ui/src/hooks/useSessionPerformanceBatch.ts
/** 批量只读轮询：调用方给 id 集合，1 秒一次；失败保留上一次成功读数。 */
export function useSessionPerformanceBatch(input: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionIds: readonly string[];
  enabled: boolean;
}): { entries: readonly SessionPerformanceSnapshot[] | null; error: boolean };

// packages/ui/src/v4/subagentSpeeds.ts
/** 显示投影：把批量读数按 childSessionId 归位，null 速度不产出读数（规则 7 的「缺席」）。 */
export function resolveSubagentSpeedReadings(
  entries: readonly SessionPerformanceSnapshot[] | null,
  childSessionIds: readonly string[],
): ReadonlyMap<string, number>;
/** 收起态 trailing 取的那一个：与显示的时长同指一个子智能体。 */
export function resolveLongestRunningSubagent<T extends { startedAt?: number }>(
  subagents: readonly T[],
  now: number,
): T | null;
```

```ts
// packages/ui/src/v4/composer/streamingOutputTokens.ts
/**
 * 当前轮（窗口末行的 turnId）已产出的估算 token 数：assistantText / reasoning 正文
 * 与 toolCall 入参 inputText 都算输出，不按行的 streaming 状态过滤（见规则 4）。
 */
export function countTurnOutputTokens(snapshot: ConversationSnapshot | null): number;
/**
 * 带按行缓存的整轮估算器（读数器默认实现）：行文本长度不变时复用上次字符扫描结果，
 * 换轮即清空缓存。
 */
export function createTurnOutputTokenEstimator(): (snapshot: ConversationSnapshot | null) => number;

// packages/ui/src/v4/composer/liveOutputTokens.ts
// 实时读数的采样边界（规则 4）：逐帧挂快照，估算留到读的那一刻。
export interface LiveOutputTokenReading {
  tokens: number;
  scopeKey: string | null;
}
export interface LiveOutputTokenReader {
  setSnapshot(snapshot: ConversationSnapshot | null, streaming: boolean): void;
  read(): LiveOutputTokenReading;
}
export function createLiveOutputTokenReader(
  estimate?: (snapshot: ConversationSnapshot | null) => number,
): LiveOutputTokenReader;

// packages/ui/src/v4/composer/liveOutputSpeed.ts
/** 追加一个携带 scopeKey 的 1 秒样本；作用域变化、清零或读数回落时重开。 */
export function appendOutputSpeedSample(
  previous: readonly OutputSpeedSample[],
  next: OutputSpeedSample,
): readonly OutputSpeedSample[];

// packages/ui/src/v4/composer/sessionStatsSpeeds.ts
// 会话统计里「输出速度」的显示投影：集中决定每个显示面读哪个口径（面板两行 + 入口）。
export interface SessionStatsSpeeds {
  /** 整会话累计平均（持久层权威值）。 */
  average: number | null;
  /** 当前轮的实时估算；最近窗口没有新增输出时为 null。 */
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
2. 发送一轮：运行中入口数字按秒刷新且不抖动；思考→正文→工具入参之间的换段不清空读数；该轮结束后入口回到累计平均值，且新值已包含刚完成的一轮。
3. 新建空会话（无任何主链请求）：不渲染入口。
4. 对端不支持该 RPC：入口静默隐藏，聊天与输入不受影响。
5. 会话只有工具调用、没有主链模型请求：面板的时长行显示可用项，两个速度行都显示 `--`。
6. 并发多个工具调用：工具耗时按各自时长累加，不因重叠而互相扣减。
7. zh-CN / en-US：标题、五行标签与时长单位随 locale 变化；`5分51秒` / `5m 51s`。
8. 运行中打开面板：「平均输出速度」是持久层累计、「当前输出速度」是实时估算，两者可以是不同数值（口径不同，不允许被「修成一致」）；停止后「当前输出速度」回到 `--`，入口回到累计平均值。
9. 子智能体跑起来但没有已完成请求：面板行只有状态、名字与时长，不出现速度数字，也不出现 `0` 或 `--`；第一个请求结束后该行出现 `{n} tok/s`。
10. 一个子智能体跑了一会儿再看面板：行上的数字等于**该子会话**按 `query_source = 'subagent'` 算出的累计平均，而不是父会话的数字；同一个子智能体的数字在请求边界之间保持不变（它是累计平均，不随 token 逐秒跳）。
11. 同时跑多个子智能体：每个行显示各自读数；收起态 trailing 的数字与同一处的时长同指运行最久的那个子智能体（它的读数为空时 trailing 只有时长与状态摘要）。
12. 子智能体结束：行消失，它的读数同时从面板消失（不残留上一次的值）；运行集合清空后停止轮询，不再产生请求。
13. 对端不支持 `session/performanceBatch`（旧版 remote CLI）：行上不出现速度，状态、名字、时长、Stop 与「已结束的智能体」目录入口全部照常。
14. 一次传入超过 32 个会话 id：请求被 wire schema 拒绝；UI 侧先按输入顺序截断到 32，保留运行最久的那些，面板不报错。
15. 模型正在流式写工具入参（如 `Write` 的大段文件内容）：入口与面板「当前输出速度」按秒更新，不因为正文行已结束而显示 `--`；读到的数字只统计当前轮，切到新一轮后从零起算。
16. 工具执行或等待首 token 持续超过 3 秒没有新增输出：「当前输出速度」显示 `--`，入口回落累计平均。

## 已知限制

- 用量表按 `USAGE_RETENTION_DAYS = 30` 天滚动清理，保留期之外的会话统计为 0，入口隐藏。
- 工具耗时不含权限等待（与 `tool_usage.duration_ms` 的既有口径一致）。
- 实时估算基于字符而非真实 tokenizer，只服务入口与面板「当前输出速度」行；另外四行始终来自持久层。因此「当前」与「平均」并存且数值不同是预期表现，不是显示故障。工具入参按原始 JSON 字符折算，写文件类调用的估算值会比真实 token 偏高。
- 「当前输出速度（估算）」衡量的是客户端在当前轮最近 3 秒观测到的字符增量。缓冲后的突发内容仍可产生较高的估算值，`≈` 标识必须保留；它不证明模型实际解码速度。工具执行、等待首 token、被停止等没有新增输出的阶段显示 `--`。
- 累计行只在工作**完成**时前进：`model_usage` 只在整个请求结束时落行，`tool_usage` 的进行中行 `duration_ms` 为空。所以进行中的请求/工具对时长行贡献为 0，长工具调用或子代理等待期间面板可整段不动；加上「首 token 平均」与「平均输出速度」是整会话平均、样本多了之后收敛，这两行基本上不再变化。
- 子代理会话有独立 `session_id`，**不计入父会话的时长/速度行**；父会话面板要显示子智能体速度时，读的是该子会话自己的累计（规则 7），两个口径各自独立、互不换算。
- 子智能体速度是累计平均且只在请求结束时前进，因此它比图二那个入口数字「慢」：子智能体跑几分钟、每轮几十秒时，行上的数字一轮才变一次；子智能体刚开始跑的一段时间里没有数字。
- 面板统计的是整个会话累计，不提供按轮次拆分。

## 2026-11-24 修复验收与迁移边界

- 不改 `model_usage` 事实、不新增持久化表。平均 TPS 仅在 CLI 只读聚合层统一修正，历史请求立即按新口径重算；主会话与子会话仍保持 `main_turn` / `subagent` 隔离。
- 内部聚合结果把误命名的 `generationMs` 改为 `tpsDurationMs`；wire `summary.tokensPerSecond` 字段不变。所有 writer / reader 使用公开 contracts，desktop-continuous 与 web-remote-replayable 不新增事件或快照状态。
- 截图主会话样本：5281 输出、195313ms 总耗时、173257ms TTFT，平均必须为约 27.04 tok/s（入口取整 27），不能再得到 239。
- 截图两个子会话样本：11522 / 342695ms 与 9164 / 267169ms，平均必须约为 33.62 与 34.30 tok/s（卡片均取整 34），不能再得到 502 / 803。
- 单请求 529 输出、15650ms 总耗时、15140ms TTFT 时平均必须约 33.80 tok/s；TTFT 缺失或等于总耗时仍按总耗时计入。无效／零耗时的输出不得只进入分子。
- 实时采样从旧轮 100 token 切到新轮首样本 900 token 时必须清空旧样本，不能把差值 800 当成一秒输出；切会话及补历史／裁切窗口也遵守同一边界。
- 手机触摸通过既有 pointerdown 打开统计面板，阻止 Radix 的被动 touchstart listener 调用 preventDefault；真实 tap 不产生控制台错误。
- 浏览器验证中英文、明暗、桌面与手机：平均与子卡片显示新值，实时行明确显示估算且实时入口带 `≈`；等待时回落平均，无横向溢出。真实客户端的突发传输不做硬上限或虚构平滑。

## 已执行验证（2026-11-24）

- 累计 TPS 正式 SQLite / 单会话与批量协议回归 42/42 通过；实时作用域采样回归 29/29 通过。测试先确认旧实现失败，再验证新总耗时口径和显式 scope 重置。
- 真实 Chrome 中英文 × zai-light/zai-dark × 1440×900 / 390×844 共 8 场景（含父测试 9/9）通过：主会话 27、两个子卡片 34/34，实时一秒增量显示 `≈ 100 tok/s`，换轮/补历史/裁切首样本不产生旧值差分，停下或无输出回落平均。
- 最后一轮 `pnpm test:desktop-regressions` 整体 107 passed、0 failed、1 非 Windows 分支 skipped，已接正式提交前入口。根类型、Lint（69 warnings、0 errors）和架构门禁通过。
- 不修改历史用量事实，不硬裁剪有效高速度。修正的是平均速率的端到端分母与估算标识，不能将其作为模型纯解码性能基准。

## E2E 锚点

- `TID_CHAT_SESSION_STATS_TRIGGER`（`packages/shared/src/test-ids.ts`）：工具条入口按钮，`data-chat-toolbar-popover-trigger="true"`。
- `TID_CHAT_SESSION_STATS_PANEL`：会话统计面板根节点。
- 子智能体速度（规则 7）：状态面板里带 `data-subagent-speed="true"` 的节点——展开时在智能体行内，收起时在「智能体」分区 trailing；节点缺席即表示该子智能体没有读数。行的既有锚点 `data-child-session-id` 用来把两者对上。
- 子智能体的名字：行内带 `data-subagent-name="<name>"` 的节点（缺席即没有名字），见 `specs/status-panel-subagent-identity.md`。
