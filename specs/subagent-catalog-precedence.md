# 子智能体目录的同名优先级与停用回退

## 背景

内置角色名在创建入口是保留名（`assertNotBuiltInName`），但用户仍可以把 Markdown 文件直接放进 `~/.zcode/agents/` 或项目的 `.zcode/agents/`。目录列表按名称去重时是「后者覆盖前者」：用户级/项目级文件会覆盖同名内置角色。

运行时加载器（`loadZCodeAgentProfiles`）对**停用的用户级 profile** 直接跳过，因此同名内置角色仍然生效。目录列表却先做名称覆盖、再计算 `enabled`，于是出现不一致：

- 用户有一份停用的 `~/.zcode/agents/ui-designer.md`；
- 运行期实际使用内置 `ui-designer`；
- 设置/编排团队目录里 `ui-designer` 却显示为「不可用」（覆盖它的那份用户 profile 被停用），编排团队无法勾选，看起来像内置角色坏了。

本次让目录优先级与运行时一致：**停用的用户级 profile 不得遮住同名且已启用的角色**。不新增协议、RPC 或持久化字段。

## 产品规则

1. **停用优先让位**：按名称去重时，如果后来的候选是「停用的用户级 profile」，而当前已选中的同名角色不是停用状态，跳过这个候选，保留已启用角色。
2. **只对用户级生效**：与 `attachEnabledState` 一致，只有 `scope === "user"` 的 profile 可以被停用；内置、项目、插件角色不受 `disabledAgentIds` 影响。
3. **通用覆盖语义不变**：已启用的用户级 profile 仍按既有规则覆盖同名内置角色（用户显式自定义优先）；项目级 profile 的覆盖行为不变。
4. **不隐藏停用项**：没有同名冲突的停用 profile 仍出现在目录里，`enabled: false` 照常展示，供设置页重新启用。`settingsUserOnly` 模式不做名称优先级，内置组与用户组各自完整。
5. **运行时与目录同源**：目录只反映运行时实际可派发的角色。运行时跳过停用 profile 时，目录必须回落到内置角色，不能把「不可用」标在一个实际可用的角色上。
6. **无新增诊断**：同名文件是历史数据的一部分；本次不改写用户文件、不删除、不自动启用。需要用户处理时仍通过设置页的停用/删除入口。

## 状态所有者

- **停用事实（唯一所有者）**：`<storage>/v2/agents-state.json` 的 `disabledAgentIds`；由 `SubagentsService.setEnabled` 写入。
- **名称优先级（唯一所有者）**：`packages/services/src/subagents/subagentsService.ts` 的 `applyRuntimePrecedence`。它接收停用集合并决定同名保留谁；组件与编排选择器不复制该判定。
- **启用态投影（唯一所有者）**：同一文件的 `attachEnabledState`。`applyRuntimePrecedence` 只决定同名胜者，最终 `enabled` 仍由它统一计算。
- **编排可用性**：`packages/ui/src/v4/composer/orchestrationTeamModel.ts` 的 `buildOrchestrationRoleViews` 只读 `AgentSummary.enabled`，不自行推导停用原因。

```text
agents-state.json(disabledAgentIds) ─┐
内置 / 用户 / 项目 / 插件 profile ───┼─ applyRuntimePrecedence（停用用户项让位）
                                     └─ attachEnabledState → AgentSummary[]
                                            ├─ 设置页列表
                                            └─ 编排团队选择器（available）
```

## 接口

无协议改动；内部函数签名明确接收停用集合：

```ts
function applyRuntimePrecedence(
  agents: readonly AgentSummary[],
  disabledAgentIds: ReadonlySet<string>,
): AgentSummary[];
```

- 判定与 `attachEnabledState` 使用同一条件：`scope === "user" && disabledAgentIds.has(id)`。
- `settingsUserOnly` 路径不调用该函数，保持用户页完整展示。

## 验收场景

1. 用户目录存在停用的 `ui-designer.md`，项目未覆盖 → `list({ mode: "allRuntimeScopes" })` 中 `ui-designer` 是内置角色、`enabled: true`；编排团队不再显示「不可用」。
2. 同一份文件改为启用 → 用户 profile 按既有优先级覆盖内置 `ui-designer`，列表显示自定义描述/颜色。
3. 没有同名冲突的停用 `custom-helper.md` → 仍出现在列表中，`enabled: false`，设置页可重新启用。
4. 项目级同名文件（未被停用）→ 继续覆盖内置角色，行为不变。
5. 停用的用户 profile 与同名**已启用用户 profile** 同时存在 → 保留已启用的那份，不因排序后出现的停用项丢失角色。
6. `settingsUserOnly` → 内置组与用户组都完整，停用项可见；不受优先级规则影响。
7. 运行期与目录一致：编排计划派发 `ui-designer` 时使用的是内置 profile，选择器也显示可用。

## E2E / 测试锚点

- 正式测试：`packages/services/test/builtinSubagents.test.ts` 覆盖停用同名让位、无冲突停用项保留。
- 目录列表仍通过 `AgentsListResult.agents` 的 `source / scope / enabled` 断言；不新增 RPC 或调试端点。

## 已知限制

- 同名优先级仍按文件发现顺序（用户 → 项目 → 插件运行时别名）；本次只修正「停用项不该赢」这一条。
- 用户未启用的项目级同名覆盖无法通过 `disabledAgentIds` 关闭；那是项目内容的一部分，与运行时加载行为一致。
