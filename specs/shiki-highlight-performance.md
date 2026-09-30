# Shiki 代码高亮的内存与实例管理优化（渲染结果不变）

## 背景

`packages/ui/src/lib/shikiHighlighter.ts` 是全 UI 唯一的 shiki 高亮入口，被内联 diff 预览
（`components/ui/highlighted-lightweight-diff-preview.tsx`）、`code-viewer.tsx`、`diff-viewer.tsx`、
`ai-elements/code-block.tsx`、预览面板与设置页共 8 处消费。

实测（本机，esbuild 打包真实源码后计时）暴露两个问题：

1. **`tokensCache` 无淘汰**（代码内注释自述「目前无淘汰，是审计里 renderer 最可疑的增长点」）。
   缓存 key 为 `theme:language:${code.length}:${code 前 100 字符}:${code 后 100 字符}`，
   流式期间代码块每次增量都会产生**新 key**，于是每次增量都写入一条完整 token 数组。
   实测一个 20k 字符代码块按 200 次增量更新：累计 tokenize **830ms**（一次性只需 12ms），
   缓存 **200 条 / 164,738 个 token 对象**，heap +21MB。
2. **高亮器按 `(theme, language)` 各建一个实例**。shiki 的 `createHighlighter` 每次调用都会新建
   一个 Oniguruma WASM 引擎（`engine: () => createOnigurumaEngine(import('shiki/wasm'))`），
   因此同一语法会随主题数重复加载，且代码从不调用 `dispose()`。shiki 自身会打印
   `[Shiki] 10 instances have been created. Shiki is supposed to be used as a singleton`。

## 硬约束：渲染结果不变

- **token 输出必须逐项一致**：同样的 `(code, language, theme)` 必须产出与改动前完全相同的
  `TokenizedCode`（`fg` / `bg` / `tokens` 的内容与顺序）。
- 不改公开 API：`highlightCode` / `shouldUseSyntaxHighlighting` / `TokenizedCode` 的签名与语义不变，
  8 个消费方文件零改动。
- 不改「何时回调」的语义：缓存命中时仍走微任务回调，未命中时仍走 `subscribers` 通知，仍返回
  `TokenizedCode | null`。
- 不改高亮更新的**频率**：本次不引入节流或合并。原因见「非目标」。

## 改动明细与不变量

### 1. `tokensCache` 加上限与 LRU 淘汰

- **不变量**：对任意输入，缓存命中/未命中的判定只影响「是否重新计算」，不影响计算结果；
  淘汰只丢弃可重新计算的条目。
- **实现**：上限 `TOKENS_CACHE_MAX_ENTRIES = 128`，用 `Map` 的插入序实现 LRU
  （命中时 `delete` 再 `set` 提升到队尾，超限时淘汰队首）。
- **理由**：命中路径已经只做一次 `Map.get`，提升顺序的额外 `delete+set` 是 O(1)；
  相比无界增长导致的 renderer 堆持续上涨（长会话 + 历史恢复场景），这是纯收益。
- 选择 128 而非更小：单条目持有完整 token 数组，128 条足以覆盖「当前可见的代码块 + 内联 diff」
  这一工作集，且把最坏情况的内存占用从「随会话无界」变成「有界」。

### 2. 单个共享 highlighter，语言与主题按需加载

- **不变量**：同样的 `(code, language, theme)` 产出同样的 token。依据是 shiki 的
  `codeToTokens` 结果只取决于「语法 + 主题 + 文本」，与语言/主题是随构造传入还是事后
  `loadLanguage` / `loadTheme` 载入无关。该等价性由差分测试逐项断言。
- **实现**：模块内维护**一个** `HighlighterGeneric` 实例（懒创建），把 `(language, theme)`
  通过 `loadLanguage` / `loadTheme` 载入同一实例；并发加载同一语言/主题时复用同一个进行中的
  promise，避免重复载入。
- **副作用边界**：共享实例会让「已加载语言集合」随使用过的语言单调增长（每个语言一份语法）。
  这比原来「每个 `(theme, language)` 组合一份语法 + 一个 WASM 引擎」小得多
  （实测 16 个实例 heap 10.5MB / rss 75.6MB，单实例 8 语言 × 2 主题 heap 9.5MB / rss 71.6MB），
  且是 shiki 文档推荐的用法。本次不为语言集合再设上限。
- **失败可恢复**：共享实例的创建 promise 在 reject 时会被清空，下一次请求重新创建。
  改动前每个 `(theme, language)` 各自缓存 reject 的 promise，一次瞬时失败会永久关掉那个组合的
  高亮；现在实例是全局共享的，一旦失败影响面覆盖全部高亮，因此必须允许重试。
- **保留原有兜底分支**：`getLoadedLanguages()` 不包含目标语言时仍退回 `FALLBACK_CODE_LANGUAGE`，
  代码形态与改动前一致。

### 3. 缓存 key 保持改动前形态（不做行为变更）

- **结论**：**不改**。key 仍为 `theme:language:${长度}:${前 100 字符}:${后 100 字符}`。
- **原因**：改成精确 key 会让「长度相同、首尾 100 字符相同、只有中段不同」的两段代码从
  「共用一份高亮结果」变成「各自高亮」。这是**可观察的行为变化**，与「不影响原功能」的要求冲突，
  故保留原形态。差分测试中该分支的断言是「新旧行为一致（含这处碰撞）」，而不是「碰撞被修掉」。
- **已知代价**：上述两段代码会命中彼此的高亮（A 的 token 显示到 B 上）。
  触发条件是长度 + 首尾各 100 字符完全相同，属于窄口径潜在问题；如后续决定修，
  改动只有 key 构造一行，且必须同步更新该断言。

## 非目标（明确不做）

| 不做的事 | 原因 |
| --- | --- |
| 对高亮做节流 / rAF 合并 / 只高亮稳定前缀 | 这是唯一能降低「流式期间反复全量 tokenize」CPU 的手段，但它会改变**可见的中间帧**（高亮出现得更晚或更少）。「不影响原功能」优先，故留给用户显式决定。 |
| 把 chat 代码块高亮迁到 worker | 需要新的 worker 构建入口与消息协议，属于结构性改动；且助手正文流式期间本来就用 `enableSyntaxHighlighting={!renderStreaming}` 关掉了高亮。 |
| 改 `@pierre/diffs` 的 worker 高亮链路 | 那条链路已经是 worker + `shiki-wasm`，与本文档的模块不同。 |

## 验收

- 差分测试（esbuild 打包改动前/后，`node:test` 运行）：
  - 对 `(code, language, theme)` 矩阵（含多语言、明暗双主题、纯文本、超长文本、以及会触发
    旧 key 碰撞的一对代码）逐项断言 `TokenizedCode` 深度相等。
  - 缓存上限：连续请求远多于 128 个不同代码后，`tokensCache.size` 不超过上限
    （通过内存诊断注册表读取，保证可观测口径与生产一致）。
  - 碰撞回归：旧 key 相同、中段不同的两份代码必须产出不同的 token。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 全绿。
