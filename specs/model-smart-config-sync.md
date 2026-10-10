# 模型智能配置：本地数据源与远端同步（Model smart config sync）

## 背景

「模型智能配置」（`resolveModelConfig` 的推荐配置）此前只有一个数据源：随程序打包的
`config/provider/zcode-builtin.json` 里的 `modelConfigRules`（内置正则规则），运行时还可被
ZCode 控制面下发的同名 release 整包替换。用户无法自行补充参数；第三方出模型后，内置规则不覆盖就
只能落到默认值。

本改动只增加**一个数据源**：一份可由用户同步维护的模型规则文件。解析与「智能配置自动填入」的
行为完全不变，`resolveModelConfig` / resolver / registry 的语义不改。

## 数据流

```
gist(raw JSON) ──[点击「从远端仓库同步」]──▶ {appConfigDir}/model-smart-config.json
   ──[每次 read 新鲜读取]──▶ 合并进「内置模型规则层」（排在 builtin 之后）
   ──▶ composeEffective(builtin+synced, personal) ──▶ 现有 resolveModelConfig
```

优先级（沿用现有 `ModelConfigRules.resolve` 的「按序 overlay、后者覆盖前者」）：
`builtin 规则 → 同步规则（覆盖 builtin）→ 个人精确规则（最高）`。

## 产品规则

1. **默认读本地**：设置页打开时只读 `{appConfigDir}/model-smart-config.json`，不发起任何网络请求。
2. **手动同步**：只有用户点击「从远端仓库同步」才会拉取远端并覆盖本地文件；不做定时/自动同步。
3. **固定远端地址**：远端来源固定为该公开 gist 的 raw 地址，界面只展示、不允许修改。
4. **文件缺失或损坏不阻断**：本地文件不存在 / 非法 / 校验失败时，视为「无同步规则」，不影响启动与
   内置行为；同步失败时保留本地已有内容不变。
5. **同步后立即生效**：写入本地文件后触发现有 provider 刷新，使新规则进入 registry / 模型选择器。

## 远端布局（gist）

远端按厂商拆成多个文件，入口是一个清单：

- `index.json`：`{ "schemaVersion": 1, "revision": 1, "files": ["shared-model-rules.json", "openai.json", ...] }`。
  `files` 的顺序即合并顺序（同类数组按此顺序拼接）。
- 每个分片文件与本地文件同 schema（`{ schemaVersion, revision?, models, modelConfigRules }`）。
- 约定分片：跨厂商的正则/接口/站点规则各放一个 `shared-*.json`；`templateModelRules` 按厂商拆
  （`openai.json`/`anthropic.json`/`xai.json`/`deepseek.json`/…）；账号级 `builtinProviderModelRules` 放 `accounts.json`。

同步时按清单逐个拉取分片，合并成**单份本地文件**写入本地；本地读取逻辑不变。任一分片失败则整体失败、
本地文件保持不变。

## 文件格式（本地 `{appConfigDir}/model-smart-config.json`）

本地是合并后的单文件，含两条通道：

1. `models`：**扁平、面向手工维护**的规则。新增模型时只写需要覆盖的字段，未写字段继续继承内置默认（稀疏叠加）。
2. `modelConfigRules`：**原样镜像**内置 release 的 `modelConfigRules`（同 schema：`modelRules` / `modelApiRules` /
   `providerSiteRules` / `templateModelRules` / `builtinProviderModelRules`，各数组可缺省）。用于把内置或任意来源的
   智能配置整份搬进来而不丢 `map` / `apiTypeMatch` / `baseUrlMatch` / `templateId` 等字段。

解析顺序（`ModelConfigRules.resolve` 按序 overlay、后者覆盖前者）：
`modelConfigRules`（镜像）→ `models`（扁平，覆盖镜像）→ 内置不参与（镜像已是内置副本）；个人精确规则仍最高。

```json
{
  "schemaVersion": 1,
  "revision": 1,
  "models": [
    { "modelMatch": "gpt-7.*", "contextWindow": 400000, "maxOutputTokens": 128000,
      "reasoningLevels": ["minimal", "low", "medium", "high"], "supportsImage": true },
    { "providerId": "deepseek", "modelId": "deepseek-v5", "contextWindow": 256000 }
  ],
  "modelConfigRules": {
    "modelRules": [{ "modelMatch": ".*", "config": { "properties": { "contextWindow": 200000 } } }],
    "modelApiRules": [], "providerSiteRules": [], "templateModelRules": [], "builtinProviderModelRules": []
  }
}
```

- 每条规则用 `modelMatch`（正则，作用于任意 provider）或 `providerId` + `modelId`（精确）二选一，不能同时/都没有。
- 参数字段：
  - `contextWindow` (int > 0) → `properties.contextWindow`
  - `maxOutputTokens` (int > 0) → `optionSpecs.maxOutputTokens.max`
  - `reasoningLevels` (非空、不重复字符串数组) → `optionSpecs.reasoningLevel.values`
  - `supportsImage` / `supportsVideo` / `supportsAudio` / `supportsPdf` / `supportsText` → `properties.inputFormat.*`（`supportsText` 同时作用于 `outputFormat.supportsText`）
  - `supportsToolCall` / `supportsJsonSchemaOutput` / `supportsNativeWebSearch` / `supportsMidConversationSystem` → `properties.*`
  - `enabled` (bool) → `config.enabled`
- `schemaVersion` 必须为 `1`；`revision` 可选，仅用于展示与变更提示。

## 状态所有者

- **本地规则文件**：`{appConfigDir}/model-smart-config.json`（`getAppConfigDir()` = `~/.zcode/v2`）。
  唯一写入方是同步服务；其余读取方只读。
- **合并后的生效规则**：`ProviderConfigService.read()` 产出的 `ProviderConfigSnapshot.zcodeBuiltinModelRules`
  （= `mergeModelConfigRules(builtin.models, syncedRules)`），是 registry 的唯一事实源。
- **同步触发**：仅渲染层「同步」按钮 → `IModelSmartConfigService.syncFromRemote()`。

## 接口

- `packages/provider/src/config/model-smart-config.ts`（纯逻辑，无 IO）
  - `modelSmartConfigFileSchema`：扁平文件 schema。
  - `parseModelSmartConfigRules(input): ModelConfigRules`：映射为 `model`（正则）/ `provider-model`（精确）规则 + 稀疏 `ModelConfig`。
  - `mergeModelConfigRules(a, b): ModelConfigRules = new ModelConfigRules([...a.rules(), ...b.rules()])`。
- `packages/provider-node/src/model-smart-config-source.ts`
  - `NodeModelSmartConfigRulesSource implements ProviderSource<ModelConfigRules>`：`read()` 每次读盘；缺失/损坏→空规则。
  - 路径常量 `MODEL_SMART_CONFIG_FILE_NAME = "model-smart-config.json"` 与环境变量 `ZCODE_MODEL_SMART_CONFIG_FILE`。
- `packages/provider/src/config-service.ts`：`ProviderConfigServiceDependencies` 增加可选 `modelSmartRulesSource`；
  `read()` 合并规则并把同步源 revision 计入 snapshot `revision`。
- `packages/services`：`IModelSmartConfigService { read(); syncFromRemote(); }` + 描述符（channel `model-smart-config`），
  实现位于 `packages/services/src/model-provider/modelSmartConfigService.ts`。
- `packages/ui/src/settings/ModelSmartConfigSection.tsx` + 设置分区 `modelSmartConfig`。

## 验收场景

1. 无本地文件时打开设置页「模型智能配置」：显示本地路径与空状态，无网络请求；模型行为与改动前一致。
2. 点击「从远端仓库同步」：拉取 gist raw JSON → 校验 → 原子写本地 → 触发 provider 刷新 → 列表刷新并提示成功。
3. 远端返回非法 JSON / 网络失败：本地文件保持不变，界面提示失败并保留原列表。
4. 本地文件含 `{ "modelMatch": "gpt-7.*", "contextWindow": 400000 }`：新增 `gpt-7-*` 模型时智能配置自动填入 400000，
   个人精确规则仍可覆盖它。
5. 使用损坏的本地文件启动：规则视为空，内置行为不受影响。
