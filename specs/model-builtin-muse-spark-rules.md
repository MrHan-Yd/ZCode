# 内置模型规则补 Muse Spark 家族（Model builtin rules: Muse Spark）

## 背景

「模型智能配置」的推荐值来自内置 `config/provider/zcode-builtin.json` 的 `modelConfigRules`。
Muse Spark 家族（Meta 发布，OpenCode Zen / Zen Go 等网关在服务）在内置规则里此前完全缺席：
`opencode-zen-chat / muse-spark-1.2-contributor-free` 只有 `enabled: true`，其余变体连条目都没有，
于是全部落到兜底规则 `.*` 的 `contextWindow = 200000` / `maxOutputTokens.max = 32000`。

上游公开目录（`models.dev` 的 `meta` / `opencode` / `opencode-go`）对 1.1 / 1.2 / 1.3 及
`-contributor` / `-contributor-free` 变体给出的都是 **context 1048576 / output 131072**，输入模态为
text/image/video/audio（模型侧另有 pdf）。也就是说内置的 200k 不是模型能力，而是「没有规则就吃兜底」。

## 产品规则

1. 内置 `modelRules` 新增一条家族规则：`.*muse-spark-1[.\-]\d(?:[.\-:/\[].*)?`，
   命中任意 provider 的 muse-spark 1.x（含 `meta/muse-spark-1.3`、`-contributor`、`-contributor-free`
   以及供应商的连字符写法 `muse-spark-1-2`），给出：
   - `properties.contextWindow = 1048576`
   - `optionSpecs.maxOutputTokens.max = 131072`
   - `properties.inputFormat.supportsImage / supportsVideo / supportsAudio = true`；`supportsPdf = false`
     （显式写 false 以标明这是待验证项：网关是否透传 PDF 尚未确认，确认后再改）
2. 推理档位沿用兜底语义：`reasoningLevel.values = ["disabled", "enabled"]`，不写 `map`
   （映射交给 API 级规则与供应商规则，和 `mimo-v2.5` 同形）。
3. 未写的字段继续继承兜底（`supportsText` / `supportsToolCall` / `supportsJsonSchemaOutput` 等）。
4. 层级与优先级不变：`内置 → 同步的智能配置（覆盖内置）→ 个人精确规则（最高）`；
   个人与同步规则仍可覆盖家族规则，本改动不引入新的优先级。
5. `revision` 必须随内容递增（30 → 31）。内置 release 用 revision 标识内容：同 revision 不同内容会被
   `decodeZCodeBuiltinRelease` 判为冲突并拒绝整份 release。

## 状态所有者与接口

- **唯一数据源**：`config/provider/zcode-builtin.json`（构建期由 `scripts/builtin-provider-config.mjs`
  用运行时 decoder 校验后 stage 进 bundle；运行时可被控制面下发的同名 release 整包替换）。
- **解析**：`ModelConfigRules.resolve`（`packages/provider/src/config/model-config.ts`），
  `modelMatch` 为正则全匹配、忽略大小写。本改动不改任何 schema、接口或解析语义。

## 验收场景

1. 任意 provider 解析 `muse-spark-1.3-contributor` → `contextWindow = 1048576`、
   `maxOutputTokens.max = 131072`、`inputFormat.supportsImage = true`。
2. `muse-spark-1.3`、`muse-spark-1.2-contributor-free`、`meta/muse-spark-1.3`、`muse-spark-1-2`
   命中同一规则（连字符与斜杠前缀都覆盖）。
3. 家族边界不误伤：`gpt-5.3-codex-spark`、`muse-glimmer-30b` 不命中该规则（分别是 400000 / 兜底 200000）。
4. 个人精确规则仍最高：同一 id 上有个人规则 `contextWindow = 1000000` 时，生效值是 1000000。
5. `decodeZCodeBuiltinRelease`（构建期校验入口）解析整份文件通过，`revision = 31`。
