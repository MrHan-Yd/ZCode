# 子智能体颜色标记调色板

## 背景

设置页「子智能体」表单有一组「颜色标记」单选项，用于给子智能体一个身份色：它在子智能体表格行（`AgentColorDot`）和工具调用里的 agent 区块（`agent.tsx`）中显示。原调色板只有 8 个颜色（`yellow/red/orange/green/cyan/blue/purple/pink`），可选空间偏小。本次先把可选颜色扩展到 12 个，再补 4 个深色档到 16 个。

颜色值本身只存在于两处契约：`AgentColor` 联合类型和 `agents/*.md` frontmatter 的 `color` 字段。没有新增协议、没有新增持久化文件。

调色板扩容之后，新建表单里仍然看不出「哪些颜色已经有人用了」，容易给新子智能体挑到重复身份色。因此给色板加一层纯前端的占用提示：数据全部来自当前分区已经加载的 agent 列表，不新增请求、不新增存储。

## 产品规则

1. 调色板共 16 个颜色，单行展示，按色环顺序排列：
   - **浅色档 12 个**：`yellow/orange/red/pink/fuchsia/purple/indigo/blue/cyan/teal/green/lime`，Tailwind `-300` 底色，深色主题下用 `-400/32` 淡色。
   - **深色档 4 个**：`deepRed/deepGreen/deepBlue/deepPurple`，是浅色档里相隔最远的四个色相（red / green / blue / purple）的实色 `-600` 版本，紧跟在同色相的浅色档之后（`red` 后是 `deepRed`，`purple` 后是 `deepPurple`……）。
   - 为什么不是再挑 4 个新色相：Tailwind 剩下的色相（`red/yellow/green/blue/purple` 的 `-300`）与现有浅色档几乎同色（`red-300` 与 `rose-300`、`green-300` 与 `emerald-300` 肉眼难分），加了等于重复。改档位才能既扩数量又保持可区分。
   - 深色档在两个主题下都用实色 `-600`（不带 `dark:` 变体）：浅色档在深色主题下是 32% 的淡色，只有实色才能让两档在暗背景上仍然分得开。
2. 颜色只是**展示提示**，不影响运行时的权限、模型或工具范围。
3. 未设置 `color` 的 agent 仍按名称 hash 取色（`resolveSubagentColorFromName`）；调色板长度变化会让这类 agent 的兜底色改变，这是允许的（它们没有显式身份色）。
4. `agents/*.md` frontmatter 里写的 `color` 只有落在 16 个合法值内才被采纳，其余值按「未设置」处理（保持既有的 `normalizeEnum` 语义）。
5. **占用提示**：调色板会把「已被自建子智能体使用」的颜色标出来（色块右上角一个小圆点），方便新建时优先选还没人用的颜色。标记的含义写在「颜色标记」标签右侧的小感叹号图标里，鼠标悬停或键盘聚焦时以 Tooltip 展示；色板下方不占用常驻文案。
   - 只有**自建**子智能体（`scope` 为 `user`/`workspace`、`source` 为 `user`、非只读）参与统计；内置（general-purpose / Explore）与插件子智能体即使有颜色也不统计、不标记。
   - 每个自建子智能体的占用色取**实际显示色**：显式 `color` 优先，未设置时按名称 hash 兜底（与列表行、工具调用区块一致）。
   - 统计范围是**当前分区**（用户页只算用户级，项目页只算该项目的工作区级），与页面上可见的列表口径一致；搜索关键字不影响标记。
   - 提示**不构成任何选择限制**：已占用的颜色仍可选中、可重复，保存行为不变。

## 状态所有者

- **可选颜色集合与类名映射**：`packages/ui/src/lib/subagentColors.ts`（`SUBAGENT_COLORS`、`SUBAGENT_COLOR_CLASS`、`SUBAGENT_TEXT_COLOR_CLASS`）是 UI 侧唯一来源；`SubagentsSection.tsx` 只读不另建列表。
- **颜色占用统计**：`packages/ui/src/lib/subagentColorUsage.ts`（`isSelfCreatedSubagent`、`resolveSubagentDisplayColor`、`countSubagentColorUsage`）。它是纯函数，输入 `AgentSummary` 列表、输出「颜色 → 数量」，不持有状态、不发起 RPC；`SubagentsSection.tsx` 用 `matchesActiveScope` 过滤出当前分区可见的 agent 后调用它。该文件同时是「自建子智能体」判定的唯一来源（列表行的可编辑判定也用它）。
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

外加 i18n 无障碍标签 `settings.subagents.color.<name>`（zh-CN / en-US）。占用提示另加两个 key：`settings.subagents.color.usedOption`（色块的无障碍标签与原生 `title`，含 `{color}` 与 `{count}` 占位符）、`settings.subagents.form.color.usedHint`（标签右侧感叹号图标的 Tooltip 文案，同时作为该按钮的 `aria-label`）。

## 验收场景

1. 打开「新建子智能体」→「颜色标记」出现 16 个圆点，单行排列，选中态高亮块与选中圆点重合；`red`/`deepRed`、`purple`/`deepPurple`、`blue`/`deepBlue`、`green`/`deepGreen` 四对相邻且深浅可辨。
2. 任选一个新颜色（如 teal）保存 → 子智能体列表该行的圆点颜色与选择一致。
3. 重新打开编辑页 → 选中态停在新颜色上。
4. 手动把 md frontmatter 的 `color` 改成未知值（如 `magenta`）→ 该 agent 按「未设置」处理，不报错、不消失。
5. 内置 agent（general-purpose / Explore）颜色保持不变（`blue` / `cyan`）。
6. 已有一个自建子智能体用红色（`red`）→ 打开新建表单，红色色块右上角出现圆点，「颜色标记」标签右侧出现小感叹号图标；悬停该图标显示「带圆点的颜色已被自建子智能体使用」，悬停红色色块显示「红色（已被 1 个自建子智能体使用）」。
7. 同一分区内两个自建子智能体都用红色 → 该色块仍只显示一个圆点，悬停文案的数量变为 2。
8. 只有内置（general-purpose / Explore）或插件子智能体用过某颜色（如 blue / cyan）→ 该色块**不**出现圆点，标签右侧也不出现感叹号图标。
9. 选中已被占用的颜色并保存 → 正常保存，不报错、不拦截（提示不构成限制）。
10. 在搜索框输入关键字过滤列表 → 色板标记不变（统计不受关键字影响）。
11. 切到某个项目分区 → 标记按该项目的自建子智能体重新统计，与用户分区的结果互不影响。

## 已知限制

- 颜色只是展示提示，不参与任何运行时决策。
- 名称 hash 兜底色会随调色板长度变化；未显式设置颜色的 agent 兜底色可能改变。
- 占用统计只覆盖设置页当前分区能列出的自建子智能体（用户级或当前工作区）。用户级与工作区级各自的同名颜色互不感知，这是「按分区看」的固有取舍。
- 颜色是否「占用」按显示色计算，因此一个没有显式 `color` 的 agent 也会占用它按名称 hash 得到的颜色；列表行不显示该兜底色，用户可能只从悬停文案看到数量。
