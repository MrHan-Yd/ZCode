# Responses 请求的 prompt_cache_key

## 背景

ZCode 用 `providerOptions: { apiFormat }` 表达 provider 的 API 格式，请求体交给 `@ai-sdk/openai` 的 `responses()` 构造。SDK 只有在 `providerOptions.openai.promptCacheKey` 存在时才会写入 `prompt_cache_key`，而仓库此前没有任何地方构造它，所以 `openai-responses` 请求一直不带该字段。

部分上游把它当必填项：第三方中转的 codex 类渠道对 `POST /v1/responses` 直接返回

```
400 {"error":{"message":"prompt_cache_key is required","code":"invalid_responses_request"}}
```

实测（2026-10-29，`anyrouter.top` + `gpt-6.1-sol`）：同一请求体只差这一个字段——不带时 400 且中转控制台记为「错误/非流/0 元」；带上时 200 `text/event-stream` 正常流式返回。该模型在该中转上只能走 `/responses`（`/v1/chat/completions` 返回 404「当前 API 不支持所选模型」），因此切 API 格式无法绕开，只能在请求里补字段。

同时暴露出两个相关的可观测性缺陷，本 spec 不修，但记录边界以免混淆：

- Base URL 少写 `/v1` 时，`https://<host>/responses` 是站点兜底路由，返回 **200 + text/html**。AI SDK 当 SSE 解析出 0 个事件，得到空完成流（`finishReason: "other"`），连接测试只看有没有 `finish` 事件，于是报「连接成功」，主链路报「模型未返回任何内容」。真实错误被这层掩盖。
- `response.failed` 帧里的 `response.error` 被 SDK 丢弃，适配层仍只能看到空完成。

## 产品规则

1. **会话稳定**：`prompt_cache_key` 取请求所属会话的 `sessionId`（`ModelStatusContext.sessionId`）。同一会话的所有请求复用同一个键，不同会话不同——这既是 OpenAI 对该字段的推荐用法（同会话提升前缀命中），也满足上游「必须提供且稳定」的校验。不得使用每次请求都变化的随机值。

2. **适用范围**：仅 `providerKind === "openai"` 且 `apiFormat === "openai-responses"` 的请求。`openai-chat-completions`（`providerKind: "openai-compatible"`）与 `anthropic-messages` 不受影响，避免给不知道这个字段的上游塞未知参数。

3. **单一注入点**：在 `apps/zcode-cli/packages/adapters/src/model/runner-options.ts` 的 providerOptions 组装处注入，与既有的 `mergeAnthropicRequestMetadata` 同层。流式（`createStreamTextOptions`）与非流式（`createGenerateTextOptions`）两条路径都经过这里，因此主 turn、连接测试、辅助生成、子代理、compact 自动覆盖，不需要各调用点分别处理。

4. **不覆盖显式配置**：调用方已经通过 `request.providerOptions.openai.promptCacheKey` 给出值时，保持调用方的值。`statusContext.sessionId` 缺失时不注入（不伪造键），该请求按上游行为原样失败。

5. **不改请求头、不改 fetch 层**：字段由 AI SDK 序列化为 body 字段。不在 fetch 包装里改写请求体，避免绕过 SDK 的 body 语义与 model-io 记录。

## 状态所有者

- **键值来源**：`sessionId` 由 core 通过 `traceContext` 传入，adapter 只读，不新增状态。
- **注入决策**：`runner-options.ts` 的两个选项构造函数是唯一所有者；core 不感知 `prompt_cache_key`。

## 接口

```ts
// apps/zcode-cli/packages/adapters/src/model/runner-options.ts
function mergeOpenAIResponsesPromptCacheKey(input: {
  providerKind: ResolvedAiSdkModel["providerKind"];
  providerOptions: Record<string, unknown> | undefined;
  sessionId: string | undefined;
}): Record<string, unknown> | undefined;
```

合并结果形如 `{ apiFormat: "openai-responses", openai: { promptCacheKey: "sess_..." } }`。

## 验收场景

1. `openai-responses` + 有 `sessionId`：`createStreamTextOptions(...).providerOptions.openai.promptCacheKey === sessionId`。
2. `openai-responses` + 无 `sessionId`：不出现 `openai.promptCacheKey`。
3. `openai-chat-completions`（`providerKind: "openai-compatible"`）或 `anthropic-messages`：不出现 `openai.promptCacheKey`，其余 providerOptions 原样保留。
4. 调用方自带 `promptCacheKey`：保留调用方的值。
5. 既有 `anthropic.metadata.userId` 注入不受影响（两条注入互不覆盖）。

## 迁移与失败边界

- 官方 `api.openai.com` 接受该字段，行为变化仅为缓存按会话分组，无需迁移。
- 严格校验未知参数的 OpenAI-compatible 实现若拒绝该字段，会把请求打回 400；出现时按 provider 配置调整，不在代码里加静默回退分支。
