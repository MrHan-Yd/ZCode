# 编排模式（Orchestrator）实施计划

> 状态：已批准，按阶段实现。每个勾选项只有在对应测试通过后才能标记为 `[x]`。
>
> 本文同时是产品规则与实施清单。实现过程中如果发现设计与源码冲突，先改本文再改代码。

## 1. 背景与目标

ZCode 现有两种使用方式：

1. 经典模式：主会话直接读写文件、执行命令、调用工具。
2. 现有子智能体：主会话按需调用 Agent 工具，但调度顺序由模型自由决定。

本次新增第三种使用方式：**编排模式**。主会话只负责规划、调度、汇总；子智能体执行具体任务；执行顺序由确定性 DAG 控制，而不是依赖模型自由发挥。

必须支持：

- 架构设计 → UI 设计 → 开发 → 测试的顺序依赖。
- 前端等待后端接口契约；契约确定后前后端可并行；两者完成后再测试。
- 按角色配置模型，默认“继承默认”。
- 执行中用户插入消息：追加指导 / 排队 / 停止并重排。
- 经典模式完全不变；所有新字段可选、默认关闭、缺省即经典。

非目标（v1 不做）：

- 按语言/框架拆几十个内置子智能体。
- 全局默认团队、逐轮临时团队。
- 云端电脑、多租户计费。
- 复用 `CreateWorkflow` 的“用户显式点名 workflow”产品语义。

## 2. 核心设计

### 2.1 编排计划（DAG）

```ts
interface OrchestrationPlan {
  planId: string;
  revision: number; // 用户重规划时递增
  goal: string;
  steps: OrchestrationStep[];
}

interface OrchestrationStep {
  stepId: string; // 稳定 slug
  title: string;
  role: string; // 必须在当前团队 subagentPool 内
  task: string; // 自包含 prompt
  dependsOn: string[]; // 前置步骤
  inputs?: "auto" | string[]; // 默认取前置步骤的结构化摘要
  writeScope?: string[]; // 写文件范围；并行冲突检测用
  acceptance?: string; // 验收标准
  maxAttempts?: number; // 默认 1 次重试
  optional?: boolean; // 失败不阻塞整体
}
```

调度规则：

- 校验：无环、依赖存在、`stepId` 唯一、`role` 在团队内、写范围不重叠。
- 拓扑执行；就绪步骤并行，默认并发上限 3。
- 写范围重叠的步骤串行，不允许并行改同一批文件。
- 每步输出存为产物引用；下游只拿摘要/引用，不把完整输出堆进主会话。
- 失败：重试 `maxAttempts`；仍失败则标记 failed，依赖它的步骤 blocked，主会话收到失败摘要并可重规划。
- 全部完成/失败后，主会话收到结构化汇总并给用户最终答复。

### 2.2 主会话工具面

只保留：

- `CreateOrchestrationPlan`
- `AmendOrchestrationPlan`
- `CancelOrchestrationRun`
- `AskUserQuestion`
- `TodoWrite`
- 只读检索工具（Read / Glob / Grep / WebFetch / WebSearch）

`Edit` / `Write` / `Bash` 对主会话不可见，且 **executor 层硬拒绝**。不能只靠工具描述或可见性过滤。

子智能体保留完整工具面；child runtime 强制 `agentRole = "default"`，不递归派发。

编排 run 异步执行：工具返回 `runId + async_launched`，完成后通过现有 completion notification 唤醒主会话汇总。

### 2.3 团队与模型

内置 8 个角色：

| 角色              | 只读 | 职责                                      |
| ----------------- | ---- | ----------------------------------------- |
| `general-purpose` | 否   | 通用执行兜底                              |
| `Explore`         | 是   | 只读检索代码/文件                         |
| `architect`       | 是   | 架构、模块边界、接口契约、ADR             |
| `frontend`        | 否   | Web/桌面/移动/小程序，栈自适应            |
| `backend`         | 否   | Node/Python/Java/Go/Rust/C#/PHP，栈自适应 |
| `ui-designer`     | 是   | 设计 token、布局、状态、动效规范          |
| `tester`          | 否   | 单测、集成、E2E、契约、性能               |
| `reviewer`        | 是   | 逻辑、安全、性能审查                      |

规则：

- 默认团队 3 个：`general-purpose`、`Explore`、`tester`。
- `general-purpose` 强制保留，作为至少一个执行型兜底。
- 语言/框架只做标签 + 栈自适应 + skills，不拆独立 agent。
- 每个角色模型默认“继承默认”（不写 `modelSelection`）；设置页按角色覆盖；团队选择器只显示“继承默认/模型名”，不编辑模型。
- 首次开启且无团队时自动打开选择器一次；之后不再自动弹。
- 团队按会话隔离；软上限 6、硬上限 8。
- 只把选中的 profile 注入 Agent 工具描述与派发解析；未选角色不可派发。

### 2.4 执行中插入消息

运行中发送框提供三种语义：

1. **追加指导**（默认）：作为 `guide` 注入主会话规划上下文；主会话可调用 `AmendOrchestrationPlan`。未失效的运行步骤继续，失效步骤取消并按新 revision 重派。
2. **排队**：复用现有 queue；当前 run 完成后作为下一条输入处理。
3. **停止并重排**：取消当前 run（已完成的步骤产物保留），递增 `revision` 与 `runGeneration`，用用户新消息重新规划；旧 generation 的迟到结果一律丢弃。

保证：

- 用户消息不丢失；取消时消息成为新计划输入。
- 运行中子智能体不静默杀死；取消走显式 cancel 命令，保留部分产物。
- 同一 step attempt 使用稳定幂等键；重试不重复写。
- 顺序只由 DAG + 依赖保证，不依赖网络到达顺序。

## 3. 所有权与持久化

```text
UI 草稿/会话意图
  → createSession / setOrchestration 命令
  → Host 校验 + 持久化投影
  → CLI runtime: agentRole + subagents.visibleProfiles
  → Agent 工具描述只包含 visibleProfiles
  → 主会话 turn 级 denylist：Edit/Write/Bash 不可见且执行边界拒绝
  → 子代理完整工具面，agentRole=default，不递归派发
```

唯一事实源：

- **运行期权威**：CLI session store 的 `runtime/orchestration` entry（`agentRole` + `subagentPool`），冷恢复只信它。
- **列表/UI 投影**：`ZCodeTaskMeta.meta_json` 增加同名字段；snapshot 同步时必须 `?? existingMeta` 保留，不能把字段冲掉。
- **UI 草稿**：`V4ComposerDraft` 保存意图；发送时冻结进 submission。
- **内置角色定义**：`packages/shared/src/builtin-subagents.ts` 存纯展示元数据；CLI core 存 system prompt 与 `permissionMode/maxTurns`；services 消费同一份元数据，避免多处漂移。
- **编排 run**：CLI 侧独立 run journal（`orchestration_runs` / `orchestration_steps` / `orchestration_events` 或等价 JSONL + snapshot），不修改 tasks-index 的冻结表结构。Host/UI 只读投影。

### 3.1 Phase 2 / Phase 3 的运行记录与派发边界

Phase 2 提供 CLI core 的独立执行能力及公开接口；Phase 3 在其上接入主会话工具面与 completion 唤醒。协议命令、UI 入口与 Host 下发仍分别在 Phase 5 / 6 接入。默认关闭的经典会话不会创建 run journal，也不会改变现有子代理派发路径。

```text
主会话工具调用
  → OrchestrationService（计划校验 / 团队归一化 / runId 分配）
  → RunStore.create（唯一写入入口，冻结计划与 generation）
  → dispatcher.execute 异步驱动（不阻塞工具返回）
  → 工具返回 { status: "async_launched", runId, ... }
  → run 终态：RunStore 已提交 → 构造有界摘要
  → enqueueBackgroundTaskNotification → 主会话下一轮汇总

Amend → 取消旧 run（保留已完成产物）→ revision + 1 → 新建 run
Cancel → RunStore.cancel + generation + 1 → stopTask → 迟到结果拒绝
```

编排主会话的配置所有权：Host 通过 `AgentRuntimeConfig.orchestration` 下发 `enabled / team / maxConcurrency`；`AgentRuntimeDeps.orchestrationJournal` 与 `orchestrationArtifactStorage` 提供存储工厂。缺少存储时工具仍按配置注册，但调用返回明确的 `capability_unavailable`，不静默降级成经典模式。

- **状态所有者**：`OrchestrationRunStore` 是 run / step / attempt 的唯一写入入口，内部调用纯 scheduler。driver 只保留当前执行 Promise 与取消信号，不维护第二份可写 run 状态。
- **模块接口**：CLI `contracts/src/orchestration` 声明 run / attempt / journal / artifact 的端口与持久记录校验；core 的 `orchestration` 只含状态机、用例和纯预算逻辑；`adapters/src/orchestration` 通过 `@zcode/shared/node` 的文件锁与私有原子写执行 IO。所有跨包依赖走公开入口，不从 adapters 反向导入 core。
- **落点**：由调用方注入 CLI 数据根目录；按 `workspaceIdentity?.trim() || workspacePath`、父 `sessionId` 与 `remoteSessionId` 隔离；identity 相同的展示路径变化不改变身份。runId / attemptKey 只参与哈希文件名，不作为裸路径；owner 空路径 / 空会话明确拒绝；目标目录及 `.lock` 不得通过 symlink / junction 逃逸数据根，文件锁获取前必须 fail-closed 校验，不能回收根外目录条目。每个 run 的原子 snapshot 同时包含计划、步骤、attempt 历史与单调事件序列，不修改 tasks-index。
- **写范围身份**：writeScope 表示 workspace 相对文件 / 目录或全范围 `*` / `**`，目录末尾 `/**` 按整个目录保守处理；分隔符统一，折叠内部 `.` / `..`，`.` 或折叠到根目录视为 `*`。绝对路径、drive-relative 路径、越过 workspace 根的 `..` 与其它未定义 glob 明确拒绝为 `invalid_write_scope`，不能用字符串别名绕过串行。跨平台冲突比较保守忽略大小写（大小写敏感系统可能多串行，但不会漏掉大小写不敏感系统的冲突）；实际文件操作仍使用 workspacePath，不进行磁盘解析或引入持久缓存。
- **领取顺序**：先原子持久化 running step 与 claimed attempt，再用领取后的已提交快照构造依赖输入并启动 child；不得用领取前的快照判定前置产物。拿到 child 身份后记录 agentId / taskId / childSessionId，等待 terminal 结果，先落产物再提交步骤终态，最后才领取依赖步骤。并行结果的落盘由同一 store 串行提交。
- **历史准入校验**：持久记录按事件 sequence 一次回放，claim 必须发生在依赖已满足之后，而不是只校验最终状态或时间。required 依赖必须先 completed；optional 依赖仅在最终 failed / blocked / cancelled 后可放行，仍处于重试 pending 或 interrupted 时不放行；取消 / 中断后禁止新 claim。同一轮多个 claim 仍检查并发上限和规范写范围重叠。回放状态是校验过程内的临时派生值，不成为第二事实源；最后与 snapshot 的 step 状态及 attempt 计数核对。损坏记录返回 `invalid_record`，不修改或删除原 journal。
- **幂等边界**：attemptKey 由 runId / plan revision / generation / stepId / attempt number 构成；重复领取、重复 terminal 回写和同 key 产物写入不产生第二次派发或覆盖。`maxAttempts` 沿用已批准语义，表示额外重试次数；默认 1，总执行次数为 2，上限 5 次重试。
- **副作用限制**：当前 `SubagentPort` 不支持 request 级稳定 agentId，也不能把启动 child 与 journal 写入合成跨进程事务。不能将 journal 幂等宣称为任意文件 / 命令副作用的 exactly-once。冷恢复时已完成步骤保持完成；尚未领取的 pending 步骤可以继续；没有可靠 terminal 证据的 running attempt 标记 interrupted 并暂停 run，不盲目重放写入、不自动扣重试。Phase 6 再通过持久 child session 对账后恢复。
- **冷恢复与损坏**：只允许已取得 session owner / lease 的调用方执行恢复；旧 generation 回写被拒绝。未知版本、错误 owner、计划或记录损坏明确报错，不当作空 run，也不删除历史。blocked 必须能追溯到真实的非 optional 失败依赖；一个步骤只有前次 failed 才能进入重试，completed / cancelled / interrupted 后不得伪造新 attempt。临时写入文件由 `finally` 清理；每次提交完成后再发布新状态。
- **取消**：先持久化 cancelled 并递增 generation，再通过显式 `stopTask` 停止 child；取消 wait 本身不等于停止 child。启动过程中收到取消时，child 身份返回后也必须停止。已完成产物、child session / outputFile 引用保留；迟到结果不能将 cancelled / interrupted 步骤改为 completed，也不能开启依赖步骤。父 driver 的 observation wait 必须响应显式取消 / 中断，即使 child 不返回终态也能结束父等待；这不能代替 `stopTask`，停止失败必须保留并报告原错误。当前 `stopTask` 的确认不等于 child 的 finally 已退出或文件副作用已经静止，不能立刻把同写范围交给重排步骤；Phase 4 / 6 装配重排前必须补齐 child 停止收口与对账。
- **产物预算**：每 attempt 独立保存 UTF-8 文本与引用；原文 / 摘要包含未配对 UTF-16 surrogate 时明确拒绝，不允许编码替代字符造成不同原文的幂等键内容冲突被掩盖；默认正文上限 1 MiB、摘要上限 4 KiB、下游输入总预算 16 KiB。超限按 UTF-8 字符边界保留首尾并标记截断；引用包含原始 / 保存字节数和内容校验值。同 key 不同内容报冲突，不覆盖。下游只获得结构化摘要和引用，`inputs: auto` 取直接依赖；显式 inputs 必须引用依赖祖先，不能读取未来步骤。
- **完成判断**：只有 child terminal 状态与 `AgentCompletedOutput` 同时表示 completed 才成功；`async_launched` 只是启动确认。failed 可按计划重试；lost / 缺 terminal 输出属于 interrupted，禁止猜测成功或重试写入。

```text
父 session owner / lease
  → RunStore 持久领取 attempt（稳定 key / generation）
  → SubagentPort.start（按 step.role 与现有 profile 选模）
  → RunStore 记录 child 身份
  → waitForTask terminal
  → Artifacts 原子写正文 / 摘要 / 引用
  → RunStore 幂等提交 terminal
  → scheduler 领取后继步骤

cancel → RunStore cancelled + generation 增加 → stopTask → 保留已确认产物与 child 引用
cold restore → 校验 owner / snapshot → completed 不动，running 无证据则 interrupted，禁止重放
```

验收测试包括：原子往返与事件序列、并行领取、重复回写、旧 generation、owner / 路径隔离、损坏记录、冷恢复不重跑、UTF-8 预算、产物冲突、真实 port 形状下的顺序 / 并行 / join / 重试、取消启动中 child 和 lost 结果。额外覆盖点段 / 分隔符 / 根范围别名、大小写保守冲突、越界及绝对范围拒绝、领取先于依赖完成的乱序快照、optional 重试未完成时的非法放行、失败传播及取消 / 恢复合法历史。Phase 2 正式 core 测试纳入根 `pnpm typecheck`，并保留可单独执行的类型检查入口，避免只用 tsx 运行而漏掉类型错误。

性能约束：本轮不削弱 journal / RunStore 的独立记录校验，不新增跨事务缓存。单次校验内建立 step / attempt 索引及一次依赖闭包，写范围每份列表只规范化一次，事件按 sequence 单次遍历；避免每条事件重扫计划或每对文件重复规范化。用固定输入、预热、多轮中位数比较 8-step 典型和 32-step / 64-scope / 最多 6 次执行的压力纯函数基线，分别报告样本和耗时，不将微基准写成真实模型 / UI 的性能提升。

## 4. P0 决策

- [x] 0.1 创建本文件，作为 spec + 实施清单。
- [x] 0.2 run 持久化落点：新建 CLI 侧 orchestration run journal，参照现有 workflow run journal 的 run/step/attempt/事件模式；不改 tasks-index 冻结表结构。列表与 UI 通过协议投影读取。
- [x] 0.3 引擎选择：**不复用 dynamic workflow 引擎**，新建独立 DAG 调度器。原因：
  - `CreateWorkflow` 的产品语义是“用户显式点名 workflow”，与常驻编排冲突；
  - workflow child 有独立的工具禁用、actor/journal 语义和 UI 呈现，直接复用会混淆产品概念；
  - 编排需要声明式 DAG、写范围冲突检测、用户插入消息与 generation fencing，workflow 脚本不是为此设计的。
  - 复用点限定为：subagent 启动/完成通知、run journal 存储模式、事件流与 UI 投影模式。
  - 该结论基于当前源码静态分析；如果后续实现发现 run journal 可直接复用，再在本文更新。
- [x] 0.4 定义 `OrchestrationPlan` / `OrchestrationStep` / run 状态机 / 事件 / 错误码（见第 2、3 节）。

## 5. 阶段清单

### Phase 1 — 内置角色库 + 按角色模型配置（6–10 人日）

- [x] 1.1 `packages/shared/src/builtin-subagents.ts`：8 角色元数据、tags、只读、默认工具面。
- [x] 1.2 `apps/zcode-cli/packages/core/src/subagent/builtin-agents.ts`：6 个新角色 prompt/profile。
- [x] 1.3 扩展 `BuiltInSubagentName`、`BUILT_IN_SUBAGENT_NAMES`、services/bootstrap 保留名。
- [x] 1.4 修复 `subagent-state-migration.ts`：新角色模型覆盖不被迁移删除。
- [x] 1.5 设置页内置角色模型覆盖：默认“继承默认”；8 角色都能配置。
- [x] 1.6 UI `getBuiltInSubagentName`、tags 展示；角色名/描述/标签属于数据，不新增 i18n key。
- 验收：8 个角色出现在设置页；模型覆盖可设/可清除；迁移后覆盖不丢。
- 测试：角色目录/顺序/颜色/只读；`agents-state.json` 往返与迁移；保留名；`pnpm --filter @zcode/core build`。
- 验证记录：
  - `node --import tsx --test apps/zcode-cli/packages/core/test/builtinAgentProfiles.test.ts`：5/5 通过。
  - `node --import tsx --test packages/shared/src/builtin-subagents.test.ts`：3/3 通过。
  - `node --import tsx --test packages/services/test/builtinSubagents.test.ts`：2/2 通过。
  - `node --import tsx --test packages/ui/test/builtinSubagents.test.ts`：2/2 通过。
  - `pnpm exec tsc -b packages/shared packages/services packages/ui`：通过。
  - `pnpm --filter @zcode/core build`：通过。
  - `pnpm lint`：0 errors（70 个既有 warning，均不在本次改动文件）。
  - `pnpm typecheck`：本次改动文件无错误；仓库仍有 3 个既有的 `packages/server/src/remote/*.ts` implicit-any 错误，未在本次范围内修改。

### Phase 2 — DAG 调度引擎（12–18 人日）

- [x] 2.1 `packages/shared/src/orchestration.ts`：schema、校验（环/缺依赖/角色不在团队/写范围重叠）。
  - 验证记录：`node --import tsx --test packages/shared/src/orchestration.test.ts` 7/7 通过，新增显式 inputs 只能引用唯一依赖祖先的校验。
  - 写范围重叠按 warning 处理，调度器负责串行；可写角色缺少 `writeScope` 是 error。
- [x] 2.2 `orchestration/scheduler.ts`：拓扑执行、并行上限、写范围串行、重试、blocked、取消（纯状态机；运行时派发见 2.5）。
  - 验证记录：`node --import tsx --test apps/zcode-cli/packages/core/test/orchestrationScheduler.test.ts` 9/9 通过。
  - `claimRunnableSteps` 同步 claim 并标 running；写范围重叠的步骤跳过，留到下一轮串行。
- [x] 2.3 `orchestration/runStore.ts`：run/step/attempt 持久化、幂等键、冷恢复。
  - `contracts/src/orchestration` 提供端口与严格记录校验；`adapters/src/orchestration/journal.ts` 使用进程 / 跨进程文件锁与原子私有 snapshot，所有写入通过 RunStore 的事务入口。
  - 已完成步骤不重跑；无可靠 terminal 的 running attempt 恢复为 interrupted，保留 child 与历史；完整 child session 对账续跑仍在 Phase 6。
  - `orchestrationRunStore.test.ts` 20/20、`orchestrationRecordValidation.test.ts` 4/4、`orchestrationPathValidation.test.ts` 2/2 通过。
- [x] 2.4 `orchestration/artifacts.ts`：步骤输出摘要与产物引用、输出预算。
  - 正文 / 摘要 / 输入预算分别为 1 MiB / 4 KiB / 16 KiB；同 key 相同内容幂等、不同原文冲突；不把完整 child 输出回灌父上下文。
  - `orchestrationArtifacts.test.ts` 15/15、`orchestrationTextValidation.test.ts` 1/1 通过。
- [x] 2.5 子代理派发适配：按 `step.role` 启动、等待 completion、回写 step 状态；复用现有 Agent/subagent runtime。
  - `SubagentOrchestrationDispatchAdapter` 使用现有 start / getTask / waitForTask / stopTask；`OrchestrationDispatcher` 负责领取后的快照、异步派发、显式取消、迟到结果拒绝与失败汇总。
  - `orchestrationDispatcher.test.ts` 7/7、`orchestrationDispatchAdapter.test.ts` 4/4、`orchestrationCancellation.test.ts` 2/2、`orchestrationSnapshot.test.ts` 1/1 通过。
  - 本阶段是可注入的 core 执行能力，未装配主会话工具 / 协议 / completion 汇总入口；未进行真实模型、Desktop / Mobile 编排 E2E。对应入口仍在 Phase 3 / 5。
- 2026-11-18 验证记录：
  - 内置角色与 Phase 2 正式测试合并执行：84/84 通过，其中 Phase 2 为 72 项。
  - `pnpm --filter @zcode/contracts build`、`pnpm --filter @zcode/core build`、`pnpm --filter @zcode/adapters typecheck`、`pnpm exec tsc -p apps/zcode-cli/packages/core/tsconfig.orchestration-test.json`：通过。
  - `pnpm exec tsc -b packages/shared packages/services packages/ui` 与 services 正式测试类型检查：通过。
  - `pnpm --dir apps/zcode-cli typecheck / lint` 因 CLI 本地找不到 turbo 未启动任务；使用根目录现有 `pnpm exec turbo --cwd apps/zcode-cli run typecheck` 补跑通过（有本地 turbo 缺失与旧 lockfile workspace 警告，未修改依赖或 lockfile）。
  - 根 `pnpm lint`：0 errors、70 warnings，与本次实现前一致；新增编排代码与正式测试定向 Lint：0 errors、0 warnings。
  - CLI 全量 Lint 补跑未通过：`pnpm exec turbo --cwd apps/zcode-cli run lint --continue` 仍有 84 个存量文件 max-lines 错误、52 warnings；新增编排源文件均低于 400 行且无定向 Lint 错误，未扩大范围重构旧文件。
  - 根 `pnpm typecheck` 未通过：仍是本次实现前同样的 3 个 TS7006，分别为 `packages/server/src/remote/deployShared.ts:102`、`remoteDeployLock.ts:103`、`serverBundleDeployCheck.ts:57` 的 `code` 参数。新增正式测试的单独类型检查通过，不将全仓失败写成通过。
  - `pnpm architecture:check --changed`：violations 0 / baseline 0 / new 0；本阶段代码审查发现的快照竞态、停止失败等待、不可达记录、UTF-8 冲突与锁链接越界均已用正式测试复现并修复，终审无剩余阻断项。
- 2026-11-18 缺陷修复与复测记录（写范围别名 / 历史准入）：
  - 独立审查确认两处缺陷：`src` 与 `other/../src` 被视为不同范围而并行领取；持久记录只校验最终状态，`b dependsOn a` 的 claim 事件可排在 `a` 完成之前仍被接受。两者均先用正式测试复现（新增回归三文件 27 项中 18 通过 / 9 失败，失败项全部对应目标缺陷），再实现修复。
  - 修复落点：`packages/shared/src/orchestration-write-scope.ts` 统一规范写范围并保守按大小写比较；`contracts/src/orchestration/record-history.ts` 按事件 sequence 单次回放准入、并发与写范围约束，并与 snapshot 核对。回放中的 step 状态只是校验期临时派生值，不写回记录。
  - 二次独立审查追加的两项已修复：写范围规范化补齐 Win32 会剥离的每段尾随空格与尾随点——先剥尾随空格再识别 `.` / `..`，其余尾随的「点 + 空格」混合串整体剥到非点非空格为止（`src.`、`src `、`src .`、`a/ . /b`、`a/. ./b`、`a/.. ./b`）——并对非 ASCII 键做 NFC 归一化，避免 Windows / macOS 的等价名字绕过串行；事件矩阵强制 run 级事件（`run_created` / `run_cancelled`）不得携带 `attemptKey`、attempt 级事件必须携带，杜绝伪造 `run_cancelled + attemptKey` 在不递增 generation 的情况下关闭 run。事件矩阵以 `Record<OrchestrationEventType, ...>` 声明，新增事件类型必须显式标注规则。
  - 语义与 store 对齐：required 步骤被取消会让 run 进入 `cancelled` 终态并停止领取；optional 取消只阻塞依赖它的步骤；per-attempt `interrupted` 关闭准入但允许同 generation 在飞步骤绑定与收口。以上均补了合法历史回归。
  - 测试：`packages/shared/src/orchestration.test.ts` 11 项、`orchestrationScheduler.test.ts` 10 项、`orchestrationAdmission.test.ts` 10 项，共 31/31 通过；Phase 1 + Phase 2 全量 99/99 通过（新增 15 项，其中 3 项对应二次审查的别名与事件矩阵）。
  - 性能对比（固定 fixture，5 次预热、7 轮中位数，纯函数内存输入，Node v24.14.0）：

    | 用例          | 规模                              | plan 校验（前 → 后，µs） | record 校验（前 → 后，µs） |
    | ------------- | --------------------------------- | ------------------------ | -------------------------- |
    | typical-8     | 8 步 / 2 scope / 1 次 / 17 事件   | 27.7 → 30–41             | 127.6 → 148–174            |
    | retry-32      | 32 步 / 4 scope / 6 次 / 385 事件 | 1487.0 → 271–332         | 2248.9 → 1321–1469         |
    | wide-scope-32 | 32 步 / 64 scope / 1 次 / 65 事件 | 710371.4 → 23700–25300   | 696823.2 → 26000–28900     |

  - 结论边界：典型小计划的差异处于本机测量噪声与新增加的历史回放开销范围内；压力用例分别快约 4–5 倍和 23–28 倍。该结果是纯函数微基准，不代表真实模型调用或 UI 端到端性能。
  - 本轮未削弱 journal / RunStore 的独立记录校验，也未引入跨事务缓存；写范围只在单次校验内首次使用时规范化并复用，串行 run 不会为未发生的并发比较付出规范化成本。
  - 未采纳的建议及理由：事件 `at` 必须等于 `updatedAt` 属于额外收紧，现有快照已由「最后事件 generation + 快照逐字段比对」约束，暂不叠加；默认重试次数 `1` 仍分散在 shared / contracts / core 三处（语义已在本文与测试中固定），未为此新增跨包公开常量；记录 `error` 文本不参与回放比对（不影响调度安全）；Phase 2 尚无线上持久记录，未引入记录版本迁移。
  - 质量门：`pnpm exec tsc -p .../tsconfig.orchestration-test.json`、`pnpm --filter @zcode/core typecheck`、`pnpm --filter @zcode/adapters typecheck`、`packages/shared` 单独类型检查通过；根 `pnpm typecheck` 仍是既有的 3 个 `packages/server/src/remote/*` TS7006（与本轮无关）；根 `pnpm lint` 0 errors / 70 warnings；根 `pnpm exec turbo --cwd apps/zcode-cli run typecheck` 27/27 通过；CLI 全量 Lint 仍是 84 个存量 max-lines 错误 / 53 warnings，本轮新增文件定向 Lint 为 0；`pnpm architecture:check --changed` violations 0 / new 0；本轮改动文件 `oxfmt --check` 通过。
  - 仍未装配：主会话规划工具、协议命令、completion 汇总与 UI 入口属于 Phase 3 / 5；`stopTask` 确认到 child 副作用静止的对账属于 Phase 4 / 6。

- 验收：architect→ui-designer→frontend 顺序；契约后 frontend/backend 并行；tester 等两者完成。
- 测试：无环校验；串行依赖不提前启动；并行同时启动；join 等待；失败重试/阻塞；写范围冲突串行；冷恢复不重跑已完成步骤。

### Phase 3 — 主会话规划与工具面（6–9 人日）

- [x] 3.1 `CreateOrchestrationPlan` / `AmendOrchestrationPlan` / `CancelOrchestrationRun` 工具与 JSON schema。
  - `core/src/orchestration/tools.ts` 提供三个工具入口；`OrchestrationService` 是工具面唯一用例入口，工具 handler 不直接接触 store / journal / dispatcher。
  - 团队与并发上限来自会话配置（`AgentRuntimeConfig.orchestration`），工具入参只接受计划本身，模型不能自行改写团队。
  - `AmendOrchestrationPlan` v1 语义：先取消旧 run，再以 `revision + 1` 启动新 run；已完成步骤产物保留在旧 journal，自动复用与 guide 注入属 Phase 4。
- [x] 3.2 编排模式工具白名单 + executor 硬拒绝 Edit/Write/Bash。
  - provider 边界：`resolveOrchestratorHiddenToolNames` 把 registry 中白名单之外的工具加入 turn 级 `toolDisallowlist`，模型请求只看到 `ORCHESTRATOR_ALLOWED_TOOL_NAMES`（三个规划工具、AskUserQuestion、TodoRead/TodoWrite、Read/Glob/Grep/WebFetch/WebSearch）。
  - 执行边界：executor 的 `hardAllowedToolNames` 对白名单之外的任何调用（包括 Edit/Write/Bash/Agent/Task/js 与 MCP 工具）在 handler、hook、权限判定之前返回 `permission_denied`。
  - registry 保持完整：DAG 子代理的 `allowedTools: ["*"]` 从父 runtime 的实际工具表继承，注册面若只剩只读工具会让 frontend/backend/tester 无法写文件。子代理的编排工具由 `includeOrchestration` 注册门与 `orchestration: { enabled: false }` 双重挡住。
  - 编排主会话没有 Bash，`resolveRuntimeEmbeddedSearchEnabled` 直接返回 false，保留 Glob/Grep 只读检索。
- [x] 3.3 orchestrator system prompt 段（仿 workflowActor，不用 `customSystemPrompt`）。
  - `context/sections/orchestrator.ts` 追加稳定的 `orchestrator` section：工具面、团队、可写角色、DAG 规则、异步通知语义与 Plan 只读约束。
  - 保留正常 Agent Identity；`customSystemPrompt` 仍是整段替换语义，不与编排段叠加。
- [x] 3.4 异步 run 生命周期：`async_launched`、completion notification、汇总唤醒。
  - 工具返回 `{ status: "async_launched", runId, planId, revision, stepCount, team }`；`OrchestrationService.launch` 异步驱动 dispatcher。
  - run 结束后复用 `enqueueBackgroundTaskNotification` 投递结构化摘要（步骤状态、错误、artifact 引用，12 KiB 上限），唤醒主会话汇总；基础设施失败也会投递失败通知，不会让主会话无限等待。
  - 通知刻意不注册 runtime task：停止语义只属于 `CancelOrchestrationRun`，避免出现第二个可停止身份。
- [x] 3.5 子代理强制 `agentRole=default`；禁止递归；Plan+编排=只读编排。
  - 子 runtime 的显式 config 中写入 `orchestration: { enabled: false }`；`isOrchestratorRuntimeConfig` 同时要求 `taskType !== "subagent_child"`，即使配置泄漏也拿不到编排工具面。
  - `shouldForceOrchestrationReadOnly` 在父会话 plan / planEnabled 时把 DAG 子代理强制为 plan，覆盖 profile 自带的 `permissionMode: "auto"`。
  - 子代理工具面完整：主会话 registry 不因编排白名单而收窄，child 的 `allowedTools: ["*"]` 继续继承 Edit/Write/Bash 等工作工具；Agent/Task 仍由既有 `isSubagentDispatchToolName` 过滤，禁止递归派发。
- 验收：主会话无法直接改文件；计划外角色不可派发；run 完成后主会话收到结构化摘要。
- 测试：工具 schema；主会话工具表；幻觉调用被 executor 拒绝；子代理工具完整；未选角色被拒；stale generation 结果丢弃。
- 2026-11-18 验证记录：
  - 工具白名单在 provider 边界用 turn 级隐藏实现，executor 用 `hardAllowedToolNames` 独立兜底；registry 保持完整，避免收窄 DAG 子代理的工具继承。`orchestrationRuntimePolicy.test.ts` 同时覆盖 hidden 名单、注册门与 executor 拒绝。
  - 新增 `orchestrationRuntimePolicy.test.ts`（6 项）、`orchestrationTools.test.ts`（5 项）、`orchestrationService.test.ts`（5 项）、`orchestrationPrompt.test.ts`（3 项），共 19 项。
  - 编排全量测试 95/95 通过（原 76 项 + 新增 19 项）。
  - `pnpm --filter @zcode/core typecheck`（含 `tsconfig.orchestration-test.json`）通过。
  - `pnpm lint`：0 errors / 70 warnings（与实现前一致）；`pnpm architecture:check --changed`：violations 0 / baseline 0 / new 0。
  - 改用 `pnpm --dir apps/zcode-cli exec oxfmt --check ...` 定向检查，24 个改动文件全部通过；根 `pnpm fmt:check` 在该基线上会列出大量既有文件，不作为本轮信号。
  - 装配边界：core 已消费 `AgentRuntimeConfig.orchestration` 与 `AgentRuntimeDeps.orchestrationJournal` / `orchestrationArtifactStorage`，但 Host/protocol 尚未下发该配置或注入工厂；用户可见入口、`setOrchestration` 命令与 UI 时间线仍属 Phase 5，冷恢复 entry 与 tasks-index 投影仍属 Phase 6。

### Phase 4 — 执行中插入消息（6–10 人日）

- [x] 4.1 运行中发送菜单：追加指导 / 排队 / 停止并重排。
  - Core 语义已落地：`PromptAdmissionOptions.orchestrationInput`（`guide` 默认 / `queue` / `interrupt`）由 `orchestration/input-policy.ts` 的纯决策表消费；未知值一律回落 guide，不会被猜成取消。
  - 菜单渲染、发送框三态与 composer 接线仍属 Phase 5.5；本阶段只保证 CLI admission 对三种语义的行为确定。
- [x] 4.2 guide 注入主会话规划上下文；`AmendOrchestrationPlan` 应用新 revision。
  - 主会话 prompt 增加独立的 dynamic `Orchestration Run State` 段（`context/sections/orchestrator.ts`），每轮 context rebuild 从 `OrchestrationService.promptState()` 取 run 级摘要；稳定的调度约束仍保持 `cacheHint: "stable"`，不动 system prefix 缓存。
  - 静态规则明确：活动 run 期间的新用户消息按 guidance 处理，只调整约束时用活动 runId 调 `AmendOrchestrationPlan`；latest run 已 cancelled/interrupted 且用户改方向时重新规划，不得把取消步骤报成完成。
  - `amend` 继续保证 `revision = max(请求 revision, 旧 revision + 1)`，旧 run 的 journal 与已完成产物保留可查。
  - 明确边界：本阶段不把旧 run 的 completed 步骤种子化进新 run。持久记录要求每个 completed 步骤都有 claim/complete 事件历史，跨 run 复用需要新增事件类型或记录版本，留给后续增量；旧产物仍保留在旧 journal。
- [x] 4.3 停止并重排：cancel run、保留已完成产物、递增 generation、重规划。
  - `OrchestrationService.cancelActiveRuns()` 对全部在飞 run 先持久化取消（`generation + 1`、在飞 attempt/step 收口 cancelled），再显式 `stopTask`；任一 child 停止失败汇总为 `AggregateError` 记录，不会吞掉触发它的用户消息。
  - runtime 在 `interrupt` admission 先取消 run，再按正常路径接纳新消息；模型从 dynamic run 段看到 latest run 为 cancelled，并按新消息重新规划。旧 generation 的迟到结果继续由 RunStore fencing 拒绝。
- [x] 4.4 排队：复用现有 queue；run 完成后处理。
  - `queue` 在空闲主会话时不启动新 turn：写入既有 held queue（`TurnSteerQueued` + session input 账本），并注册 `whenIdle()` 提升；提升前先取 queue reservation（与 UI sendQueuedNow 同一把锁），再 `discardHeldPendingInputById(..., "promoted")` 摘除同一条目，最后走普通 admission，避免重复执行。
  - 用户手动 sendQueuedNow / 删除后提升器发现条目已不在 held queue，直接跳过；run 在等待期间被取消也会正常提升，只有 session teardown 才放弃。
  - 协议命令、Host 下发与 UI 队列行仍属 Phase 5；进程重启后的未消费消息恢复属 Phase 6.1。
- [x] 4.5 幂等/顺序：每 step attempt 稳定键；取消/重试不重复写；用户消息不丢。
  - attemptKey（runId / revision / generation / stepId / attempt）与 generation fencing 沿用 Phase 2 实现；新增测试确认 interrupt 取消后 generation 递增，已完成步骤的产物引用仍留在旧 journal。
  - 排队消息以事件 + session input 账本为权威，提升是「先摘除、后 admission」的幂等顺序；admission 失败只记录日志，不丢弃队列事件。
- 验收：插入“改用另一个方案”能停止并按新方案重排；插入“补充一点约束”能继续当前计划；选择排队不会打断。
- 测试：guide 改写计划；interrupt 取消运行中步骤并保留完成产物；queue 顺序；generation fencing；进程重启后未消费消息恢复。
- 2026-11-18 验证记录：
  - 新增 `orchestrationInputPolicy.test.ts`（5 项）与 `orchestrationInterrupt.test.ts`（3 项），并在 `orchestrationPrompt.test.ts` 增加 dynamic run 段用例（+1）；编排全量测试 104/104 通过。
  - `pnpm --filter @zcode/core typecheck`（含 `tsconfig.orchestration-test.json`）通过；`pnpm architecture:check --changed` violations 0 / baseline 0 / new 0。
  - 定向 Lint 0 errors / 0 warnings；根 `pnpm lint` 仍为基线 0 errors / 70 warnings；`agent-runtime.ts` 的 max-lines 为既有超限（HEAD 675 行已超 400），本轮只增加 3 行。
  - 仍未接线：Host/protocol 的 `orchestrationInput` 下发、发送框三态菜单与 `OrchestrationRunTimeline` 属 Phase 5；跨进程 held 恢复与 completed 产物种子化复用不在本阶段。

### Phase 5 — UI（8–12 人日）

Phase 5 设计（实现前先固定所有权与接线）：

- **唯一事实源**：编排配置（`enabled / team / maxConcurrency`）由 CLI runtime 的 `config.orchestration` 持有，并持久化到 session entry `runtime/orchestration`；`OrchestrationService` 仍是 run/step 的唯一写入者。UI 草稿只保存“下一次提交意图”，不复制 run 状态。
- **配置命令**：新增 v4 `setOrchestration`（`{ enabled, team, maxConcurrency? }`）与 `cancelOrchestrationRun`（`{ runId }`）。`createSession.config.orchestration` 走与 `setOrchestration` 完全相同的 app 入口，不新增第二条应用路径。命令只更新 runtime 配置并重注册工具面；活动 run 不受影响，下一轮 turn 生效。
- **状态读取**：新增只读查询 `v4/conversation/orchestrationState`，返回 `{ config, runs }`，`runs` 含活动 run 与最近终态 run（上限 8），步骤投影含 `status / dependsOn / attempts / childSessionId / artifactUri`。Host capability `orchestrationState` 用于旧端 fail-closed 隐藏入口。不把 runs 放进 snapshot 投影，避免第二份可变状态与增量帧复杂度；UI 在会话打开和发送 ACK 后读取，活动 run 期间低频轮询。
- **执行中插入**：`sendText.orchestrationInput`（`guide` 默认 / `queue` / `interrupt`）由 UI 状态条写入；Core 的 `decideOrchestrationInput` 继续是唯一裁决者。无活动 run 时字段被忽略。
- **团队选择**：`general-purpose` 强制保留；软上限 6、硬上限 8；首次开启自动补默认团队并弹出选择器一次（按 workspace 记录已提示）。停用编排时团队保留在草稿，不删除用户选择。
- **角色模型**：选择器只展示“继承默认 / 具体模型名”，读取 `SubagentsService.list()` 的 `modelSelectionOverride`；编辑跳转设置页 `subagents`，不在此处写模型。
- **组件边界**：`OrchestrationTrigger` 与选择器/时间线拆成 `packages/ui/src/v4/composer/` 的纯展示件；选择/上限/预设/搜索逻辑放 `orchestrationTeamModel.ts` 纯函数，直接测试。运行时间线只读查询结果，停止走 `cancelOrchestrationRun`，重排只把输入语义切到 `interrupt` 并聚焦输入框，不伪造用户消息。

- [x] 5.1 `OrchestrationTrigger`：复合触发器，主按钮切开关，chevron 开团队选择器。
  - `packages/ui/src/v4/composer/OrchestrationTrigger.tsx`：ghost 主按钮 + chevron；`data-composer-collapse-priority="4"`，紧凑态折叠为图标；首次开启且团队为空时自动打开选择器。
- [x] 5.2 `OrchestrationTeamPicker`：桌面 448px popover；手机 bottom sheet；推荐组合；标签搜索；软/硬上限；不可用角色。
  - 内容组件 `OrchestrationTeamPicker.tsx` 由桌面 `PopoverContent`（`w-[min(448px,calc(100vw-2rem))]`）与手机底部 `DialogContent` 共用；纯逻辑在 `orchestrationTeamModel.ts`（预设、搜索、上限、general-purpose 锁定、不可用角色、模型标签）。
- [x] 5.3 草稿/会话接线：draft store、submission、snapshot、restore、queue、`setOrchestration`。
  - `V4ComposerDraft` 新增 `orchestrationEnabled / subagentPool / orchestrationInputMode / orchestrationTouched`；`createComposerSubmissionConfig` 携带 createSession 的 orchestration 配置与 `orchestrationInput`。
  - 协议新增 `setOrchestration` / `cancelOrchestrationRun` / `sendText.orchestrationInput` / `createSession.config.orchestration`；CLI runtime 更新 `config.orchestration`、按需创建 service、重注册工具并持久化 `runtime/orchestration` entry。
  - 状态恢复走只读查询 `v4/conversation/orchestrationState`（`useOrchestrationState`），会话打开时按运行时配置种子草稿；用户显式操作后（touched）不再覆盖。
- [x] 5.4 `OrchestrationRunTimeline`：步骤状态、依赖“等待 X”、并行组、失败/重试、查看子会话、停止、重排。
  - `OrchestrationRunBar.tsx` 内含时间线 Dialog；步骤状态、`dependsOn` 等待项、并行运行数、attempts、child session 入口、停止与重排均来自只读投影；停止发 `cancelOrchestrationRun`，重排只切 `interrupt` 语义并聚焦输入框，不代发消息。
- [x] 5.5 发送框运行中三态菜单与状态条；运行数仍由后台徽标显示，不重复。
  - 活动 run 时在输入框上方显示 `OrchestrationRunBar`；三态菜单写 `orchestrationInputMode`，提交时随 `sendText` 下发；运行数没有新增计数器。
- [x] 5.6 每角色模型显示“继承默认/模型名”，编辑跳设置页。
  - 选择器读取 `SubagentsService.list()` 的 `modelSelectionOverride`，显示“继承默认模型 / Model: {model}”；编辑按钮跳 Settings → `subagents`（分区级定位）。
- 验收：默认关闭无视觉变化；首次开启弹推荐团队；运行中能看到顺序与并行；手机可用；切会话隔离。
- 测试：纯模型测试（选择/预设/上限/空池）、draft 持久化、config picker 互斥、i18n 对齐；外部 E2E harness 场景（仓库内无 E2E 框架）。
- 2026-11-18 验证记录：
  - 新增 `packages/ui/test/orchestrationTeamModel.test.ts`（7 项）与 `orchestrationI18n.test.ts`（2 项），覆盖预设/搜索/上限/不可用角色/模型标签与中英文键对齐；新增 `apps/zcode-cli/packages/core/test/orchestrationServiceState.test.ts`（2 项），覆盖 service 配置热更新与 run/step 投影。
  - 编排全量 core 测试 106/106 通过；`pnpm typecheck` 通过本次改动文件（其余仍是既有的 3 个 `packages/server/src/remote/*` TS7006）；`pnpm exec tsc -p packages/services/tsconfig.test.json` 通过。
  - `pnpm lint`：0 errors / 70 warnings（与基线一致）；改动文件定向 oxlint 无新增 warning；`pnpm architecture:check --changed` violations 0 / baseline 0 / new 0；改动文件 `oxfmt --check` 通过。
  - 未做：真实模型 / Desktop / Mobile 的编排 E2E（仓库无 E2E 框架）；冷恢复 entry、tasks-index meta 投影、旧 bundle/远程降级仍属 Phase 6。

### Phase 6 — 恢复、兼容、回归（4–6 人日）

- [ ] 6.1 冷恢复：CLI session `runtime/orchestration` entry + run journal 恢复。
- [ ] 6.2 tasks-index meta 投影合并保留 `agentRole/subagentPool`。
- [ ] 6.3 旧 agent bundle：v4 未知字段丢弃→经典；legacy strict→omit-retry；`setOrchestration` 不支持时隐藏入口。
- [ ] 6.4 远程 workspace 断线/重连恢复。
- [ ] 6.5 经典模式逐项回归：prompt/工具表/snapshot/meta 不变。
- 验收：重启后续跑；旧端不崩；经典会话零差异。
- 测试：cold resume；meta round-trip；旧 payload；snapshot diff 回归。

## 6. 验收场景

1. 默认关闭：工具条只多一个 ghost 入口；权限菜单、Plan、CUA、后台任务、系统提示、snapshot、task meta 逐项不变。
2. 首次开启：自动弹出推荐团队（3 个），确认后下一轮生效。
3. 只注入选中 profile：未选角色不出现在 Agent 工具描述；点名未选角色被拒绝。
4. 主会话：模型看不到 Edit/Write/Bash；即使幻觉调用也被 executor 拒绝；子代理工具完整。
5. 团队选择按会话隔离；切 tab/切会话不串；冷恢复保持。
6. 中途切团队：显示“下一轮生效”；运行中子智能体继续完成；被移出团队的子代理仍可 `SendMessage` 恢复。
7. 角色被删除/停用：保留引用并标记不可用；全员不可用则编排自动关闭，不扩大为全部 profile。
8. 紧凑态/手机：入口折叠为图标、不溢出；团队 sheet 可搜索、可键盘操作、Esc 关闭并回焦。
9. Plan + 编排：子代理只读；UI 明确提示。
10. 旧 agent bundle/远程 workspace：不支持时隐藏编排入口；已存在会话降级为经典，不报错、不丢会话。
11. DAG 顺序：architect 未完成时 frontend 不启动；契约完成后 frontend/backend 并行；tester 等两者完成。
12. 用户插入：追加指导不打断当前步骤；停止并重排保留已完成产物；排队不打断当前 run。

## 7. 风险

1. **并行写冲突**：前后端并行必须用 `writeScope` 检测重叠；共享文件（package.json/lockfile）默认串行或交给集成步骤。
2. **主会话硬隔离**：只隐藏工具不够，必须补 executor 拒绝。
3. **计划质量**：DAG 由模型生成，必须严格校验；不合格计划直接拒绝并要求重规划，不能“带病执行”。
4. **上下文膨胀**：步骤输出只回传摘要/产物引用；主会话不接收完整子会话。
5. **恢复与 fencing**：run/step/attempt 必须有 generation 与幂等键；旧结果不能污染新计划。
6. **用户插入语义**：默认 guide，打断必须显式选择；不能让模型自行猜测“用户想取消”。
7. **旧 bundle/远程**：能力不支持时 fail-closed 隐藏编排入口，已存在会话降级经典。
8. **依赖迁移**：新增内置角色前必须先修 `subagent-state-migration.ts`，否则模型覆盖被删除。
9. **范围**：这是 44–68 人日的中大型功能，不是两周的小改动；建议按阶段合入，每阶段可独立回归。

## 8. 工作量

| 阶段                  | 人日                                        |
| --------------------- | ------------------------------------------- |
| P0 计划与设计         | 2–3                                         |
| P1 角色库 + 模型配置  | 6–10                                        |
| P2 DAG 调度引擎       | 12–18                                       |
| P3 主会话规划与工具面 | 6–9                                         |
| P4 插入消息与重排     | 6–10                                        |
| P5 UI                 | 8–12                                        |
| P6 恢复/兼容/回归     | 4–6                                         |
| 合计                  | 44–68 人日（单人约 9–14 周；两人约 5–8 周） |

若后续确认可复用 workflow run journal，P2 可降到 6–10 人日，总量约 38–60 人日。
