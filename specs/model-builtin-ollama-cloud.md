# 内置 Provider 接入 Ollama Cloud

## 背景

Ollama Cloud 是把同一套 Ollama 模型目录放在官方托管端点上跑的 OpenAI 兼容网关，`models.dev`
已收录为 `ollama-cloud`：

- `api`：`https://ollama.com/v1`（上游 npm 包 `@ai-sdk/openai-compatible`）
- `doc`：`https://docs.ollama.com/cloud`
- `env`：`OLLAMA_API_KEY`（控制台 `https://ollama.com/settings/keys`）
- 模型 23 个：DeepSeek V4.1 / V4 Pro、GPT-OSS 120B / 20B、MiniMax M3 / M3.1 Flash / M2.7、
  Nemotron 3 Ultra / Super / Nano、Muse Spark Open、Beam、Gemma4、Kimi K3 / K2.6 / K2.7 Code、
  GLM 5.3 / 5.3 Flash / 5.2、Mistral Large 3 / 4。

ZCode 之前没有这家内置模板，用户只能手工建自定义 Provider，也拿不到推荐参数。

## 产品规则

1. `providerConfigRules.templateRules` 新增模板 `ollama-cloud`：
   - `api.type = openai-chat-completions`，`baseUrl = https://ollama.com/v1`
   - `access` 为 `api-key`，`apiKeyManagementUrl = https://ollama.com/settings/keys`
   - `builtinModelIds` 为上游 23 个模型（保持 models.dev 顺序）
   - `logo = { type: "builtin", key: "ollama" }`
2. Logo 用 Ollama 官方仓库 `docs/` 里的美洲驼标志：
   - 浅色主题 `docs/favicon-dark.svg`（黑色描边），深色主题 `docs/favicon.svg`（白色描边）。
   - 上游文件名描述的是「目标背景」，与 OpenRouter 的 light/dark 语义相反，素材名单里已注明。
   - 落地为 `model-provider-ollama-light.svg` / `model-provider-ollama-dark.svg`，
     `ProviderLogo` 只按 `logo.key` 分辨率素材，不认 Provider ID。
3. `templateModelRules` 为 23 个模型各写一条 `enabled: true`。
4. 不新增全局 `modelRules`：这 23 个模型里有 Gemma4、Nemotron 3、GPT-OSS、Beam、Mistral Large 3
   等内置尚未建规则的家族，若为它们加全局正则，会连带改写同名的本地模型配置；推荐参数统一由远端
   分片按 `templateId + modelId` 精确提供（与 CommandCode / ClinePass 同一策略）。
5. 远端库新增分片 `ollama-cloud.json`，`index.json` 的 `files` 追加一项，manifest `revision` 4 → 5。
   分片条目按 models.dev 的 `limit` / `modalities` / `tool_call` / `structured_output` /
   `reasoning_options` 生成，映射沿用 `openai-chat-completions` 的 `maxOutputTokensMap`
   （`{'max_completion_tokens': maxOutputTokens}`）与通用 `reasoningLevelMap`。
   - `reasoning_options` 为 `effort` 时，`reasoningLevels` 取上游档位值；
   - `toggle` 与 `effort` 同时出现时，在档位前补 `none`（toggle 的关闭态），如
     `minimax-m3` → `none/low/medium/high/max`；
   - 只有 `toggle` 或上游 `reasoning: true` 但没有档位列表时，取 `disabled/enabled`；
   - `reasoning: false` 的模型（如 `mistral-large-3:675b`）不写 `reasoningLevels` / `reasoningLevelMap`。
6. 内置 release `revision` 34 → 35（同一 revision 必须对应同一份内容）。

## 状态所有者与接口

- 内置模板与模型规则唯一数据源：`config/provider/zcode-builtin.json`。
- 远端推荐参数唯一来源：gist 分片，同步仍手动触发，合并语义不变
  （builtin → synced → personal exact）。
- 不新增 schema、RPC 或 UI 接口；新模板复用现有 Provider 添加流程。

## 验收场景

1. 添加 Provider 时可选 `ollama-cloud`，模板卡片显示 Ollama 美洲驼 Logo，浅色 / 深色主题都可辨识。
2. 默认模型数量为 23，`ollama-cloud:gpt-oss:120b`、`ollama-cloud:glm-5.3`、
   `ollama-cloud:mistral-large-4` 的 `enabled = true`。
3. 同步远端后，`ollama-cloud:gpt-oss:120b` → 131072 / 32768，`ollama-cloud:gemma4:31b` →
   262144 / 262144，`ollama-cloud:mistral-large-4` → 1048576 / 262144，且不再落兜底 200000/32000。
4. `decodeZCodeBuiltinRelease` 通过，`revision = 35`；合并后的远端文件通过
   `modelSmartConfigFileSchema`，manifest `revision = 5`。
