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
   确认控制台地址后再替换。两个模板都声明内置 Logo：`commandcode` → `{ type: "builtin",
   key: "commandcode" }`，`cline-pass` → `{ type: "builtin", key: "cline" }`。
   - CommandCode 用品牌页提供的黑底白结方形符号 SVG，浅色与深色主题共用同一份素材。
   - Cline 用官方品牌包里的机器人图标：深色描边版用于浅色主题，白色版用于深色主题。
   - 素材与来源记录在 `packages/ui/src/assets/provider-icons/`（`model-provider-commandcode.svg`、
     `model-provider-cline-light.svg`、`model-provider-cline-dark.svg`）和
     `model-provider-logo-sources.json`；`ProviderLogo` 只按 `logo.key` 解析，不认 Provider ID。
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
7. 内置 release `revision` 32 → 33；补齐 Logo 属内容变更，`revision` 33 → 34
   （同一 revision 必须对应同一份内容，否则远端同序号会冲突）。

## 状态所有者与接口

- 内置模板与模型规则唯一数据源仍为 `config/provider/zcode-builtin.json`。
- 远端推荐参数唯一来源为 gist 分片；同步仍是手动触发，合并语义不变
  （builtin → synced → personal exact）。
- 不新增 schema、RPC 或 UI 接口；新模板直接复用现有 Provider 添加流程。

## 2026-11-17 三种接口格式（Chat / Anthropic / Responses）

### 背景证据

- CommandCode 官方文档列出三个端点，都在同一个 base URL 下：
  `/provider/v1/chat/completions`、`/provider/v1/responses`、`/provider/v1/messages`。
  文档明确「Claude 模型只走 `/messages`」，「OpenAI 与开放模型走 `/chat/completions`，
  其中大多数也走 `/responses`」，并指明 `/models` 每个条目带 `supported_endpoints`
  字段（`https://commandcode.ai/docs/provider`，2026-11-17 复核）。
- 运行时探测：同一 base URL 下伪路径返回 404，三个真实端点都返回 401（缺凭据），
  证明三条路由都存在。
- `https://api.commandcode.ai/provider/v1/models` 当前 101 个模型：12 个仅 `/messages`、
  77 个同时支持 `/chat/completions` + `/responses`、12 个仅 `/chat/completions`。
- ClinePass 官方文档只记载 `POST /api/v1/chat/completions`（OpenAI Chat Completions），
  未提及 Anthropic Messages 或 Responses；`api.cline.bot` 对未知路径同样先鉴权，
  无凭据时无法区分路由是否存在。因此 ClinePass 的 Anthropic / Responses 两种格式
  **未经验证**，按产品要求随 Chat 一起提供，待真实 Key 联调确认。

### 产品规则

1. 三个既有模板 ID 保持不变，只给名字补格式后缀，避免已保存的 Provider 与个人配置中的
   `templateId` 引用失效：`commandcode` → `CommandCode (Chat)`、
   `cline-pass` → `ClinePass (Chat)`。新增 `commandcode-messages` /
   `commandcode-responses`、`cline-pass-messages` / `cline-pass-responses`。
2. 同一供应商的三个模板共用同一 base URL，只有 `api.type` 不同（沿用 OpenCode Go / Zen
   的既有做法）：
   - `anthropic-messages`：`normalizeAnthropicBaseURL` 保留已带 `/v1` 的路径，运行时
     请求 `…/provider/v1/messages`、`…/api/v1/messages`。
   - `openai-responses`：运行时请求 `…/provider/v1/responses`、`…/api/v1/responses`。
   - `openai-chat-completions`：运行时请求 `…/provider/v1/chat/completions`、
     `…/api/v1/chat/completions`。
3. CommandCode 按上游 `supported_endpoints` 拆分模型清单，同一模型只出现在真正能服务它
   的格式里：
   - Chat：53 个同时支持 chat + responses 的开放模型，加 6 个仅 chat 的模型，加 1 个已从
     上游目录下线、但保留以免打断现有选择的 `inclusionai/ling-3.1-flash:free`，共 60 个。
   - Responses：上述 53 个同时支持两种格式的模型。
   - Anthropic：11 个 Claude 模型（`claude-*`）。
   - 迁移边界：Chat 模板不再列 Claude 模型。此前在 Chat 下选中 Claude 的用户会得到
     `model-not-found`，需要改用 Anthropic 模板。这是有意为之——这些模型在
     `/chat/completions` 上本来每次请求都返回「wrong endpoint」。
4. ClinePass 三个模板共用同一份 18 个模型清单：上游没有按格式给出的模型能力数据，
   而模型 ID 带聚合网关前缀，无法从 `models.dev` 推断按格式拆分。
5. `templateModelRules` 为 6 个新模板的每个模型写 `enabled: true`；模型参数仍由
   `modelRules` / `modelApiRules` / 远端分片提供。本次不新增全局规则，也不改
   `providerSiteRules`（这三个 host 没有站点级规则，不会给 Anthropic / Responses 配上
   `max_completion_tokens` 之类的错误映射）。
6. 新模板 ID 暂无远端分片：同步远端后，只有已建全局规则的家族会拿到完整参数，
   Gemini / Mistral / StepFun / Nemotron / Inkling / Fugu / Tencent / Ling 等仍落兜底
   200000 / 32000。补齐分片属于 gist 侧变更，本次不推送。
7. 内置 release `revision` 35 → 36。

## 验收场景

1. 添加 Provider 时可选择 `commandcode` / `cline-pass`；Chat 模板的默认模型数量为 60 / 18
   （CommandCode 的 Claude 模型已按 2026-11-17 的格式拆分移出 Chat，见下文）。
2. `commandcode:claude-opus-5-5`、`commandcode:gpt-6-sol`、`cline-pass:cline-pass/kimi-k3`
   在同步后解析结果 `enabled = true`。
3. 内置解析 `cline-pass/mimo-v2.6-pro` → 1048576 / 131072；`meta/muse-wonder-1.0` →
   1048576 / 131072。
4. 同步远端后，上游覆盖但内置未建规则的模型（如 `google/gemini-4-argon` 1000000/65536、
   `thinkingmachines/inkling-small` 1000000/1000000、`mistral/mistral-large-4` 524288/262144）
   不再落到兜底 200000/32000。
5. 17 个分片合并后通过 `modelSmartConfigFileSchema`，`decodeZCodeBuiltinRelease` 通过，
   `revision = 34`。
6. Provider 模板卡片与侧栏展示 CommandCode、ClinePass 的品牌 Logo，不再回落到兜底方块图标；
   Cline 的描边在浅色 / 深色主题下都能看清。

### 验收场景（2026-11-17 格式拆分）

1. 添加 Provider 页面出现 6 张卡片：`CommandCode (Chat)`、`CommandCode (Anthropic)`、
   `CommandCode (Responses)`、`ClinePass (Chat)`、`ClinePass (Anthropic)`、
   `ClinePass (Responses)`，顺序按上述排列，Logo 与 Chat 卡片一致。
2. `commandcode` 模板的 `builtinModelIds` 不含任何 `claude-*`；`commandcode-messages`
   恰好是 11 个 Claude 模型；`commandcode-responses` 是 53 个同时支持 `/responses` 的模型。
   Claude 只出现在 Anthropic 卡片；Chat 与 Responses 之间允许重叠，因为上游同一个模型
   确实同时支持两种格式。
3. 三个模板解析出的 `api.type` 分别为 `openai-chat-completions`、
   `anthropic-messages`、`openai-responses`，`baseUrl` 完全相同。
4. `cline-pass-messages` / `cline-pass-responses` 的 `builtinModelIds` 与
   `cline-pass` 相同（18 个），`api.type` 不同。
5. 新模板下的模型默认 `enabled = true`；`decodeZCodeBuiltinRelease` 通过，
   `revision = 36`。
