# 内置 bug 修复子智能体

## 背景

编排模式下计划步骤只能使用**当前团队里的角色**（`CreateOrchestrationPlan` 的校验与 CLI `resolveOrchestrationTeam` 都以冻结团队为准）。默认团队是 `general-purpose / Explore / reviewer`，内置目录里的专业角色只有 architect、frontend、backend、ui-designer、tester、reviewer：

- `reviewer` 是只读审阅角色，不能改代码；
- `tester` 写测试，但不以修复产品缺陷为目标；
- frontend / backend 是技术栈实现角色，不表达「复现 → 根因 → 最小修复 → 回归」这条修复链路；
- 因此「修复复核发现」这类步骤只能落到可写的 `general-purpose`。

本次新增内置专业角色 `bug-fixer`，让编排计划有一个语义明确、可写的修复执行者。只新增目录角色与团队入口，不新增协议、RPC、持久化或第二份运行状态。

## 产品规则

1. **稳定身份**：角色名 `bug-fixer` 是写进团队配置、编排计划与历史记录中的稳定 id，后续不改名。它是专业角色（不是通用角色），可被团队选择器勾选/取消。
2. **目录定义**（`packages/shared/src/builtin-subagents.ts`）：

   | 字段           | 值                                                                                                                   |
   | -------------- | -------------------------------------------------------------------------------------------------------------------- |
   | name           | `bug-fixer`                                                                                                          |
   | description    | Bug-fix agent for reproducing failures, finding root causes, applying minimal fixes, and adding regression coverage. |
   | color          | `yellow`（身份色；与运行态 warning 色互不替代，状态仍由状态词/状态色表达）                                           |
   | canWrite       | `true`                                                                                                               |
   | tools          | `["*"]`                                                                                                              |
   | maxTurns       | `40`                                                                                                                 |
   | injectAgentsMd | `true`                                                                                                               |
   | tags           | `Bug` / `修复` / `根因` / `回归`                                                                                     |

   `agentDescription`（Agent 工具暴露给模型的描述）必须写明「用于回归、失败测试、运行时错误和需要改代码的复核发现；先复现再修」，让模型在团队内优先选它，而不是退回避通用的 general-purpose。

3. **系统提示词**（`apps/zcode-cli/packages/core/src/subagent/bug-fixer.ts` + `builtin-agents.ts`）固定修复纪律：
   1. 先复现：用最窄的失败命令、测试或代码路径确认问题；无法复现时说明缺什么证据，不猜。
   2. 根因定位：指到真正拥有该行为的层；区分已确认原因与待验证假设，并引用代码/日志/测试作为证据。
   3. 最小修复：在所有者处修，不加并行 helper，不用超时/重试分支掩盖同步问题，不碰无关本地改动。
   4. 回归覆盖：补最小的、修复前失败修复后通过的测试；不改产品代码迁就断言，不跳过用例。
   5. 验证：跑相关测试与覆盖该改动的仓库门禁（typecheck / lint / architecture），如实报告包含既有基线的结果。
   6. 行为变化先更新对应 spec；需要产品决策时列出选项，不擅自扩大范围。
   7. 最终回复列出根因、改动文件、回归测试、执行的命令与残留风险。

4. **默认团队**：`ORCHESTRATION_DEFAULT_TEAM` 变为 `general-purpose, Explore, bug-fixer, reviewer`。这样默认团队开箱即可修 bug，而不是只能落到通用角色；`reviewer` 仍排在最后，作为修复后的审阅。
   - `solo` 预设随之变为 `bug-fixer, reviewer`。
   - 已保存的旧团队不被改写；它们仍合法，用户可通过选择器或预设主动加入 `bug-fixer`。

5. **团队硬上限 8 → 9**：`full-stack` 预设 = 2 个通用角色 + 全部 7 个专业角色 = 9。若不抬高上限，归一化会静默截断最后一个专业角色（即新角色），使「全选」名不副实。软上限保持 6（即 4 个专业角色）不变；恰好 9 个角色仍给出与原先一致的 hard 提示。
6. **展示与配置自动派生**：设置页内置角色列表、团队选择器、身份色、Agent 工具描述都从 `BUILT_IN_SUBAGENT_DEFINITIONS` 派生，不新增角色专用分支或 i18n 文案。颜色只用于身份展示，不影响权限、模型或工具范围。
7. **不改变经典模式默认可见角色**：经典模式仍只暴露 `general-purpose` 与 `Explore`；`bug-fixer` 只在编排团队或显式 `visibleNames` 中出现。

## 状态所有者

- **角色目录（唯一所有者）**：`packages/shared/src/builtin-subagents.ts` 的 `BUILT_IN_SUBAGENT_DEFINITIONS`；角色名同时登记在 `packages/shared/src/subagents-types.ts` 的 `BUILT_IN_SUBAGENT_NAMES`。services / CLI / UI 不维护第二份名单。
- **提示词（唯一所有者）**：`apps/zcode-cli/packages/core/src/subagent/bug-fixer.ts` 的 `buildBugFixerSystemPrompt`，由 `builtin-agents.ts` 的 `BUILT_IN_AGENT_PROMPTS` 消费。
- **团队默认与上限（唯一所有者）**：`packages/shared/src/orchestration.ts` 的 `ORCHESTRATION_DEFAULT_TEAM` / `ORCHESTRATION_MAX_TEAM_SIZE`；UI preset 与 CLI 校验都读这一份。
- **运行态**：角色只是普通内置 profile；子智能体启动、停止、状态与产物沿用既有 runtime task registry 与投影，不因新角色产生第二份状态。

## 接口

无协议改动。新增/修改的公开面：

```ts
// packages/shared/src/subagents-types.ts
export const BUILT_IN_SUBAGENT_NAMES = [..., "bug-fixer"] as const;

// packages/shared/src/builtin-subagents.ts
// 新增 BuiltInSubagentDefinition 条目（见规则 2）

// packages/shared/src/orchestration.ts
export const ORCHESTRATION_DEFAULT_TEAM = [
  ...GENERIC_SUBAGENT_NAMES,
  "bug-fixer",
  "reviewer",
];
export const ORCHESTRATION_MAX_TEAM_SIZE = 9;

// apps/zcode-cli/packages/core/src/subagent/bug-fixer.ts
export function buildBugFixerSystemPrompt(): string;
```

## 验收场景

1. **默认团队**：新建编排会话（未显式保存团队）→ 编排系统提示的 team 行包含 `bug-fixer`；「修复…」类步骤可以选择它，计划校验通过。
2. **solo 预设**：点击精简预设 → 生效团队为 `general-purpose, Explore, bug-fixer, reviewer`。
3. **full-stack 预设**：「全选」→ 9 个角色（2 通用 + 7 专业），`bug-fixer` 在列；不因硬上限被截断；hard 提示与改动前恰好满员时的行为一致。
4. **设置页**：内置分组出现 `bug-fixer`，描述/颜色/标签来自目录；可单独配置模型覆盖。
5. **身份色**：`bug-fixer` 在设置列表、Agent 工具行、状态面板身份文字、编排步骤角色中使用同一 `yellow` 身份色；运行中/失败等状态色不参与身份取色。
6. **只读边界**：`reviewer` / `architect` / `ui-designer` 仍不可写；`bug-fixer` 可写，写步骤必须声明 `writeScope`（既有校验）。
7. **经典模式不回归**：未开启编排时 `bug-fixer` 不出现在可见角色里；Agent 工具描述仍只列 general-purpose / Explore。
8. **旧团队兼容**：已保存的 8 人以内团队仍被接受，不被自动改写；用户重新选择预设后才出现 `bug-fixer`。
9. **恢复与历史**：已结束会话里的 `general-purpose` 修复步骤保持原样，不回溯改写角色名；新角色不影响旧计划回放。

## 验证入口

- `packages/shared/src/builtin-subagents.test.ts`、`orchestration-team.test.ts`：目录一一对应、默认团队与 9 人上限归一化。
- `packages/ui/src/v4/composer/orchestrationTeamModel.test.ts`：专业角色列表、全栈/精简预设、上限提示。
- `packages/ui/test/builtinSubagents.test.ts`、`subagentIdentityColors.test.ts`：调色板内颜色、标签与身份色。
- `apps/zcode-cli/packages/core/test/builtinAgentProfiles.test.ts`：9 个内置 profile、可写工具面与模型覆盖。
- 交互回归复用编排团队选择器/状态面板现有浏览器场景；不新增临时脚本。
- 执行 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，如实报告结果。

## 已知限制

- 计划角色仍由主模型选择；新增角色提高「有正确角色可选」的概率，但不强制任何步骤必须使用 `bug-fixer`。
- 新桌面端连接旧远端 CLI 时，旧 CLI 仍按 8 人上限校验团队；`full-stack`（9 人）会被告知超限，默认/精简团队（≤4 人）不受影响。
- 角色名与描述是模型可见的英文标识/文案，不本地化；本地化只覆盖设置页与状态面板的既有通用标签。
