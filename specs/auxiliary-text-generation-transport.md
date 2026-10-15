# 辅助文本生成的传输方式

## 背景

CLI 里有一批**辅助一次性生成**调用：提交消息、提示词增强、会话/目标标题、目标完成验证、WebFetch 正文提取、会话上下文读取、记忆抽取。它们共同的特征是「要一段最终文本，不要把增量推给 UI」，此前统一走 `Model.generateText`（非流式）。

部分 OpenAI-compatible 端点（例如经网关转发到 `api.cline.bot` 的 `cline-pass/*` 模型）在**非流式**请求里同样返回 SSE `data:` 帧或非 JSON 正文。AI SDK 会按普通 JSON 解析，抛 `AI_APICallError: Invalid JSON response`。该错误没有 HTTP 状态码、也没有 provider 业务码，经 CLI 失败分类器只能落到兜底分支，产出 `ModelRequestFailed / reason=unknown`，服务层再统一包装成「模型请求失败。」。

实际后果（2026-10-15 实测，工作区 `hzcloud-medical`）：把「提交消息模型」钉到 `cline-pass/deepseek-v4.1-flash` 后，提交消息 4 次生成 4 次失败；同一模型同一会话的流式主链路（`stream:true`）158 次全部成功；结构完全相同的非流式请求换成 `deepseek-v4.1-flash` 则成功。即：**请求体没有问题，问题在于该上游不接受非流式取正文**。

仓库此前已在两处按同一结论处理过：WebSearch 工具改为消费流（`webSearchHandler` 注释「走流式可复用现有 SSE compat」），Explore 子运行时继承父配置的 `modelStreaming`（`subagent.ts` 注释「部分 OpenAI-compatible 端点在非流式请求里也返回 SSE `data:` 帧」）。本 spec 把这条结论收敛成一条统一规则，而不是继续在调用点各自绕开。

## 产品规则

1. **辅助一次性生成一律走流式传输**：调用方拿到的是组装完成的 `ModelTextResult`，与原来 `generateText` 的返回契约一致；增量不推给 UI，也不写入会话流。

2. **单一实现**：组装逻辑只有一个出处——`packages/core/src/runtime/helpers/auxiliary-text-generation.ts` 的 `generateAuxiliaryText(model, request)`。调用点不得再各自实现「消费流拼结果」，也不得复制 WebSearch 里那份私有实现。

3. **适用面**：`querySource` 属于辅助生成、且不需要用户可配置传输方式的调用点：

   | 调用点 | querySource |
   | --- | --- |
   | `workspace-generate-text.ts` | `git_commit_message`、`prompt_enhance` |
   | `title-generation-sidecar.ts` | `session_title`、`goal_summary_title` |
   | `target-completion-verification.ts` | `target_completion_verification` |
   | `tool/handlers/webfetch-processing.ts` | `web_fetch_processing` |
   | `tool/handlers/read-session-context.ts` | `read_session_context` |
   | `memory/memory-agent-loop.ts` | 记忆抽取 |

4. **不适用面（明确排除，避免语义漂移）**：

   - 主链路 `runtime/methods/model.ts`：传输方式由用户设置 `modelStreaming` 决定，辅助规则不得覆盖用户选择。
   - `compact-summary-model-request.ts` 的 `generateText` 调用：它是**流式失败后**的回退分支，改为流式会形成自环。

5. **失败语义不变**：流式 `error` 事件经 `normalizeStreamError` 归一后抛出，与 `generateText` 一样是带 `code` / `reason` / `retryable` / `providerCode` 的 adapter 错误；依赖错误内容做重试判断的调用点（如目标验证的 Start Plan busy 重试）行为不变。流在未发出 `finish` 的情况下结束，沿用既有流式消费（WebSearch）的宽松语义：`finishReason` 记为 `unknown`，不额外抛错；空正文由各自调用点的既有校验处理（例如提交消息的空/不合规校验）。

6. **`git_commit_message` 的能力绑定不变**：仍使用 `auxiliaryModelOptions`（最低推理档 + 辅助输出预算），本次只换传输方式，不改模型、不改预算、不改提示词。

## 状态所有者

- **传输方式**：由 `generateAuxiliaryText` 单点决定，是辅助生成的唯一传输策略所有者；调用点不再持有该判断。
- **调用上下文**：仍由各调用点用 `runWithModelInvocationContext` 绑定（重试预算、准入、statusSink、trace）。helper 不接管调用上下文，避免出现第二个上下文来源。

## 接口

```ts
// packages/core/src/runtime/helpers/auxiliary-text-generation.ts
/**
 * 以流式传输完成一次辅助生成，并组装成与 generateText 等价的最终结果。
 * 上游在非流式请求里返回非 JSON 正文时，generateText 会失败；流式是这类端点唯一可靠取正文的方式。
 */
export function generateAuxiliaryText(
  model: Model,
  request: ModelRequest,
): Promise<ModelTextResult>;
```

组装覆盖：`text`（累加 `text_delta`）、`reasoning`（按 id 归并 `reasoning_start/delta/end`）、`toolCalls`（`tool_call`）、`usage` / `finishReason` / `providerMetadata`（`finish`）、`toolResults` / `sources`（若事件提供）。`error` 事件即抛。

## 验收场景

1. 模型在非流式下返回非 JSON 正文、在流式下正常 → 提交消息生成成功；调用点只换了传输方式，请求体（`thinking`、`max_completion_tokens`、messages）逐字段不变。
2. 流式正常返回 → 组装结果与 `generateText` 的 `text` / `finishReason` / `usage` / `toolCalls` 语义一致。
3. 流式 `error` 事件 → 抛出归一化后的 adapter 错误，`providerCode` / `reason` / `retryable` 保留。
4. 流中途无 `finish` 结束 → 与既有流式消费一致，`finishReason` 为 `unknown`，不抛错。
5. WebSearch 行为不变（复用同一 helper 后回归测试通过）。

## 已知限制

- `ModelStreamEvent` 不暴露 `sources` / `toolResults`（WebSearch 早已因此改为从摘要文本里提取来源），所以组装结果不含这两个字段。本次纳入的调用点都只消费 `text` / `finishReason` / `usage` / `toolCalls` / `reasoning`，不受影响；将来若有辅助调用点需要 `sources` / `toolResults`，必须先扩展流事件契约，不能再靠换传输方式绕开。
- 只改变传输方式，不改善 UI 失败提示粒度；上游以其它方式失败时仍显示既有文案。
- 不改主链路的 `modelStreaming` 开关语义。
