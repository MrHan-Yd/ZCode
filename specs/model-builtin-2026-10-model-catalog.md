# 内置模型规则补齐 2026-10 主流新模型（Grok 4.7 / Claude 5.5 / GPT-6）

## 背景

「模型智能配置」的推荐值来自内置 `config/provider/zcode-builtin.json` 的 `modelConfigRules`。
本次上游在 2026-09 ~ 2026-10 发布了多款新模型，内置规则仍停留在上一代：

- `grok-4.7`（xAI，2026-09-21）在 xAI / OpenCode / OpenCode Go / OpenRouter 均已上线，
  内置只有 `grok-4.6`，`grok-4.7` 会落到兜底 `.*` 的 200k / 32k。
- `claude-opus-5-5` / `claude-sonnet-5-5`（Anthropic，2026-09-22 / 2026-09-28）已被
  `.*claude-(?:fable|opus|sonnet)-5(?:[.\-:/\[].*)?` 覆盖，但模板里没有可选条目；
  `claude-haiku-5-5`（2026-10-07）不在任何家族规则内，会吃兜底。
- `gpt-6-sol` / `gpt-6-luna` / `gpt-6.1-sol`（OpenAI，2026-09-22 / 2026-09-29）与已有的
  `gpt-6-astra` 同代，但内置只有 `gpt-6-astra` 一条规则，其余变体吃兜底。

参数以 `models.dev` 上游目录（2026-10-20 读取）的 `openai` / `anthropic` / `xai` /
`opencode` / `opencode-go` / `openrouter` 条目为准。

## 产品规则

1. `modelRules` 新增 GPT-6 家族规则
   `.*gpt-6(?:\.1)?(?:-(?:sol|luna|terra))?(?:[.\-:/\[].*)?`，给出：
   - `properties.contextWindow = 1050000`
   - `optionSpecs.maxOutputTokens.max = 128000`
   - `inputFormat.supportsImage = true` / `supportsPdf = true`；
     `supportsVideo` / `supportsAudio = false`
   - `reasoningLevel.values = ["none", "low", "medium", "high", "xhigh", "max"]`
     （Sol / Luna 支持 `none`；Astra 的专属规则排在其后，仍收敛为不含 `none` 的档位）
2. `modelRules` 新增 Grok 4.7 规则 `.*grok-4\.7(?:[.\-:/\[].*)?`，沿用 Grok 4.6 的内置口径：
   `contextWindow = 500000`、`maxOutputTokens.max = 128000`、`reasoningLevel.values` 为
   `low/medium/high/xhigh`、支持 image 与 JSON Schema 输出、不支持 PDF。
   上游 `limit.output = 500000` 由 OpenCode Go 站点规则放开（与 Grok 4.6 同形）。
3. `modelRules` 新增 Claude Haiku 5.5 规则 `.*claude-haiku-5[.-]5(?:[.\-:/\[].*)?`，给出
   `contextWindow = 1000000`、`maxOutputTokens.max = 128000`、image/pdf、
   `reasoningLevel.values = ["disabled", "enabled", "low", "medium", "high", "xhigh", "max"]`
   （上游同时支持 toggle 与 effort；`disabled` 由通用 anthropic-messages 映射处理）。
   Opus 5.5 / Sonnet 5.5 继续由现有 `claude-(fable|opus|sonnet)-5` 家族规则命中，不重复建规则。
4. `modelApiRules` 补 GPT-6 家族、Grok 4.7 的 `openai-responses` 推理映射；
   Claude Haiku 5.5 沿用通用 anthropic-messages 映射，不新增 API 规则。
5. `providerSiteRules` 补两条与既有同族规则同形的条目：
   - OpenCode Go（`https://opencode.ai/zen/go/v1`）的 Grok 4.7：输出上限 500000；
   - OpenRouter（`https://openrouter.ai/api`）的 GPT-6 家族 anthropic-messages 映射。
6. `providerConfigRules.templateRules[].config.builtinModelIds` 与 `templateModelRules` 同步增加：
   - OpenAI：`gpt-6-sol`、`gpt-6-luna`、`gpt-6.1-sol`
   - Anthropic：`claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`
   - xAI：`grok-4.7`
   - OpenRouter：`openai/gpt-6-sol`、`openai/gpt-6-luna`、`openai/gpt-6.1-sol`、
     `x-ai/grok-4.7`、`anthropic/claude-opus-5.5`、`anthropic/claude-sonnet-5.5`、
     `anthropic/claude-haiku-5.5`
   - OpenCode Go：Responses 模板增加 `grok-4.7`、`gpt-6-luna`；Anthropic 模板增加
     `claude-haiku-5-5`
   - OpenCode Zen：Responses 模板增加 `grok-4.7`、`gpt-6-sol`、`gpt-6-luna`、`gpt-6.1-sol`；
     Anthropic 模板增加 `claude-opus-5-5`、`claude-sonnet-5-5`、`claude-haiku-5-5`
7. 层级与优先级不变：`内置 → 同步的智能配置（覆盖内置）→ 个人精确规则（最高）`。
8. `revision` 随内容递增（31 → 32）；同 revision 不同内容会被 `decodeZCodeBuiltinRelease`
   判为冲突。

## 状态所有者与接口

- **唯一数据源**：`config/provider/zcode-builtin.json`，构建期由
  `scripts/builtin-provider-config.mjs` 用运行时 decoder 校验后 stage 进 bundle。
- **解析**：`ModelConfigRules.resolve`（`packages/provider/src/config/model-config.ts`），
  `modelMatch` 为正则全匹配、忽略大小写；规则按数组顺序 overlay，后命中者覆盖前者。
  因此 GPT-6 家族规则必须排在 `gpt-6-astra` 专属规则之前。
- 本改动不改 schema、接口或解析语义。

## 验收场景

1. `grok-4.7` / `x-ai/grok-4.7` 解析为 `contextWindow = 500000`、`maxOutputTokens.max = 128000`、
   `supportsImage = true`；OpenCode Go 的同一模型在站点规则下输出上限为 500000。
2. `gpt-6-sol`、`gpt-6-luna`、`gpt-6.1-sol`、`openai/gpt-6-sol` 解析为 1050000 / 128000，
   推理档位包含 `none`；`gpt-6-astra` 仍为不含 `none` 的 `low..max`。
3. `claude-opus-5-5`、`claude-sonnet-5-5`（含 OpenRouter 点号写法）解析为 1000000 / 128000；
   `claude-haiku-5-5` 同样为 1000000 / 128000，且档位包含 `disabled` / `enabled`。
4. 模板条目：`xai:grok-4.7`、`anthropic:claude-opus-5-5`、`openai:gpt-6-sol`、
   `opencode-zen-messages:claude-haiku-5-5` 解析结果 `enabled = true`。
5. 家族边界不误伤：`gpt-6-astra` 不被家族规则改写；`grok-4.6`、`claude-haiku-4-5` 结果不变。
6. `decodeZCodeBuiltinRelease` 解析整份文件通过，`revision = 32`。
