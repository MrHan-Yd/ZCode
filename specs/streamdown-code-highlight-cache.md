# 聊天代码块高亮的第三方缓存加上界（pnpm 补丁）

## 背景

聊天正文里的代码块由 `@streamdown/code` 渲染，**不是**本仓库的
`packages/ui/src/lib/shikiHighlighter.ts`。该包自带一份内联的 shiki 与一个模块级 token 缓存，
它对本项目的内存诊断完全不可见（renderer 采样里 `shiki.tokensCache=0` 正是被它盖住的）。

它的缓存 key 结构是 `${主题}-${主题}-${语言}-${代码长度}-前100字符-后100字符`，
且 `set` 之后**没有任何淘汰**。因为 key 含代码长度，流式期间每次增量都是新 key，
所以**条目数 ≈ 高亮调用次数**，与代码块数量无关地线性增长。

实测（模拟 40 条消息 × 每条 2 个代码块 × 每块 60 次流式增量，共 4800 次调用）：

| | 缓存条目 | heap 增长 |
| --- | --- | --- |
| 补丁前 | 4795 | **+282.8MB** |
| 补丁后（2,000,000 字符上界） | 2535 | **+~120MB** |

## 产品规则与不变量

1. **只加淘汰，不改高亮输出**。不改缓存 key、不改 shiki 引擎（仍是该包自带的
   `createJavaScriptRegexEngine`）、不改任何渲染逻辑。补丁后 4835 次调用的 token 与样式
   与补丁前**逐次一致**（差分测试见验收）。
2. **按「代码字符总量」设上界，而不是按条数**。条数上限无法约束内存 —— 一个大型代码块与一个
   小片段各占一条，若条目都是大块，内存可以远超按条数推测的值。字符预算把内存直接绑住
   （实测每 1 字符源码约 60 字节 heap）。
3. **上界 2,000,000 字符**（约 2MB 源码文本）。选这个值是因为实测它在同一负载下把缓存从
   4795 条压到约 2500 条，而「回滚查看最近 40 个代码块」的命中率仍有 35/40、耗时 8ms，
   体感上不引入可感知的重算。
4. **不改变高亮更新频率**。流式期间仍是每次增量全量重算 —— 降低频率会改变可见的中间帧，
   属于行为变化，不在本次范围（因此本次不改善流式卡顿，只改善常驻内存）。

## 状态所有者

- **缓存的唯一所有者仍是 `@streamdown/code`**（第三方包内部），本仓库不持有第二份。
- 本仓库只通过 pnpm 补丁给该缓存加**淘汰上界**，并注入一个**只读探针**用于观测；
  补丁不引入项目侧缓存，也不改变谁写入。
- 补丁文件：`patches/@streamdown__code@1.1.1.patch`；注册在根 `package.json` 的
  `pnpm.patchedDependencies`（与仓库既有的 3 个补丁同一机制）。

## 接口

```ts
// 由补丁写入，只读。补丁未应用时该属性不存在。
globalThis.__zcodeStreamdownCodeCacheStats?: () => { entries: number; chars: number };
```

```ts
// packages/ui/src/lib/streamdownCodeCacheDiagnostics.ts
// 注册到 uiMemoryDiagnosticsRegistry，采样键为 streamdownCodeCache.entries / .chars。
// 探针缺失时返回空对象：缺少补丁不能让诊断或构建失败（不做静态 import 该私有符号）。
```

## 时序

```text
流式渲染（每次代码内容变化）
  → streamdown 调 codeHighlighter.highlight({code, language, themes})
      命中 → 同步返回缓存结果
      未命中 → 异步 tokenize 全量代码 → 写入缓存
                 → 若总字符数 > 2,000,000：从最旧条目开始淘汰，直到回到预算内
  → 渲染 token

每 60 秒：renderer 内存采样 → 读探针 → 记录 streamdownCodeCache.entries / .chars
```

## 验收

- **差分测试**（esbuild 打包补丁前/后真实产物，`node:test`）：
  - 同一个 4835 次调用序列（含流式前缀、回滚、重复内容）在两个实现上**逐次比对结果一致**。
    比对时排除 `grammarState` —— 那是 shiki 引擎内部的增量解析句柄，两份 bundle 各自内联
    一份 shiki、类实例原型不同，沿用深度比较会误报；排除项不影响渲染消费的 token 与样式。
  - 补丁后缓存字符量 ≤ 2,000,000，且探针可读。
  - 补丁前作为对照：条目 > 2000（无界）。
- 补丁可用 `git apply --check` 干净应用到 pristine 包副本。

## 已知限制

- **补丁需要一次 `pnpm install` 才会生效**（pnpm 在安装阶段应用 `patchedDependencies`）。
  未安装前 renderer 行为与今天完全一致，探针也不存在（诊断 provider 返回空）。
- 升级 `@streamdown/code` 时需要重新生成补丁，否则 `patch-commit` 会因上下文不匹配而失败。
- 2,000,000 字符是启发值：它随「希望保留多少代码块 × 每块流式多少次」缩放，没有普适常数。
  之所以按字符而不按条数设界，正是为了不依赖这个比例；后续可按 `streamdownCodeCache.chars`
  的真实分布调整。
- 补丁不触及引擎选择：该包使用 `createJavaScriptRegexEngine`，正是本项目在 diff 路径上
  因 V8 code-space OOM 而放弃的引擎（见 `lib/diffsHighlighterEngine.ts` 的说明）。
  那是独立风险，修它需要替换该插件（会改变行为），不在本次范围。
- 代价：缓存条目被淘汰后，若同一段代码再次渲染（回滚、重挂载），会重新高亮一次
  （异步、内容不变）。这是「有界」的必然代价。
