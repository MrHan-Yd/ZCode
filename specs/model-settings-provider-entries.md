# 模型设置的供应商入口（Model Provider entries）

## 背景

`packages/ui/src/settings/ModelProviderSection.tsx` 的左侧导航此前分成两组：

1. `preset`（标题取 `settings.modelProvider.presetTitle`，中文「智谱」）：内置预置品牌项 +
   `Start Plan` 项，两项都来自同一 Family，由 `effectiveProviderFamilyDomain` 过滤后只显示当前生效的一组。
2. `custom`（标题 `settings.modelProvider.customTitle`，中文「自定义供应商」）：用户自建的 API Key 供应商。

本次把所有内置预置入口下线：左侧导航只保留「自定义供应商」，选中内置项才会出现的右侧套餐面板
（`Detail.tsx` 的 `preset` 分支与编程套餐分支、套餐商品卡片、连接按钮、内嵌购买 webview）
因为不再有入口而自然不可达。**底层能力保留**：账号 Provider（`zhipu-account`）、OAuth 登录、
Start Plan / 编程套餐权益与计费链路、购买接口都没有删除。

## 产品规则

1. 模型设置左侧导航只渲染「自定义供应商」分组；分组内没有供应商时该分组标题也不渲染。
2. 侧栏没有任何供应商入口，且不在加载中时，右侧渲染空态卡片
   （文案 `settings.modelProvider.empty`，"暂无自定义模型供应商"），不停留在加载态。
3. 当前选中项不在侧栏时，选中回落到侧栏第一张供应商卡片（自定义供应商）；侧栏为空则回落为无选中项。
4. 「添加供应商」模板选择器里的智谱分组（`bigmodel-api` / `zai-api` / `bigmodel-standard-api` /
   `zai-standard-api`）保持不变：那是用 API Key 新建自定义供应商的快捷方式，与内置账号入口不是一回事。

## 状态所有者

- **侧栏选中项**：`ModelProviderSection` 的 `selectedNodeKey`（组件内 state），唯一写入路径是点击侧栏项、
  创建供应商完成后的补选，以及外部跳转意图。
- **导航分组**：`useModelProviderNavigation` 的 `navigationGroups` memo，按 `customProviders` 计算，
  不再读取内置预置清单。
- **空态判定**：`ModelProviderSection` 由 `navigationGroups` 聚合出 `sideNavigationEmpty` 传给 Detail，
  Detail 不再自行推断。

## 接口变更

- `useModelProviderNavigation` 去掉 `presetProviders` 选项；`PresetProviderWithConfig`、
  `resolvePresetFamilyStatusProvider`、`resolveSideNavigationNodeKeyForConnectionItem`、
  `isFamilyPresetNodeKey` 一并删除。
- `constants.ts` 删除 `PresetProviderSpec`、`PRESET_PROVIDER_SPECS`、`PRESET_PROVIDER_SPEC_BY_ID`
  （只服务这两个入口）。
- `useModelProviderNavigation` 的回落逻辑简化为「侧栏第一项」，不再把 Family/套餐节点当回落目标。
- `ModelProviderSectionDetail` 新增 `sideNavigationEmpty?: boolean`；`StatusCards` 新增
  `ModelProviderEmptyCard`。

## 事件顺序

```text
进入设置页 → selectedNodeKey 初始化（外部意图 / null）
  → 侧栏分组只含自定义供应商
  → selectedNodeKey 不在侧栏 → 回落第一张供应商卡片
      ├─ 有自定义供应商：选中它并渲染其详情
      └─ 没有：selectedNodeKey 保持 null
              └─ Detail 判定 sideNavigationEmpty && !presetLoading → 空态卡片
```

外部「打开某个提供商」意图（`setPendingSettingsSectionIntent("modelProvider", { modelProviderId })`
→ `resolveProviderFamilySideNodeKey`）如果指向内置 Family/套餐 Provider，会落到上面的回落路径：
入口已下线，不再打开套餐面板，改为选中第一张供应商卡片。当前仓库没有调用方传入 `modelProviderId`。

## 验收场景

1. 有自定义供应商：侧栏只有「自定义供应商」分组，进入设置页默认选中第一项，右侧是该供应商详情。
2. 没有任何自定义供应商：侧栏为空，右侧显示"暂无自定义模型供应商"，无持续转圈。
3. 首屏加载中：右侧仍是加载态；数据返回且侧栏为空后才切到空态。
4. 点击「添加供应商」→ 模板选择器仍能看到「智谱」分组，可创建 API Key 类型的自定义供应商，
   创建完成后新供应商被自动选中。
5. 任何平台、任何入口（标题栏、设置页）都不再出现 `BigModel` / `Start Plan` 这两条默认入口。
