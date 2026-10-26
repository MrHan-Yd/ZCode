# CLI 热路径纯性能优化（输出不变）

## 背景

一次性能审计提出 4 项 CLI 侧「每次调用都做、结果被丢弃或重复计算」的开销。全部实现在本机做了
**差分实测**（esbuild 打包改动前/改动后两份真实源码，用 `node:test` 逐项比对输出，并分别计时）。

结论是 4 项里只有 2 项成立：审计对另外 2 项的前提经实测不成立，已回退。

| 项 | 审计认为 | 实测结果 | 处置 |
| --- | --- | --- | --- |
| 文件遍历逐文件 `stat` | P0，13 万次系统调用 | 本仓库 `**/*.ts`：**3296ms → 757ms（4.4x）**，结果完全一致 | **采纳** |
| Bash 命令重复解析 5~7 次 | P1，每次 0.1~1ms | 9k heredoc 一次调用省 **138µs**，简单命令省 15µs | **采纳** |
| `estimateTokens` 的 `match` 分配 | P1，产生数万对象 | 真实语料（2.13MB、CJK 占 4%）**慢 4.6x** | **回退** |
| microcompact 无效路径深拷贝 | P0，每 step 全历史克隆 | 600 条 / 7200 content block 仅省 **0.12ms/step** | **回退** |

## 硬约束：输出不变

- 函数返回值、数值、数组元素顺序、集合内容与改动前逐项相等。
- 不新增/删除/重命名协议字段、事件、日志事件名或其字段名。
- 不改变文件遍历结果的集合与顺序。

差分测试（`/tmp/verify/*.test.mjs`，13 个用例全绿）覆盖：
`estimateTokens` 语料逐项相等、`analyzeBashCommand` 缓存结果与新鲜解析深度相等且不可污染、
`maybeLocalMicrocompactMessages` 六个分支的 `decision`/`payload`/消息内容相等且不改写入参、
Glob 10 组 pattern 与 JS 回退 Grep 8 组请求的完整结果（剥离 `durationMs`）逐字段相等。

## 采纳的改动

### 1. 文件遍历惰性 `stat`（`packages/adapters/src/fs/index.ts`）

`walkFiles` 的 visitor 签名由 `(path, info)` 改为 `(path)`，`stat` 下放到调用方在**命中筛选条件之后**。

- **不变量**：Glob 的 `files` / `numFiles` / `truncated`，以及 JS 回退 Grep 的候选集合、顺序、`mtimeMs` 不变。
- **等价依据**：
  - Glob：`info.mtimeMs` 只用于已命中的文件。
  - JS 回退 Grep：`addIfCandidate` 的 glob/type 筛选只用路径与扩展名，`mtimeMs` 只用于最终候选；
    候选随后按路径排序，与 `stat` 的相对时序无关。原 `info.isFile()` 判断保留（`walkFiles` 已用
    `entry.isFile()` 跳过非文件与符号链接，该判断恒真）。
  - 文件根节点沿用已有 `rootInfo`，不额外 `stat`。
- **唯一错误路径差异**：未命中文件若 `stat` 失败，旧实现会让整次搜索失败，新实现不再触发该 `stat`，
  搜索可以成功。「少失败」，不改变任何成功路径的结果。
- **实测**（本仓库根目录，两版各自独立运行）：

  | pattern | 改动前 | 改动后 | 结果 |
  | --- | --- | --- | --- |
  | `**/*.ts` | 3296 ms | 757 ms | 均 `numFiles=100, truncated=true` |
  | `**/*.json` | 1616 ms | 504 ms | 均 `numFiles=100, truncated=true` |

### 2. Bash 解析有界记忆化（`packages/core/src/tool/handlers/bash-command-parser.ts`）

同一条命令在一次 Bash 工具调用里被权限策略、`bash-read-file-sources`、`bash-semantics` 的 4 个判定
与 `tool-perf` 各解析一遍（5~7 次），输入完全相同。

- **不变量**：同一 `command` 的返回值与不缓存时深度相等。
- **等价依据**：`analyzeBashCommand` 是 `command` 的纯函数（只依赖入参、模块级常量与 `unbash.parse`），
  无 IO / 时间 / 随机量 / 可变模块状态；9 个调用点全部只读。
- **实现**：模块内上限 256 条的缓存，超出整表清空。返回值在多个调用点间共享，因此：
  - `BashCommandAnalysis.commands` 与 `unsupportedNodeTypes` 类型收紧为 `readonly`，并在构造处 `Object.freeze`；
  - 冻结后命中缓存的调用方无法就地污染（已由测试断言 `push` 抛错后结果仍正确）。
- **实测**（一次工具调用内的 7 次解析）：简单命令 14.8µs → 0.1µs；9k heredoc 110µs → 0µs。

### 3. 冷恢复三段查询并发（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol/v4-bridge.ts`）

冷订阅首帧必须等 `loadPersistedEvents` 整个返回，而它内部依次 `await` 了三段互不依赖的只读查询：

1. `buildColdFileChangeSummaries`——按 workspace checkpoint 读 artifact 并做逐文件差分；
2. `readSessionContextUsage`——对全部 messages 做一次 token 估算（O(transcript)）；
3. `listSessionSubagents`——查 session store 的子会话 manifest。

后两段与第一段没有依赖，串行执行会把它们**完整堆在**最贵的差分工作之后，等于是首帧延迟的净增量。
改为 `Promise.all` 并发，只让它们与最慢的一段重叠。

- **硬约束：输出不变。** 三段都是只读查询，入参分别是 `source.memoryEvents` / `source.messages` /
  `persistedMessages` 这些已定型的快照；并发不改变任何返回值，`usageSeed`、`subagentsSeed`、
  `merged.events` 与改动前逐字段相等。
- **不变量：种子仍早于 buffer 重放。** `listSessionSubagents` 的种子必须在 gateway 重放
  raw-event buffer **之前**生成（否则异步查询会覆盖 seed 之后新到达的 live spawn/stop）。
  `Promise.all` 仍在 `loadPersistedEvents` 返回前完成，重放发生在 `hydratePublisher` 里更晚的
  位置，该顺序不变。
- **未改动**：未把用量/子会话种子改成「首帧后补种」。publisher 的 `seedUsage` / `seedSubagents`
  按设计**不产 delta**（`conversation-topic-publisher.ts`），首帧后才补种会让订阅方收不到这两个
  种子；而 `seedSubagents` 是整体替换 manifest，迟到到 live 之后反而会丢掉刚 spawn 的子会话。
  并发方案在不改协议语义的前提下拿到了同样的「不额外串行」效果。

### 4. artifact 目录索引（`apps/zcode-cli/packages/adapters/src/storage/index.ts`）

`NodeToolArtifactStore` 的 `readArtifactFile` / `statToolResultArtifact` 每定位一个 artifact 都会对会话目录做一次
`readdir`，再线性 `find` 文件名。冷恢复的 `buildColdFileChangeSummaries` 要读 907 个 checkpoint 的 artifact，
等于对一个 929 条目的目录做了 907 次枚举。实测（本机热缓存）：907 次 `readdirSync` 单独耗时 **1021 ms**；
同一批 907 次读取改成「一次建索引 + 直接读文件」后，含 17.4 MB 内容只要 **172 ms**。这两项是 IO 微基准，
整段还包含固定的解析/diff 成本，端到端收益见下方实测。

- **实现**：每个会话目录首次访问时枚举一次，缓存文件名数组与 `artifactId → fileName` 映射；同一进程内
  写入 artifact 时同步追加到缓存。缓存是进程内易失状态，不落盘、不参与任何持久化协议。
- **跨进程新增**：索引 miss 时重新枚举一次（另一个 CLI 进程可能刚写入该目录）。
- **跨进程删除/替换**：`readFile` / `stat` 报 `ENOENT` 时清掉该会话索引、重新枚举并重试一次；仍找不到
  才抛原来的 `Tool artifact not found`。
- **有界**：最多缓存 64 个会话目录（LRU），超出淘汰最久未用的目录。淘汰只影响性能，下一次读取自动重建。
- **不变量**：解析出的文件名、路径、contentType 与内容逐字节不变；URI 语义与错误消息不变；不同进程之间
  的可见性由 miss/ENOENT 刷新保证，不引入新的缓存一致性强约束。
- **实测**（本机热缓存，2496 消息 / 907 checkpoint 会话）：
  - 907 次 `readdirSync` 单独计时 1021 ms；同一批 907 次「索引查找 + 读文件」172 ms。
  - 冷恢复整段 `buildColdFileChangeSummaries`：改动前 943 ms → 改动后 **651–842 ms**（两次运行）。
    拆开看，索引化后预热 907 个 artifact 的 IO 为 360 ms，剩余 **475 ms 是 checkpoint 解析与逐文件
    diff**（`diff@9`），这部分不在本次改动范围内。
  - 结论：目录索引消除的是「读取数 × 目录大小」的放大项，热缓存下端到端收益约 15–30%；冷盘上
    907 次目录枚举的真实成本取决于目录元数据的冷 IO，未在本机量化。

### 5. 冷恢复只为尾窗轮重建 file-change 摘要（`v4-bridge.ts` + `cold-file-change-summaries.ts`）

首帧只发 `snapshotTailWindowRows`（60）行，但冷恢复过去为**全部** `source.messages` 重建摘要：
907 个 checkpoint → 907 个 artifact 读取 + 逐文件 diff，实测 943 ms，而该会话最后 200 条消息里
**0 个 checkpoint**。

- **实现**：`selectColdFileChangeMessageIds` 取最后 200 条消息的 messageId 作为候选；
  `buildColdFileChangeSummaries` 只处理命中候选的 checkpoint。
- **缺口不丢**：`workspaceCheckpointMessageIds` 列出所有会产摘要的 checkpoint 目标轮，未进入
  候选集合的全部写入 `fileChangeSummaryUnavailableMessageIds`，由既有
  `seedFileChangeSummaryUnavailable` → 客户端 `conversation/fileChanges` 按需回填。
- **不变量**：`files === 0` 与「摘要未计算」仍然严格区分；首帧内出现的轮若落在候选窗口内仍会
  预计算；漏算的尾窗轮由 UI 滚到时回填，不显示错误的 0。
- **窗口依据**：200 条消息在本仓库长会话样本里约 380 行（≈1.9 行/消息），远超 60 行；更保守的
  做法（按投影行反推尾窗轮）需要先完成投影，与 merge 的输入顺序冲突，暂不采用。
- **实测**（本机，2496 消息 / 907 checkpoint 会话）：候选 200 条消息命中 **0** 个 checkpoint 轮；
  47 个 checkpoint 目标轮全部进入缺口清单；`buildColdFileChangeSummaries` **943 ms → 3 ms**，
  artifact 读取 **0 次**。
- **代价**：首帧之后滚到更早的带文件变更轮时，各触发一次既有 `conversation/fileChanges` 按需请求；
  这些轮本来就不在首帧里。

### 6. 子 agent manifest 只读最后一条 assistant（`server-operations.ts` + session store）

`listSessionSubagents` 过去为每个子会话读取全量 `messages()`：本机样本 37 个子会话、48.7 MB
parts、470 ms。`projectSessionSubagents` 的 `lastChildOutcome` 只使用最后一条 assistant 消息。

- **实现**：`SessionStorePort.lastAssistantMessage?` 可选能力；SQLite 实现按
  `(session_id, sequence)` 倒序取一条并复用 `messageWithParts` 读 parts。
- **回退**：旧宿主没有该方法时仍走 `messages()`，不能把「缺能力」当成「没有消息」。
- **不变量**：`lastChildOutcome` 的输入语义不变——它本来就只取最后一条 assistant；按同一排序口径
  （非空 sequence 优先，缺失时 time_created）选中的消息与全量读取后的 `.at(-1)` 相同。
- **实测**：子会话读取 470 ms → 122 ms，冷 IO 从 48.7 MB 降到约 0.8 MB；整段
  `listSessionSubagents`（37 个子会话）**401 ms → 114 ms**。

### 7. CLI 子进程启用 Node 编译缓存

16.8 MB 单文件 bundle 每次 spawn 都要重新编译；CPU profile 中 `wrapSafe`/模块求值占启动的约 450 ms。

- **实现**：spawn env 增加 `NODE_COMPILE_CACHE={dataBaseDir}/.zcode/cli/node-compile-cache`。
  目录由 Node 创建并按源码哈希淘汰；`spawnEnv` / 部署 command env 仍可覆盖。
- **不变量**：只影响启动耗时，不改变 CLI 行为；旧 Node（<22.1）忽略该变量。
- **实测**：`node zcode.cjs --version` 1.45 s → 1.10 s（三次稳态）；首次运行仍需填充缓存。

### 8. 冷开分段计时（可观测性）

现有 `durationMs` 只有总数，无法判断 8 秒花在读盘、app 创建还是 runtime resume。

- **`zcode_protocol.session.resume_completed`**（info）新增：`waitMs`、`sessionLookupMs`、
  `messagesReadMs`、`materializeMs`、`runtimeResumeMs`、`partCount`。
- **`zcode_protocol.v4.cold_hydration_timing`**（info，每次冷物化一条）新增：`messageCount`、
  `materializeMs`、`fileChangesMs`、`contextUsageMs`、`subagentsMs`、`mergeMs`、`totalMs`、
  `fileChangeCandidateCount`、`fileChangeSummaryCount`。
- **gateway debug**：`rehydrateMs` 与投影行数（生产不落盘，dev 用）。
- **不变量**：不修改 `.strict()` 的 `openTiming` 协议字段；日志只读观测，不参与任何状态判断。

## 回退的改动（实测前提不成立）

### `estimateTokens` 改为码元计数 —— 真实负载下更慢，已回退

审计的前提是 `text.match(/[一-鿿]/g)` 会为每个命中字符分配字符串。前提本身成立，但没有考虑两点：
V8 的正则对**纯 ASCII 文本快速拒绝且零分配**；而手写 `charCodeAt` 循环对每个字符都有固定 JS 成本。

按 CJK 占比实测（200k 字符，300 次均值）：

| CJK 占比 | `match` | 码元循环 | 谁快 |
| --- | --- | --- | --- |
| 0% | ~0 ms | 0.26 ms | `match` 快几个数量级 |
| 5% | 0.124 ms | 0.249 ms | `match` 快 2x |
| 20% | 0.194 ms | 0.249 ms | `match` 快 1.3x |
| 50% | 0.503 ms | 0.260 ms | 循环快 1.9x |
| 100% | 1.385 ms | 0.264 ms | 循环快 5.2x |

交叉点在 ~30% CJK 字符密度。而真实会话历史里**代码与 JSON 工具输出按字节占绝大多数**，
实测 2.13MB 历史（CJK 字符占 4%）每 step：`match` 0.50ms、码元循环 2.30ms，**循环慢 4.6x**。
因此回退，保留原正则实现。

> 附带结论：该项在绝对量级上本来也不是热点（0.5ms/step，对照一次模型往返数秒）。

### microcompact 无效路径不深拷贝 —— 收益可忽略，已回退

审计的前提是「每个 model step 都对整段历史做深拷贝」。但 `cloneContent` 对字符串 content
**直接返回原字符串**，而字符串是不可变的、拷贝只复制指针，所以深拷贝的成本是 O(消息条数) 的浅层
对象展开，而不是 O(字节数)。实测：

| 场景 | 改动前 | 改动后 | 每 step 省 |
| --- | --- | --- | --- |
| 900 条 / 2.5MB 字符串 content | 0.08 ms | 0.03 ms | 0.06 ms |
| 600 条 / 7200 个 content block | 0.49 ms | 0.37 ms | 0.12 ms |

收益 ~0.1ms/step，却要让「提前返回分支的返回数组与入参共享元素引用」成为新契约。
不值得，回退。

## 被否决的改动（会改变返回值）

| 建议 | 否决原因 |
| --- | --- |
| 把 `shouldAutoCompact` 的 `config.enabled === false` 判断提到 `estimateMessageTokens` 之前 | `estimatedTokenCount` 属于返回对象 `common` 的字段，**在包括 `"disabled"` 在内的每个分支都会返回**。提前判断会让该字段无值，改变返回值。 |
| 在 `maybeLocalMicrocompactRuntimeEntries` 中跳过 `buildProviderRequestMessages` | 投影结果 `messages` 是 `decision.estimatedTokenCount` 的唯一来源；跳过会改变该字段。 |
| 给 Glob 增加 `.gitignore` / `node_modules` 剪枝 | 会改变返回的文件集合，属于功能变更。当前实现刻意包含 `node_modules`（已由测试断言锁定）。 |

## 验收

- 差分测试 13 个用例全绿（见上）。
- 冷恢复三段查询并发的结果等价性由「三段均为只读 + 入参已定型」论证；该路径没有单元测试安全网
  （`apps/zcode-cli` 仅 4 个测试文件，且不覆盖冷订阅），因此**未做实测计时**——量级估计见
  `specs/session-open-loading-state.md` 的说明。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 结果见提交说明。
