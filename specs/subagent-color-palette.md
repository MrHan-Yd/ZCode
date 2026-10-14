# 子智能体颜色标记调色板

## 背景

设置页「子智能体」表单有一组「颜色标记」单选项，用于给子智能体一个身份色：它在子智能体表格行（`AgentColorDot`）和工具调用里的 agent 区块（`agent.tsx`）中显示。原调色板只有 8 个颜色（`yellow/red/orange/green/cyan/blue/purple/pink`），可选空间偏小。本次把可选颜色扩展到 12 个。

颜色值本身只存在于两处契约：`AgentColor` 联合类型和 `agents/*.md` frontmatter 的 `color` 字段。没有新增协议、没有新增持久化文件。

## 产品规则

1. 调色板扩到 12 个颜色：`yellow/orange/red/pink/fuchsia/purple/indigo/blue/cyan/teal/green/lime`，按色环顺序排列，单行展示。
2. 颜色只是**展示提示**，不影响运行时的权限、模型或工具范围。
3. 未设置 `color` 的 agent 仍按名称 hash 取色（`resolveSubagentColorFromName`）；调色板长度变化会让这类 agent 的兜底色改变，这是允许的（它们没有显式身份色）。
4. `agents/*.md` frontmatter 里写的 `color` 只有落在 12 个合法值内才被采纳，其余值按「未设置」处理（保持既有的 `normalizeEnum` 语义）。

## 状态所有者

- **可选颜色集合与类名映射**：`packages/ui/src/lib/subagentColors.ts`（`SUBAGENT_COLORS`、`SUBAGENT_COLOR_CLASS`、`SUBAGENT_TEXT_COLOR_CLASS`）是 UI 侧唯一来源；`SubagentsSection.tsx` 只读不另建列表。
- **合法值校验**：Settings 读文件走 `packages/services/src/subagents/subagentMarkdown.ts` 的 `VALID_COLORS`；CLI 运行时读同一批文件走 `apps/zcode-cli/packages/core/src/subagent/profile.ts` 的 `VALID_COLORS`。两处都是只读校验，不持有状态。
- **类型契约**：`AgentColor` 定义在 `packages/shared/src/subagents-types.ts`，是唯一权威类型，其余三处（services 校验、ui 映射、cli 联合类型）必须与它保持一致。

## 接口

无 RPC/协议改动。四个必须同步修改的点：

| 位置                                                       | 作用                     |
| ---------------------------------------------------------- | ------------------------ |
| `packages/shared/src/subagents-types.ts` `AgentColor`      | 权威联合类型             |
| `packages/services/src/subagents/subagentMarkdown.ts`      | Settings 侧 frontmatter 校验 |
| `packages/ui/src/lib/subagentColors.ts`                    | UI 顺序与 Tailwind 类名   |
| `apps/zcode-cli/packages/core/src/subagent/profile.ts`     | CLI 运行时 frontmatter 校验 |

外加 i18n 无障碍标签 `settings.subagents.color.<name>`（zh-CN / en-US）。

## 验收场景

1. 打开「新建子智能体」→「颜色标记」出现 12 个圆点，单行排列，选中态高亮块与选中圆点重合。
2. 任选一个新颜色（如 teal）保存 → 子智能体列表该行的圆点颜色与选择一致。
3. 重新打开编辑页 → 选中态停在新颜色上。
4. 手动把 md frontmatter 的 `color` 改成未知值（如 `magenta`）→ 该 agent 按「未设置」处理，不报错、不消失。
5. 内置 agent（general-purpose / Explore）颜色保持不变（`blue` / `cyan`）。

## 已知限制

- 颜色只是展示提示，不参与任何运行时决策。
- 名称 hash 兜底色会随调色板长度变化；未显式设置颜色的 agent 兜底色可能改变。
