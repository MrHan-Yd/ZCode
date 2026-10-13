# 流式 markdown 渲染节流

## 背景

`packages/ui/src/components/ai-elements/message.tsx` 的 `MessageResponse` 在流式期间每个
chunk（P0-1 后 flush 间隔 32ms，约 30fps）都会：

1. `extractCodeText(children)` 提取文本；
2. `projectZCodeFileCitations` + 3 个 normalize 正则全量过一遍文本；
3. Streamdown 内部对全文跑 remark Lexer 分块（`parseMarkdownIntoBlocks`，**无
   memoization**，已核实 dist 产物）+ remend 未闭合补全 + rehype/remark 全量解析。

长消息（几十 KB）下第 3 步每帧全量解析是流式卡顿的主要渲染端开销；第 2 步的正则
全量扫描次之。P0-2 切片订阅已把重渲染范围收敛到本消息，本 spec 把**解析频率**降下来。

## 行为

- 新增 `packages/ui/src/lib/streamingMarkdownThrottle.ts`：
  - `createStreamingTextThrottle(minIntervalMs)` 返回框架无关的决策器：
    - `push(text, nowMs)`：流式期间的输入。距上次发射 ≥ 间隔 → 立即发射（leading edge）；
      否则不发射，但保证"最后一帧不丢"——调用方在静默期满后必须再推一次（trailing
      edge 由定时器承担，见 hook 适配）。
    - `settle(text)`：流式结束，立即对齐到最新文本并复位状态。
  - 决策器不持有定时器，纯同步、可差分测试。
- 新增 `packages/ui/src/hooks/useStreamingTextThrottle.ts`：薄 React 适配。
  - 输入 `(text, active, minIntervalMs)`；`active=false` 时直接返回 `text`（旁路，
    完成态不受节流影响）。
  - `active=true` 时：文本变化 → 决策器判断；未发射则安排 `setTimeout` 到静默期满
    用**当时最新**文本补一次发射（效果重跑，保证尾帧）。组件卸载清定时器。
  - 首次挂载（虚拟滚动重挂载）初始值即当前文本，不出现空白闪帧。
- `MessageResponse` 集成：`rawMarkdown` 经节流后才进入 citation 投影与 normalize 管线；
  节流间隔 `STREAMING_MARKDOWN_THROTTLE_MS = 80`（约 12.5fps，纯文本阅读感知不到，
  相对 30fps 降低约 60% 的全量解析次数）。Streamdown 的 memo 比较 children 引用，
  节流值在两次发射间引用稳定，即使 MessageResponse 因外部 props 每帧重渲染，
  Streamdown 也会跳过重解析。

## 语义边界

- 只节流**渲染管线输入**，不丢内容：流式结束后 `settle` 保证最终态与原文逐字节一致。
- 完成态（`streaming=false`）永不节流——历史消息重挂载仍一次性完整渲染。
- 不改变 `boundaryResetKey` / `streamdownRenderKey` 的键语义（仍不含文本）。

## 验收

- 决策器差分测试：任意 (文本序列, 时间序列) 下「节流后最后 settle 的文本 ≡ 原文」；
  发射间隔恒 ≥ minIntervalMs；active 旁路逐字节一致。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
