# 内置 Provider 接入 CommandCode / ClinePass

## 背景

CommandCode 与 ClinePass 都是 OpenAI 兼容的模型聚合网关，`models.dev` 已收录：

- `commandcode`：`https://api.commandcode.ai/provider/v1`，71 个模型，覆盖 Claude、GPT、Grok、
  Gemini、Kimi、GLM、Qwen、MiniMax、DeepSeek、Muse 等。
- `cline-pass`：`https://api.cline.bot/api/v1`，18 个模型，模型 id 统一带 `cline-pass/` 前缀。

ZCode 之前没有这两家的内置 Provider 模板，用户只能手工添加自定义 Provider，且无法从
「模型智能配置」远端库拿到它们的推荐参数。

## 产品规则

1. `providerConfigRules.templateRules` 新增两个模板，均为 `api.type = openai-chat-completions`
   （上游 npm 包为 `@ai-sdk/openai-compatible`）：
   - `commandcode`：baseUrl `https://api.commandcode.ai/provider/v1`，
     `builtinModelIds` 为上游 71 个模型（保持上游顺序）。
   - `cline-pass`：baseUrl `https://api.cline.bot/api/v1`，
     `builtinModelIds` 为上游 18 个模型。
2. 两个模板的 access 都是 `api-key`，`apiKeyManagementUrl` 先指向各自官方文档页
   （`https://commandcode.ai/docs/provider`、`https://docs.cline.bot/getting-started/clinepass`），
   确认控制台地址后再替换。模板不写 `logo`（当前没有内置 logo 资源）。
3. `templateModelRules` 为两个模板的每个模型写入 `enabled: true`。
4. `modelRules` 补两条新家族规则（两家目录里出现、但内置此前没有的模型）：
   - `.*mimo-v2\.6(?:-(?:pro|flash))?(?:[.\-:/\[].*)?`：context 1048576 / output 131072，
     输入 image/video/audio，推理档位 `none/low/medium/high/xhigh`。
   - `.*muse-wonder-1[.-]\d(?:[.\-:/\[].*)?`：context 1048576 / output 131072，
     输入 image/video/audio/pdf，推理档位 `low…max`。
5. 其余模型（Gemini、Mistral、StepFun、Nemotron、Inkling、Fugu、Tencent、Ling 等）不新增全局
   规则，避免扩大内置规则面；它们的推荐参数由远端 gist 分片按 `templateId + modelId` 精确提供。
6. 远端库新增两个分片 `commandcode.json`、`cline-pass.json`，`index.json` 的 `files` 追加两项，
   `revision` 3 → 4。分片条目按上游 `models.dev` 的 limit / modalities / tool_call /
   structured_output / reasoning_options 生成，映射沿用 `openai-chat-completions` 的通用
   `maxOutputTokensMap` 与 `reasoningLevelMap`。
7. `revision` 32 → 33。

## 状态所有者与接口

- 内置模板与模型规则唯一数据源仍为 `config/provider/zcode-builtin.json`。
- 远端推荐参数唯一来源为 gist 分片；同步仍是手动触发，合并语义不变
  （builtin → synced → personal exact）。
- 不新增 schema、RPC 或 UI 接口；新模板直接复用现有 Provider 添加流程。

## 验收场景

1. 添加 Provider 时可选择 `commandcode` / `cline-pass`，默认模型数量分别为 71 / 18。
2. `commandcode:claude-opus-5-5`、`commandcode:gpt-6-sol`、`cline-pass:cline-pass/kimi-k3`
   在同步后解析结果 `enabled = true`。
3. 内置解析 `cline-pass/mimo-v2.6-pro` → 1048576 / 131072；`meta/muse-wonder-1.0` →
   1048576 / 131072。
4. 同步远端后，上游覆盖但内置未建规则的模型（如 `google/gemini-4-argon` 1000000/65536、
   `thinkingmachines/inkling-small` 1000000/1000000、`mistral/mistral-large-4` 524288/262144）
   不再落到兜底 200000/32000。
5. 17 个分片合并后通过 `modelSmartConfigFileSchema`，`decodeZCodeBuiltinRelease` 通过，
   `revision = 33`。
