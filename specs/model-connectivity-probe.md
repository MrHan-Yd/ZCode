# 模型连接测试探测请求的参数边界

## 背景

设置页的「连接测试」由 `testModelConnectivity` 发起：固定 2 条极短消息（`CONNECTIVITY_PROBE_SYSTEM` + `"hi"`）、最低推理档位、以及一个刻意收紧的输出预算 `CONNECTIVITY_PROBE_MAX_OUTPUT_TOKENS`，目的是不等待正文生成。

该预算此前取 `1`。Responses 类上游会对 `max_output_tokens` 做最小值校验，2026-10-29 在 `anyrouter.top` 的 codex 渠道实测：`1/2/4/8/15` 全部返回

```
400 {"error":{"type":"invalid_request_error","param":"max_output_tokens","code":"integer_below_min_value"}}
```

`16` 才通过。也就是说，这类 provider 的配置本身是正确的，连接测试却必然报「连接失败」，用户会被误导去改 Base URL / API Key。

## 产品规则

1. 探测预算取上游普遍接受的最小合法值 `16`。它仍然远小于辅助生成的 5,000 预算，不会因为探测而等待长正文。
2. 不得因为某一家上游的报错就放宽成完整预算；探测的目的只是验证「凭证 + 端点 + 格式」可用。
3. 探测成功判据不变：收到 `finish` 事件即通过，`error` 事件即失败。
4. 已知未覆盖：上游返回 200 但正文为空/非 SSE 时，探测仍会判成功（该缺陷单独处理，不在此规则内）。

## 状态所有者

- 预算常量与探测消息内容：`apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts`，单点持有，设置页不传预算。

## 验收场景

1. 连接测试发出的请求 `max_output_tokens >= 16`。
2. 探测仍只发送固定的 2 条消息，不混入会话历史。
3. 探测失败时错误信息包含上游原文（如 `integer_below_min_value`），不再只有笼统的「连接失败」。

## 边界

- 这是探测专用预算，不影响主链路、辅助生成或 compact 的输出预算。
- 若将来有上游要求更大的最小值，应把常量对齐到该最小值并在此记录，而不是按 provider 分支特判。
