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
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 结果见提交说明。
