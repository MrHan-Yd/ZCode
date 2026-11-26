# Gemini 原生 GenerateContent API 格式

## 范围与交付边界

本 spec 定义新增格式的完整产品边界，不把仅扩展契约等同于已接通全部模型调用。本阶段先交付 spec、provider-neutral 内容契约及其正式测试；配置资产、SDK adapter、runtime/history 和 UI 按下述同一契约继续实现。

- 持久配置 canonical 格式为 `gemini-generate-content`，AI SDK kind 为 `google`。
- 接入 Gemini Developer API 的 `generateContent` / `streamGenerateContent`，不是 OpenAI 兼容协议。
- 精确使用已审计的 `@ai-sdk/google@3.0.151`，保持 `ai@6.0.193`；公开入口为 `createGoogleGenerativeAI` 和 `chat()` / `languageModel()`。不使用 deprecated `generativeAI()`，不升级到 Google SDK 4.x。
- 不包含 Vertex、Interactions、OAuth、Live/WebSocket、托管 Agent、embedding 或图片/视频生成。不能用 Interactions 的参数名、服务端 chaining 或档位表证明 GenerateContent 能力。
- 原有 `openai-responses`、`openai-chat-completions`、`anthropic-messages` 的协议、默认值和配置语义保持不变。`schemaVersion`、个人设置结构及 Agent 产品身份 `ZCodeProvider` 不变。
- 不写用户生产配置，不自动切换既有 `google/gemini-*` 兼容网关模型，不发布远端规则，不恢复已退役的配置 store。

## 配置与请求规则

### 格式、地址与模型身份

1. `packages/provider/src/config/provider-data-schema.ts` 是 API 格式枚举的唯一来源；完整配置、个人覆盖、模板、同步及 Provisioning 复用它，不能另建格式清单作为服务端事实。
2. 内置模板、模型能力和 option map 的产品资产位于 `config/provider/zcode-builtin.json`。共享类型包不承载这些资产，设置 UI 不持有另一套模型参数默认值。
3. Gemini Base URL 只在 factory 绑定边界形成请求副本，保留用户配置及冻结 binding 原值。移除尾部 `/`，保留 gateway path prefix 和显式 API version；无显式末尾 `v1` / `v1beta` 时追加 `/v1beta`。

   | 输入示例                                            | SDK Base URL                                       |
   | --------------------------------------------------- | -------------------------------------------------- |
   | `https://generativelanguage.googleapis.com/`        | `https://generativelanguage.googleapis.com/v1beta` |
   | `https://generativelanguage.googleapis.com/v1/`     | `https://generativelanguage.googleapis.com/v1`     |
   | `https://generativelanguage.googleapis.com/v1beta/` | `https://generativelanguage.googleapis.com/v1beta` |
   | `https://gateway.example.test/proxy/google/`        | `https://gateway.example.test/proxy/google/v1beta` |
   | `https://gateway.example.test/proxy/google/v1/`     | `https://gateway.example.test/proxy/google/v1`     |

   URL 必须是合法 HTTP(S) API 前缀；原生格式拒绝 query、fragment 和已包含具体 model action 的端点，不猜测或剥离它们。错误不能触发协议降级。

4. SDK 非流式路径为 `/models/{model}:generateContent`，SSE 路径为 `/models/{model}:streamGenerateContent?alt=sse`；相对 API 根（Base URL）拼接。设置页展示的是含版本的规范路径 `/v1beta/models/{model}:generateContent`，与 Anthropic 的 `/v1/messages` 保持同一认知；Base URL 仍允许省略版本并在运行时补齐。不添加 OpenAI 的 `/chat/completions`，不使用 Interactions action。
5. 仅 factory 调 SDK 时去掉模型 ID 开头的一次 `models/`。Registry、ModelSelection、模型覆盖 key、日志归因和冻结 binding 的 `modelId` 不改写；不能在全局注册表去重或重命名模型。
6. 修改 API 格式不偷偷替换用户 Base URL、Key、headers 或模型成员。UI 必须通过已有 draft/save/reload 路径保存稀疏个人覆盖。

### 鉴权、网络与错误

- SDK 默认 Key header 为 `x-goog-api-key`。复用已有 API Key 解析及请求期 `ModelRequestAuth`，不新增 Google 凭据库或 OAuth 状态。
- header 名大小写不敏感：已有 default headers → provider 显式 headers → 请求期 headers；显式 `x-goog-api-key` 优先于 SDK 自动生成的同名 header。请求期 Key 仍按既有鉴权入口覆盖冻结 Key，既有受控 session/trace 归因 header 优先级不变。
- 不为 Google 自动加 Bearer Authorization；用户显式 gateway header 保留。`x-goog-api-key`、Authorization 和其它命中的凭据 header 必须按既有脱敏规则隐藏。
- 复用 `AiSdkModelExecution` 的 frozen binding、option-map fetch、业务错误解析、proxy/CA/noProxy、request admission、取消和 retry；不能新增另一条 fetch 或 provider runtime。
- Google HTTP JSON / SSE `error.code`、`status`、`message` 与原始 HTTP 状态保持归因，401/403、429、5xx、context limit、非法请求及取消沿用现有错误码与 retryable 边界。不能把未知 `google` kind 降为 `openai-compatible`。
- 不将 Anthropic reasoning-signature repair 泛化为 Google 签名清洗。缺失签名不能靠删历史、超时、重发已执行工具或换协议掩盖。

### 能力、推理和输出

- 请求体由 AI SDK 形成 `contents`、`systemInstruction`、`generationConfig`；option map 仍是用户选项到请求字段的唯一映射权威。
- 原生输出上限映射为 `generationConfig.maxOutputTokens`，包括无精确模型规则的稀疏兜底；仅增加 API enum 但缺少 required option map 不算支持。
- 已验证的 Gemini 2.5 型号按模型规则映射 `generationConfig.thinkingConfig.thinkingBudget`；已验证的 3+ 型号映射 `thinkingLevel`。`includeThoughts` 只在相应规则证明支持时使用。
- 只声明具体型号已经证实的档位、预算、上下文、输入格式和工具能力。SDK 接受 minimal/low/medium/high/xhigh 不等于所有模型支持这些值；未知型号只给可执行的稀疏默认，不虚构全套 thinking 档位。
- 原生 `supportsMidConversationSystem=false`，复用既有 history/system projection，不在消息中间发送新的 `systemInstruction`。
- runtime 请求投影读取绑定后冻结的 `Model.providerKind`；`midConversationSystem.mode === "force"` 对 `providerKind === "google"` 不生效，仍按 `supportsMidConversationSystem=false` 的提醒投影，避免 Google SDK 对中途 `system` message 抛 `UnsupportedFunctionalityError`。其余 provider 的 force 语义保持不变。
- `responseJsonSchema` 在 generate 与 stream 两条 runner-options 路径都构造同一 AI SDK `output`；补全当前 stream 漏构造 output 的缺口。无能力时显式失败，不静默降为普通文本/JSON object。
- usage 采用 SDK v6 已归一化的 input/output/total 与 cache/reasoning 明细；Google output 已含 thoughts，不能再加 reasoningTokens；input 已含 cache，不能二次累计。

### 原生 WebSearch 能力边界

本次不实现 Google Search。Google Search 无法无损表达现有 WebSearch 的 `allowed_domains`、`blocked_domains` 和 `maxUses`，且当前 adapter 的 provider-native 分支只覆盖 anthropic，因此 Gemini 不提供原生搜索，也不保留后续“隔离子集”的承诺。

1. 所有 `gemini-generate-content` 模型声明 `supportsNativeWebSearch=false`；内置模板、智能规则、option map 与个人覆盖保持一致，不能标成 true。
2. WebSearch 工具走现有能力缺失清错路径：`core/src/tool/handlers/websearch.ts` 在 `supportsNativeWebSearch` 为 false 时以 ConfigurationError 显式失败（recoverable），不发起模型请求、不忽略用户约束，也不用 prompt 假装过滤或限制次数。
3. `adapters/src/model/tool-transform.ts` 的 provider-native 分支只对 anthropic 生效；Google kind 不会构造 Google Search，落到 unsupported/invalid-request 边界时按既有错误失败，不静默降级、不改走其它协议。
4. Anthropic 原生搜索默认 8 次与现有上限保持不变，不因 Gemini 未实现而改写或挪动默认值。
5. 不新增仓库不存在的外部搜索 fallback；普通 Gemini 对话及其它已支持工具不受影响，结果不伪造 sources/citation。
6. 能力声明和界面文案必须如实说明 Gemini 不支持原生 WebSearch，不能把未实现能力标成 true 或承诺后续子集。

## 单一所有者与事件顺序

```text
settings draft (UI local only)
  -> ProviderSettingsFacade
  -> PersonalProviderConfigRepository.update (only personal writer)
  -> ProviderConfigService (builtin -> synced smart -> personal)
  -> RegistryService (one effective revision)
  -> modelFactory -> frozen endpoint / format / options
  -> per-attempt admission / auth / proxy / retry -> AI SDK
  -> normalization -> ordered assistantContent
  -> CLI runtime canonical parts / MessageHistory
                 |-> SessionStore JSON parts -> SQLite cold hydration
                 `-> request-local SDK projection -> next model turn

desktop-continuous ---- direct live projection -------+
                                                       +-> same CLI owner / sequence / history
web-remote-replayable -- snapshot + replay + gap repair +
```

- 配置事实由 ConfigService/Registry 持有；绑定后不受后续 revision 静默切换影响。个人配置写入继续经 repository.update，Gist/Provisioning 不增加第二个 writer。
- 已接受输入由 CLI `CommandInbox` 串行 admission；本改动不增加 accepted queue、参数缓存或 Renderer 事实源。
- 每个请求内的 content collector 只组装该请求的临时响应；接受提交后的事实仍是 CLI canonical parts/history。兼容视图按需派生，不能成为另一条独立写入路径。
- Host owner/lease、跨 Host 路由、stale run/branch fence、工具幂等键、workspaceIdentity 与 remoteSessionId 原样保留。身份 key 仍为 `workspaceIdentity?.trim() || workspacePath`；文件操作仍用 workspacePath。
- Main/relay 仅鉴权、调度和转发，不保存签名副本、任务快照或新的模型 history。手机 attachment 复用桌面已有运行时。

## 内容与签名契约

### 最小 additive 公共接口

公共入口继续为 `@zcode/contracts` 与 `@zcode/contracts/model`。

| 契约                               | 增量字段/类型                                                      |
| ---------------------------------- | ------------------------------------------------------------------ |
| `ModelTextContentBlock`            | `providerOptions?: Record<string, unknown>`                        |
| `ModelReasoningContentBlock`       | 沿用已有 `providerOptions`                                         |
| `ModelToolCall`                    | `providerOptions?: Record<string, unknown>`，保留 providerExecuted |
| `ModelToolCallContentBlock`        | `type: "tool_call"`，其余字段与 ModelToolCall 相同                 |
| `ModelAssistantContentBlock`       | text / reasoning / tool_call 的最小联合，不扩大通用媒体输入联合    |
| `ModelAssistantContent`            | 上述 block 的原始顺序数组                                          |
| `ModelInputMessage`                | `assistantContent?: ModelAssistantContent`，仅 assistant role 合法 |
| `ModelTextResult` / `ModelResult`  | `assistantContent?: ModelAssistantContent`                         |
| text_start / text_delta / text_end | 每种事件增加 `providerMetadata?: Record<string, unknown>`          |
| `projectModelAssistantContent`     | 无状态地派生 content、text、reasoning、toolCalls，不缓存、不改输入 |

- 新 normalization 和 history 路径存在 `assistantContent` 时，该数组是消息 provider 内容的唯一权威；`text`、`reasoning`、`toolCalls` 及输入 `content` 是兼容视图，不分别累积或接受独立更新。空数组是显式空结果，不按 falsy 降为旧视图。
- 旧数据无 assistantContent 时沿用旧 content/reasoning/toolCalls 的导入边界；不能编造已丢失的签名或原始 interleaving。新增原生调用必须产生有序数组，不能永久只走旧视图。
- 兼容 text 是依次拼接 text block 原文，不加入分隔符；兼容 content 保留 text/reasoning 顺序；toolCalls 从 tool_call 派生并仅去掉 type，保留全部调用字段。展示/日志字符串不能替代回放内容。
- 结果顶层 providerMetadata 是请求/finish 元数据，不是任何 text、reasoning 或 tool part 的签名所有者。
- SDK part 的 `providerMetadata.google.thoughtSignature` 按原值进入该 block 的 `providerOptions.google.thoughtSignature`。字段名不改，不解码/重编码，不 trim，不合并到 aggregate text，不从 neighbouring part 复制。
- 尾部 `text: ""` 携带签名必须保留；无正文但有元数据的 reasoning 也保留。有签名的普通 text、reasoning、tool-call 可交错，不能重排为“所有 reasoning → 一个 text → 所有 tools”。
- 并行工具调用中合法 unsigned part 保持缺字段，不注入空签名、假签名或前一个工具的签名。显式空字符串与缺字段不互换。
- Google SDK 3.0.151 的缺签名 sentinel/warning 是 SDK 降级，不是正确回放证据；验收必须逐 part 断言原签名完全一致，正常 signed 历史不能靠 sentinel 获得通过。
- 已核实：Google SDK 的 assistant message 转换对 `text: ""` 的 part 直接返回 `undefined`，空 text 无法出现在 wire 请求里。因此“尾部空 signed text”只作为历史/投影契约：ZCode 保证已到达的 part 不因空正文被自己丢弃，并保留其签名元数据；SDK 会在最终 wire 边界丢弃该空 part，这一点由 adapter 见证式测试锁定，不能反过来据此改写历史或补假签名。

### Streaming 组装与提交

```text
provider part start(id) -> reserve one ordered position
        -> delta(id, text + optional metadata) -> same part
        -> end(id, optional metadata) -> same part finalized
        -> assistantContent commit -> canonical part upsert

parallel tool input start(id) -> reserve declaration position (display only)
        -> input deltas/end -> SDK final tool_call(id, providerOptions)
        -> replace same position, not append another call
        -> pending -> running -> completed/error (same canonical part)
```

- Text/reasoning collector 按 event id 维护原始 part 边界；delta 无 id 时只能沿用既有当前 open part 规则，不能把不同已命名 part 拼成一个签名容器。
- start、delta、end 的 provider metadata 都参与同一 part 合并；按 provider namespace 的字段增量合并，后来的显式值覆盖同字段，无字段不能擦掉已有 signature。合并不串联字符串，不把整个 namespace 的一次稀疏更新当成清空。
- 最终 tool_call 携带回放 metadata。tool-input 生命周期只是展示和声明位置，不凭 delta 提前执行工具；SDK 在中间事件提供的 metadata 由 assembler 汇入同一个 final ModelToolCall，不需要另建业务事件队列。
- nonstream 使用 SDK 原始 ordered content，不从 result.text/result.toolCalls 重建顺序。stream 主 collector 和 auxiliary collector 使用同一顺序/元数据规则；不能只在主会话修复。
- request finish、取消或工具终态更新不能覆盖已有 part metadata。stop snapshot 保留已收到的逐 part 内容、顺序、签名与未完成状态，不能只保存聚合 text/reasoning 字符串。
- 重试沿用现有未提交/已提交输出边界，旧 attempt 的 late event 不得写入新 attempt；签名也属于这一 fence。不延迟提交或加 timeout 掩盖顺序问题。

### 持久化与恢复

- `TextPart`、`ReasoningPart`、`ToolPart` 已有 metadata record；SQLite JSON codec 可无损存储，无需新列、schemaVersion 或 migration。
- 新 text/tool 的 provider payload 放在 `part.metadata.providerOptions`，与工具结果预算、展示、providerToolName 等 owner metadata 隔离。既有 reasoning 的直接 provider namespace metadata 继续兼容，不为了新 text/tool 重写历史 Anthropic 数据。
- `part.metadata.providerContentIndex` 记录同一 assistant 中所有 text/reasoning/tool-call 的共同声明序号，用于恢复完整 interleaving；不是仅工具的 declarationIndex，也不能用异步保存时间或工具完成顺序替代。该序号不得发送给 SDK。
- 累加器分配 `providerContentIndex` 时必须使用与 `snapshot()` 相同的保留谓词（无签名空 text/reasoning 不占位），使工具流式落盘与取消/终态快照落盘使用同一下标来源；不能直接使用内部未过滤 parts 下标。已知边界：若某空正文 part 在后续 tool_call 声明之后才收到签名元数据，已分配的序号不会重排；正常 provider 顺序是 text/reasoning part 先结束（元数据到达）再进入下一个 tool_call，因此不为此引入第二套兜底重排。
- reasoning 回放从其 metadata 中排除 providerContentIndex 等 owner 字段；text/tool 只投影 providerOptions 子记录，不能把全部存储 metadata 当作 SDK 参数。
- hydrating、during-stream 恢复、stop/resume、fork/remap、rewind、output-token continuation、compact preserved tail 和 Memory 多轮工具循环都保留具体 part 的 payload 和声明顺序。
- 工具 pending/running/completed/error 的多次 upsert 复用同一 id、保留 providerOptions/providerContentIndex；结果 metadata 与调用 metadata 不互相替代。
- compact summary 是新的合成消息，不能复制旧 part 签名到摘要；未被摘要替换的真实 preserved parts 原样保留。Compact 的 stream 失败后 nonstream fallback 保持原行为，不形成流式自环。

### JSON Schema、运行时校验与 wire 边界

- 内容、tool-call、有序 assistant 内容、输入 message、result 与 stream event 提供对应 Zod 运行时 schema 和 JSON Schema。新增内容 JSON Schema 从同一 Zod 定义生成，不维护第二份 provider 字段白名单。
- 外层字段严格校验；providerOptions/providerMetadata 是 opaque record，允许其它 provider namespace。数组、字符串或 null 不能代替 record。tool-call input、tool-result output 和 error 事件的 error 必须存在，可为 null；undefined 不是可回放 JSON 值。空工具名保持既有 provider 原文的兼容语义。
- 模型 request 的现有 JSON Schema 复用新的 input message schema，runtime-only statusSink、signal、admission、trace 等仍不序列化。
- 机械拆分不修改 `modelSelectionJsonSchema`、request 除 messages 以外的字段或 `modelNetworkStatusEventJsonSchema` 的既有形状；network schema 继续使用 `model` selection 字段及原有事件枚举，不借本次内容扩展重写为 status TypeScript 类型的另一种协议。
- 本阶段不新增 wire 字段。`packages/shared/src/zcode-protocol/index.ts` 的 strict streaming payload 继续只投影既有 kind/partId/delta/tool 字段，不能 spread ModelStreamEvent.providerMetadata。
- CLI 是 provider replay 的事实所有者，UI 不编辑/生成签名，也不把签名保存为 Zustand accepted state。现有 transcript part 的 metadata record 可读取该兼容扩展；Desktop live 与手机恢复共享同一 canonical source。
- `workspace/generateText` 的公开字符串/工具结果仍是派生投影，不成为第二个签名 history。若后续确实新增 wire 内容字段，必须同时修改 shared 严格 schema、类型、CLI mapper/hydrator 及两种 delivery 的测试，不能仅放宽 validator。

## 全部入口与责任清单

以下入口必须消费同一 Registry/modelFactory 和同一内容契约，不各造 Gemini factory。

| 入口/边界                                                     | 当前源码责任点                                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider 格式、模板、智能规则、个人覆盖                       | `packages/provider/src/config/`、`config/provider/zcode-builtin.json`、既有 option-map 规则                                                          |
| 设置新增/编辑/保存/连接测试，中文/英文、主题、桌面/手机       | `packages/ui/src/settings/model-provider-section/`、`packages/ui/src/i18n/locales/`                                                                  |
| Composer、自动化、子代理覆盖、Git 固定模型、编排角色选择      | `modelSelectionGroups.ts`、`useModelSelectionView.ts` 的 Registry 投影                                                                               |
| 主会话 generate/stream                                        | `apps/zcode-cli/packages/core/src/runtime/methods/model.ts`、turn-model-step/context/turn-tools                                                      |
| Subagent、DAG、script/dynamic/expert workflow、workflow child | `bootstrap/src/app/create-app.ts` 注入的同一个 ApiProviderModelRuntime.modelFactory                                                                  |
| Git 提交、提示增强、workspace/generateText、连接探测          | `core/src/runtime/methods/workspace-generate-text.ts`                                                                                                |
| 会话/目标标题、目标验证、WebFetch、会话上下文读取             | `core/src/runtime/helpers/auxiliary-text-generation.ts` 与现有调用点                                                                                 |
| Compact 与 output-token continuation                          | compact-summary-model-request、turn-output-token-continuation 与 preserved history                                                                   |
| Memory 多轮抽取/工具调用                                      | `core/src/memory/memory-agent-loop.ts`                                                                                                               |
| History、冷恢复、stop、fork、工具多阶段保存                   | message-history、session-history-hydrator、cancelled-stream-persistence、tool-part-persistence/streaming-tool-coordinator                            |
| 配置文件、Gist 同步、Provisioning                             | provider-config-file-codec、PersonalRepository、providerConfigSync、providerProvisioningSource/Target、shared/provider-provisioning                  |
| 旧格式单向导入                                                | services 的 legacyModelProviderSerialized/legacyZCodeConfigProviderReader/legacyPersonalProviderConfigImporter，CLI legacy-cli-model-config/importer |
| Desktop stdio / Host attachment / 手机 replay                 | shared/zcode-protocol、shared/zcode-protocol-v4、bootstrap mapper/transcript-hydration                                                               |
| Desktop bundle / CLI SEA                                      | `scripts/builtin-provider-config.mjs`、`apps/zcode-cli/packages/cli/scripts/sea-provider-config-assets.mjs` 的现有资产路径                           |

- 旧 `gemini` 格式与 Google npm kind 仅在既有单向 importer 规范化为 canonical；不恢复 legacy store、不反向写旧文件、不覆盖已有个人配置。
- Gist 上传继续剥 access.apiKey、下载保留本机 Key，headers 中疑似凭据沿用确认扫描；Provisioning 是另一种授权凭据传输，保留 syncId 幂等、CAS、rollback，不混用 Gist 的剥 Key 语义。
- UI 通过 hooks/service contract 访问，不直接访问 Repo/window.zcode；本地/远端差异仍由注入的平台/Host 服务处理。

## 验收场景与门禁

### 本阶段契约验收

1. text、reasoning、tool-call 的签名经 runtime schema 和 JSON 往返后逐字一致；无签名 parallel call 仍无字段；尾部空 text 不丢失。
2. 有序数组同时用于 result 和 assistant input/history，text/reasoning/tool-call interleaving 不变；projectModelAssistantContent 仅派生兼容视图，原数组不变。
3. text_start/delta/end 允许各自 providerMetadata，reasoning 既有通道和最终 tool_call.providerOptions 保留；JSON Schema 与运行时 validator 同步。
4. metadata 形状错误、未知外层字段、非 assistant 携带 assistantContent、缺失 tool input 在边界失败，null input 合法。
5. 无新可选字段的旧三种格式消息/结果/流继续通过，无新 schemaVersion 或必需签名。
6. shared 既有 transcript metadata record 接受 text/tool 签名与声明序号，strict UI streaming 拒绝新增 providerMetadata/providerOptions；正式 shared 测试位于 src 并纳入根 typecheck。
7. 先写正式契约测试并实际确认 red，再实现字段/schema；contracts 测试纳入该包真实 typecheck，build 后公开 dist 声明供下游使用。

### 完整实现验收（后续各责任步骤，不以本阶段单测冒充）

| 验收面                            | 必须证明                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 四格式保存/重读/模板/智能配置     | native canonical 可执行，未知型号稀疏默认；旧三格式配置及个人覆盖无变更                                                              |
| URL、Key、headers、proxy、模型 ID | root/v1/v1beta/prefix/尾斜杠、generate/SSE action 正确，显式 header 优先且脱敏，Registry identity 不变                               |
| 推理/输出                         | 2.5 budget 与已验证 3+ level 按型号映射，generate/stream JSON output 一致，不支持能力明确失败                                        |
| 原始 signed fixture 往返          | 普通 text/reasoning、末尾空 text、parallel tools、start/delta/end 晚到 signature；续轮实际 SDK 请求逐 part 原签名一致，未靠 sentinel |
| 生命周期                          | live、SQLite 冷恢复、during-stream、stop/resume、fork/rewind、compact tail、output continuation、Memory 和工具全部终态               |
| 全入口                            | 主代理、subagent、各 workflow、Git/标题/验证/探测/辅助调用共用 factory/options/normalization                                         |
| Search                            | Gemini 显式 `supportsNativeWebSearch=false`，WebSearch 走能力缺失清错；不构造 Google Search；Anthropic 8 次默认不变                  |
| 失败与使用量                      | Google JSON/SSE error、401/403/429/5xx、取消、重试 fence、usage/cache/thoughts 不重复累计                                            |
| 同步/导入/打包                    | Gist 剥 Key、Provisioning CAS/rollback、legacy 单向导入、builtin bundle/SEA 资产与依赖 pin                                           |
| 跨端 E2E                          | Desktop continuous、手机 replay/gap repair、owner/lease/identity/stale 防护，中英文/主题/桌面手机格式选择和实际使用                  |

执行现有根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；CLI 变更同时执行 `pnpm --dir apps/zcode-cli typecheck` / `lint`，并执行 contracts 正式测试与 build。其它定向测试/E2E 使用对应 package.json 的真实入口，不假定统一 pnpm test。未执行、已有失败和环境限制分别报告，不能将仅 SDK 类型兼容或无 HTTP 400 当成端到端通过。
