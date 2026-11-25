# 模型智能配置：2026-11 主流型号补充

## 范围

补充用户本地 `model-smart-config.json` 的推荐规则，不修改发行内置 catalog、供应商成员列表、个人配置、账号权益或 API 实现。范围仅为 Fable 5.2、GPT-6.2、Grok 4.7、GLM-5.4、Gemini 4。按 2026-11-25 在线官方文档和 OpenRouter 公开目录核实真实型号；不根据用户提供的简称推造后缀。

## 已核实型号

| 家族        | 官方型号或已确认别名                                                            | OpenRouter 交互路由                                  | 上下文 / 本次最大输出推荐值                                        |
| ----------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| Fable 5.2   | `claude-fable-5-2`                                                              | `anthropic/claude-fable-5.2`                         | 1000000 / 128000                                                   |
| GPT-6.2     | `gpt-6.2-astra`、`gpt-6.2-sol`                                                  | `openai/gpt-6.2-astra`、`openai/gpt-6.2-sol`         | 1050000 / 128000                                                   |
| GPT-6.2 Pro | 未确认独立的官方 `-pro` 模型 ID；官方通过 `reasoning.mode = "pro"` 选择执行模式 | `openai/gpt-6.2-astra-pro`、`openai/gpt-6.2-sol-pro` | 1050000 / 128000                                                   |
| GLM-5.4     | `glm-5.4`、Claude Code 的 `glm-5.4[1m]`                                         | 未确认公开路由                                       | 官方标注 1M / 128K；本次沿用仓库同单位的 1000000 / 128000 推荐口径 |
| Gemini 4    | `gemini-4-carbon`、`gemini-4-neon`、`gemini-4-hydrogen`、`gemini-4-argon`       | 对应 `google/` 前缀路由                              | 1048576（输入与输出合计）/ 65536（官方常规同步输出）               |
| Grok 4.7    | `grok-4.7`                                                                      | `x-ai/grok-4.7`                                      | 保留现有规则，不重复添加                                           |

没有已核实的裸 `gpt-6.2`、Gemini 4 Pro/Flash/Lite、GLM-5.4 Flash/Turbo/Highspeed 或公共 Grok 4.7 Fast/Vision API ID。目录中的 `canonical_slug` 日期后缀不等于可请求的模型 ID；`:batch` 是批处理服务变体，本次不加入交互配置。

Gemini 4 的 OpenRouter 目录上限为 943718，部分端点更低；Google 长解码也有更高上限。本次不自动启用长解码，使用官方常规同步 65536 推荐值，不把网关最大值当成所有端点的统一保证。

## 产品规则与边界

1. 只增加不冲突的新规则。保留已有规则的字段、相对顺序、`enabled` 和镜像内容，不删除已有冷门模型；本次不再新增冷门型号。
2. 基础属性使用仅覆盖已核实 ID 的全匹配正则，允许单个厂商前缀以及 GLM 已确认的 `[1m]` 别名。不能使用宽泛的未来家族后缀匹配。基础属性放在原有扁平条目之前，由既有模板/账号精确条目覆盖；新协议/站点映射和新模板条目置于其后，避免改写既有供应商专属参数。
3. GPT-6.2 和 Fable 5.2 推理档位为 `low / medium / high / xhigh / max`，不提供 `none` 或 `disabled`。
4. Gemini 4 Carbon/Argon 为 `low / medium / high`；Neon/Hydrogen 增加 `xhigh`。这些档位也由 OpenRouter 当前 `reasoning.supported_efforts` 元数据确认。
5. GLM-5.4 提供原生归一化档位 `low / high / max`；Coding Plan 将关闭 thinking 的旧客户端请求归一化为 low，不虚构独立的无推理执行模式。
6. 参数映射按实际协议或已核实站点限定，不把 Chat 字段写进 Responses 或 Anthropic 请求：
   - GPT-6.2 Responses：`reasoning.effort` 与 `max_output_tokens`。
   - GPT-6.2 Chat：`reasoning_effort` 与 `max_completion_tokens`。官方 GPT-6.2 工具调用只在 Responses 提供；Chat 不声明工具能力，OpenRouter 站点按目录单独开放工具支持。
   - Fable 5.2 Anthropic：`thinking.type = "adaptive"`、`output_config.effort` 与 `max_tokens`。
   - GLM-5.4 Coding Plan Anthropic：`thinking.type = "enabled"`、`output_config.effort` 与 `max_tokens`。
   - GLM-5.4 Coding Plan Chat：`thinking.type = "enabled"`、`reasoning_effort` 与 `max_tokens`，限定 `/api/coding/paas/v4`。
   - OpenRouter Chat：使用公开统一格式 `reasoning.effort` 与 `max_tokens`；Pro 路由自身选择 Pro 模式，不把该后缀注册为官方 OpenAI ID。Pro 的基础属性另由 OpenRouter 站点限定规则提供，使无模板的自定义供应商也排除不受支持的 `none` 档位。
7. 模板精确条目只补推荐元数据，API 映射由协议/站点规则拥有，避免用户切换模板的实际 API 后沿用错误字段。
8. GLM-5.4 目前只确认 Coding Plan 已开放，公开标准 API 尚待安全评估。只补 Coding Plan 模板及通用推荐，不为标准 API 或账号添加可选成员，不强制设置 `enabled`。
9. 仓库没有原生 Gemini transport。本次 Gemini 4 面向已有兼容网关；不新增不存在的 Google 模板，也不写入原生 Interactions API 的 `generation_config` 字段。
10. 未明确证明的 PDF、原生搜索、中途 system 或严格 JSON Schema 能力保持稀疏继承；结构化 JSON 能力不自动等同于严格 JSON Schema。

## 唯一所有者与事件顺序

推荐规则沿用 `specs/model-smart-config-sync.md` 的文件、解析和刷新接口，不增加状态副本或第二条自动写入路径。此次是用户授权的离线本地维护，运行时事实仍由 `ProviderConfigService.read()` 产生；个人精确配置优先级不变。

```text
用户授权维护本地文件
  → 校验完整文件与 option map
  → 本地文件 watcher / 后续 fresh read
  → ProviderConfigService 合并 builtin、local
  → Registry revision 更新
  → 现有模型推荐配置
个人精确规则仍在最后覆盖；可选模型成员仍由供应商配置拥有。
```

页面的“重新读取”只重读展示；本次不替用户执行远端发布或同步。后续点击“从远端仓库同步”仍会整份覆盖本地，因此未发布到远端的追加内容会被覆盖。

## 验收

- 修改前先建立本地新型号断言，确认新规则缺失；修改后用生产 schema、parser 和 builtin/local 合并验证。
- 每个目标 ID/别名命中正确上下文、输出上限、推理档位；每个档位及最大输出映射都能编译和执行。
- OpenRouter Gemini Neon/Hydrogen 保留目录确认的 xhigh；Carbon/Argon 不出现 xhigh。
- 模型正则不命中推测的 Flash/Turbo/日期/裸型号或批处理后缀。
- 所有原有 selector 的有效配置及禁用状态不变，Grok 4.7 不产生重复规则；本地新增 28 条规则（5 条属性、1 条 Pro 站点属性、6 条协议/站点映射、16 条模板精确推荐），384 条增至 412 条。
- 个人精确规则仍能覆盖新增推荐。
- 实际执行既有 model-smart-config 回归、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；不把无凭据情况下未执行的真实推理请求声称为通过。
- 一次性验证和原文件快照放系统临时目录，完成后清理。

## 来源（2026-11-25）

- OpenAI 型号与参数：[模型目录](https://developers.openai.com/api/docs/models)、[GPT-6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra)、[GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol)、[推理模式](https://developers.openai.com/api/docs/guides/reasoning.md)。
- Anthropic：[Fable 5.2](https://platform.claude.com/docs/en/models/fable-5-2/overview)、[effort](https://platform.claude.com/docs/en/build-with-claude/effort)、[structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)。
- GLM：[BigModel GLM-5.4](https://docs.bigmodel.cn/cn/guide/models/glm-5.4.md)、[Coding Plan 最新模型与别名](https://docs.bigmodel.cn/cn/coding-plan/latest-model.md)、[Z.ai GLM-5.4](https://docs.z.ai/guides/llm/glm-5.4)。
- Google：[Carbon](https://aistudio.google.com/docs/models/gemini-4-carbon)、[Neon](https://aistudio.google.com/docs/models/gemini-4-neon)、[Hydrogen](https://aistudio.google.com/docs/models/gemini-4-hydrogen)、[Argon](https://aistudio.google.com/docs/models/gemini-4-argon)、[thinking](https://aistudio.google.com/docs/thinking)。
- xAI：[Grok 4.7](https://docs.x.ai/developers/models/grok-4.7)、[release notes](https://docs.x.ai/developers/release-notes)。
- OpenRouter：[实时模型目录（含 reasoning.supported_efforts）](https://openrouter.ai/api/v1/models)、[公开 reasoning 请求格式](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)。
