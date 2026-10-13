# 工具长输出默认预算：artifact + head-tail 截断

## 背景

`result-serialization.ts` 的 `DEFAULT_RESULT_BUDGET` 是**入口未声明 `resultBudget` 时的兜底**。
`ToolContractDeclaration.resultBudget` 在 contract 里是**必填**字段，当前仓库所有工具（含 MCP）
都显式声明了预算，因此这份默认在当前是兜底、而非活跃路径。

本改动做两件事：

1. 新增 head-tail 预览方向能力；
2. 把默认兜底从 `strategy: "truncate"`、`preview.direction: "head"` 改为
   `strategy: "artifact"`（落盘 + `<persisted-output>` 预览）、`preview.direction: "head-tail"`。

对已显式声明预算的工具（bash、grep、websearch、MCP 等）**逐字节无影响**。

## 行为

### head-tail 预览方向（新增能力）

- `ToolResultBudget.preview.direction` 扩展为 `"head" | "tail" | "head-tail"`。
- `fitContentWithSuffix` 支持 head-tail：`head(~70%) + 中段省略标记 + tail(~30%) +
  截断后缀`，总字节严格 ≤ maxBytes。省略标记
  `\n\n[... N bytes in the middle omitted ...]\n\n` 的 N 为被丢弃中段的精确字节数。
- head 是原文前缀、tail 是原文后缀（code-unit 边界由现有 `fitStringToBytes` 的二分保证），
  head/tail 拼接不重叠（预算之和 < 内容字节时必然不重叠）。
- **内容装得下剩余预算时，head-tail 与 head/tail 同契约：返回 `内容 + 截断后缀`**，后缀不得
  被静默丢弃。
- `projectOfficialCuaStructuredContent` 的文本段切分显式支持 head-tail（用
  `fitStringToBytesHeadTail`，**不**带通用省略标记——CUA 自带
  `OFFICIAL_CUA_TEXT_TRUNCATION_MARKER`，避免出现两个标记）；`appendHookToStringContent`、
  `projectHookAugmentedModelContent` 的 direction 参数随 union 放宽，透传给
  `fitContentWithSuffix`；head/tail 行为逐字节不变。
- 预览方向的解析收敛到唯一入口 `resolvePreviewDirection(budget)`（`serializeOutput`、
  `appendHookAdditionalContexts`、CUA 分支共用），消除同一 entry 上 `?? "head"` 与默认预算
  `head-tail` 的分歧。

### 默认预算切换（兜底）

```
strategy: "truncate" → "artifact"
artifact: { enabled: true, retention: "session" }
preview.direction: "head" → "head-tail"
```

- artifactStore 可用时：超限输出落盘（沿用 `tryWriteToolArtifact` 与 `<persisted-output>`
  2KB 预览 envelope）；
- artifactStore 缺失/写入失败：回退既有 truncate 路径，方向为 head-tail（比 head 多保留尾部
  错误摘要）。

## 语义边界

- 显式声明 `resultBudget` 的工具（bash、grep、websearch、MCP 等）逐字节保持原行为——这是当前
  唯一被真实触发的路径。
- 字符预算（`maxModelChars`）与 CUA frame 保护路径的触发条件不动。
- 截断后缀文案与 `returnedBytes` 口径不动。

## 验收

- `fitContentWithSuffix` head-tail 差分测试：任意 (内容, 预算, 后缀) 下总字节
  ≤ maxBytes；head/tail 与原文的 前缀/后缀 关系成立；省略字节数与实际丢弃一致；
  内容装得下时后缀保留；head/tail 行为与改造前逐字节一致。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
