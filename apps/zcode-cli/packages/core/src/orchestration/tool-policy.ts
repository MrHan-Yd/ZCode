import {
  BUILT_IN_SUBAGENT_DEFINITIONS,
  getBuiltInSubagentDefinition,
  ORCHESTRATION_DEFAULT_MAX_CONCURRENCY,
  ORCHESTRATION_DEFAULT_TEAM,
  ORCHESTRATION_MAX_CONCURRENCY,
  ORCHESTRATION_MAX_TEAM_SIZE,
  ORCHESTRATION_SOFT_TEAM_SIZE,
} from "@zcode/shared";
import { OrchestrationStoreError } from "./contract.js";

/**
 * 编排模式的工具边界。
 *
 * 三条约束必须同时成立，缺一就会退化：
 * 1. 主会话注册面只留规划/取消/提问/待办/只读检索；
 * 2. executor 对写工具与直接派发工具硬拒绝，不依赖「模型看不见就不会调」；
 * 3. 子代理运行时与恢复路径不得重新获得编排角色。
 */

export const CREATE_ORCHESTRATION_PLAN_TOOL_NAME = "CreateOrchestrationPlan";
export const AMEND_ORCHESTRATION_PLAN_TOOL_NAME = "AmendOrchestrationPlan";
export const CANCEL_ORCHESTRATION_RUN_TOOL_NAME = "CancelOrchestrationRun";

export const ORCHESTRATION_TOOL_NAMES = [
  CREATE_ORCHESTRATION_PLAN_TOOL_NAME,
  AMEND_ORCHESTRATION_PLAN_TOOL_NAME,
  CANCEL_ORCHESTRATION_RUN_TOOL_NAME,
] as const;

/**
 * 主会话可见的工具面。
 *
 * `Glob` / `Grep` 必须留在名单内：内建搜索分支只在 Bash 可用时接管搜索，
 * 而编排主会话恰好没有 Bash；allowlist 缺了它们会让主会话既不能改文件也不能查文件。
 */
export const ORCHESTRATOR_ALLOWED_TOOL_NAMES: readonly string[] = [
  ...ORCHESTRATION_TOOL_NAMES,
  "AskUserQuestion",
  "TodoRead",
  "TodoWrite",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
];

/**
 * executor 的硬拒绝集合。
 *
 * `Edit` / `Write` / `Bash` 是 spec 明写的执行边界；`Agent` / `Task` / `js` 同样必须在列：
 * 留着任何一个都等于给主会话开一条绕过 DAG 的派发或命令通道。
 */
export const ORCHESTRATOR_HARD_DENIED_TOOL_NAMES: readonly string[] = [
  "Edit",
  "Write",
  "Bash",
  "Agent",
  "Task",
  "js",
];

export {
  ORCHESTRATION_DEFAULT_MAX_CONCURRENCY,
  ORCHESTRATION_DEFAULT_TEAM,
  ORCHESTRATION_MAX_CONCURRENCY,
  ORCHESTRATION_MAX_TEAM_SIZE,
  ORCHESTRATION_SOFT_TEAM_SIZE,
};
/** 兼容既有调用方与测试；语义与共享常量一致。 */
export const DEFAULT_ORCHESTRATION_TEAM = ORCHESTRATION_DEFAULT_TEAM;

/** 只有主会话可以承担编排角色；child / workflow actor 一律视为 default。 */
export function isOrchestratorRuntimeConfig(config: {
  orchestration?: { enabled?: boolean } | undefined;
  taskType?: string | undefined;
}): boolean {
  return config.orchestration?.enabled === true && config.taskType !== "subagent_child";
}

export function isOrchestrationHardDeniedTool(toolName: string): boolean {
  return ORCHESTRATOR_HARD_DENIED_TOOL_NAMES.includes(toolName);
}

/**
 * provider 请求边界需要隐藏的工具名。
 *
 * registry 必须保持完整：子代理的 `allowedTools: ["*"]` 会从父 runtime 的实际工具表继承，
 * 如果主会话注册面本身就只剩只读工具，DAG 子代理会连 Edit/Write/Bash 都拿不到。
 * 因此「主会话不可见」由 turn 级过滤实现，执行边界由 executor 白名单独立兜底。
 */
export function resolveOrchestratorHiddenToolNames(
  registeredToolNames: readonly string[],
  config: { orchestration?: { enabled?: boolean } | undefined; taskType?: string | undefined },
): readonly string[] | undefined {
  if (!isOrchestratorRuntimeConfig(config)) return undefined;
  const allowed = new Set(ORCHESTRATOR_ALLOWED_TOOL_NAMES);
  return registeredToolNames.filter((name) => !allowed.has(name));
}

/**
 * Plan + 编排 = 只读编排。父会话处于 plan（或 planEnabled）时，DAG 子代理也必须走 plan，
 * 不能被 profile 自带的 `permissionMode: "auto"` 提升成可写执行者。
 */
export function shouldForceOrchestrationReadOnly(input: {
  orchestrationEnabled: boolean;
  planEnabled: boolean;
  parentMode: string | undefined;
}): boolean {
  return input.orchestrationEnabled && (input.planEnabled || input.parentMode === "plan");
}

/**
 * 归一化团队。`general-purpose` 强制保留是 spec 的执行兜底：没有至少一个可写执行角色，
 * 所有实现步骤都会在计划校验阶段被拒，用户只会看到一份永远跑不起来的计划。
 */
export function resolveOrchestrationTeam(team: readonly string[] | undefined): string[] {
  const candidate = team === undefined || team.length === 0 ? DEFAULT_ORCHESTRATION_TEAM : team;
  if (candidate.length > ORCHESTRATION_MAX_TEAM_SIZE) {
    throw new OrchestrationStoreError(
      "invalid_plan",
      `Orchestration team exceeds the hard limit of ${ORCHESTRATION_MAX_TEAM_SIZE} roles.`,
    );
  }
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const role of candidate) {
    const name = typeof role === "string" ? role.trim() : "";
    if (!name) {
      throw new OrchestrationStoreError(
        "invalid_plan",
        "Orchestration team contains an empty role.",
      );
    }
    if (seen.has(name)) {
      throw new OrchestrationStoreError(
        "invalid_plan",
        `Orchestration team lists role ${name} more than once.`,
      );
    }
    if (!getBuiltInSubagentDefinition(name)) {
      throw new OrchestrationStoreError(
        "invalid_plan",
        `Orchestration team role ${name} is not a built-in subagent.`,
      );
    }
    seen.add(name);
    resolved.push(name);
  }
  if (!seen.has("general-purpose")) {
    throw new OrchestrationStoreError(
      "invalid_plan",
      "Orchestration team must keep general-purpose as the execution fallback.",
    );
  }
  return resolved;
}

/** 可写角色由内置元数据推导，避免设置页与计划校验各自维护一份名单。 */
export function resolveOrchestrationWritableRoles(team: readonly string[]): string[] {
  const members = new Set(team);
  return BUILT_IN_SUBAGENT_DEFINITIONS.filter(
    (definition) => members.has(definition.name) && definition.canWrite,
  ).map((definition) => definition.name);
}

export function resolveOrchestrationMaxConcurrency(value: number | undefined): number {
  if (value === undefined) return ORCHESTRATION_DEFAULT_MAX_CONCURRENCY;
  if (!Number.isSafeInteger(value) || value < 1 || value > ORCHESTRATION_MAX_CONCURRENCY) {
    throw new OrchestrationStoreError(
      "invalid_plan",
      `Orchestration maxConcurrency must be an integer between 1 and ${ORCHESTRATION_MAX_CONCURRENCY}.`,
    );
  }
  return value;
}

/**
 * 从配置里取团队用于 system prompt 展示。这里不抛错：prompt 装配失败不应让整个会话起不来，
 * 非法团队会在实际创建 run 时由 `resolveOrchestrationTeam` 明确拒绝。
 */
export function resolveOrchestrationTeamForPrompt(
  team: readonly string[] | undefined,
): readonly string[] {
  try {
    return resolveOrchestrationTeam(team);
  } catch {
    return DEFAULT_ORCHESTRATION_TEAM;
  }
}
