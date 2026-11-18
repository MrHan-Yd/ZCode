import {
  BUILT_IN_SUBAGENT_DEFINITIONS,
  ORCHESTRATION_MAX_TEAM_SIZE,
  ORCHESTRATION_SOFT_TEAM_SIZE,
  normalizeOrchestrationTeamSelection,
  type AgentSummary,
  type BuiltInSubagentDefinition,
} from "@zcode/shared";

/**
 * 编排团队选择器的纯模型。
 *
 * 组件只负责渲染；预设、搜索、上限与“不可移除 general-purpose”都在这里固定成纯函数，
 * 便于直接测试。真正的权威校验仍在 CLI（`resolveOrchestrationTeam`）。
 */

export type OrchestrationTeamPresetId = "recommended" | "full-stack" | "solo";

export interface OrchestrationTeamPreset {
  id: OrchestrationTeamPresetId;
  labelKey: string;
  descriptionKey: string;
  roles: readonly string[];
}

export const ORCHESTRATION_TEAM_PRESETS: readonly OrchestrationTeamPreset[] = [
  {
    id: "recommended",
    labelKey: "chat.orchestration.preset.recommended",
    descriptionKey: "chat.orchestration.preset.recommended.description",
    roles: ["general-purpose", "Explore", "tester"],
  },
  {
    id: "full-stack",
    labelKey: "chat.orchestration.preset.fullStack",
    descriptionKey: "chat.orchestration.preset.fullStack.description",
    roles: ["general-purpose", "architect", "ui-designer", "frontend", "backend", "tester"],
  },
  {
    id: "solo",
    labelKey: "chat.orchestration.preset.solo",
    descriptionKey: "chat.orchestration.preset.solo.description",
    roles: ["general-purpose", "tester"],
  },
];

export interface OrchestrationRoleView {
  name: string;
  description: string;
  tags: readonly string[];
  canWrite: boolean;
  available: boolean;
  /** 设置页按角色覆盖的模型；缺席即“继承默认”。 */
  modelSelection?: AgentSummary["modelSelectionOverride"];
}

export type OrchestrationTeamToggleReason =
  | "locked"
  | "hard_limit"
  | "unavailable"
  | "at_least_one_writable";

export interface OrchestrationTeamToggleResult {
  team: string[];
  reason?: OrchestrationTeamToggleReason;
}

export function buildOrchestrationRoleViews(
  agents: readonly AgentSummary[],
): OrchestrationRoleView[] {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  return BUILT_IN_SUBAGENT_DEFINITIONS.map((definition) => {
    const agent = byName.get(definition.name);
    return {
      name: definition.name,
      description: definition.description,
      tags: [...definition.tags],
      canWrite: definition.canWrite,
      // 目录尚未加载时不要把选择器整体判成不可用；只有明确停用的角色才标记不可用。
      available: agents.length === 0 ? true : agent?.enabled !== false,
      ...(agent?.modelSelectionOverride ? { modelSelection: agent.modelSelectionOverride } : {}),
    };
  });
}

export function findOrchestrationRole(
  roles: readonly OrchestrationRoleView[],
  name: string,
): OrchestrationRoleView | undefined {
  return roles.find((role) => role.name === name);
}

export function filterOrchestrationRoles(
  roles: readonly OrchestrationRoleView[],
  query: string,
): OrchestrationRoleView[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...roles];
  return roles.filter((role) =>
    [role.name, role.description, ...role.tags].some((value) =>
      value.toLowerCase().includes(normalized),
    ),
  );
}

export function toggleOrchestrationRole(
  team: readonly string[],
  role: string,
  roles: readonly OrchestrationRoleView[],
): OrchestrationTeamToggleResult {
  const normalized = normalizeOrchestrationTeamSelection(team);
  const view = findOrchestrationRole(roles, role);
  if (!view) return { team: normalized };
  if (!view.available) return { team: normalized, reason: "unavailable" };
  if (normalized.includes(role)) {
    // general-purpose 是执行兜底；允许移除会让所有实现步骤在计划校验阶段被拒。
    if (role === "general-purpose") return { team: normalized, reason: "locked" };
    if (isLastWritableRole(normalized, roles, role)) {
      return { team: normalized, reason: "at_least_one_writable" };
    }
    return { team: normalized.filter((name) => name !== role) };
  }
  if (normalized.length >= ORCHESTRATION_MAX_TEAM_SIZE) {
    return { team: normalized, reason: "hard_limit" };
  }
  return { team: normalizeOrchestrationTeamSelection([...normalized, role]) };
}

export function applyOrchestrationPreset(
  preset: OrchestrationTeamPreset,
  roles: readonly OrchestrationRoleView[],
): string[] {
  // 角色目录尚未加载时不把预设过滤成只剩 general-purpose：定义来自 shared，可直接使用。
  if (roles.length === 0) return normalizeOrchestrationTeamSelection(preset.roles);
  const available = new Set(roles.filter((role) => role.available).map((role) => role.name));
  return normalizeOrchestrationTeamSelection(
    preset.roles.filter((role) => role === "general-purpose" || available.has(role)),
  );
}

export function matchOrchestrationPreset(
  team: readonly string[],
): OrchestrationTeamPresetId | null {
  const normalized = normalizeOrchestrationTeamSelection(team).slice().sort();
  for (const preset of ORCHESTRATION_TEAM_PRESETS) {
    const presetTeam = normalizeOrchestrationTeamSelection(preset.roles).slice().sort();
    if (
      presetTeam.length === normalized.length &&
      presetTeam.every((role, index) => role === normalized[index])
    ) {
      return preset.id;
    }
  }
  return null;
}

export function orchestrationTeamSizeNotice(team: readonly string[]): "soft" | "hard" | null {
  const size = normalizeOrchestrationTeamSelection(team).length;
  if (size >= ORCHESTRATION_MAX_TEAM_SIZE) return "hard";
  if (size > ORCHESTRATION_SOFT_TEAM_SIZE) return "soft";
  return null;
}

export function describeOrchestrationRoleModel(role: OrchestrationRoleView): {
  kind: "inherit" | "model";
  modelId?: string;
} {
  const modelId = role.modelSelection?.modelId?.trim();
  return modelId ? { kind: "model", modelId } : { kind: "inherit" };
}

export function getWritableRoleNames(roles: readonly OrchestrationRoleView[]): string[] {
  return roles.filter((role) => role.canWrite).map((role) => role.name);
}

function isLastWritableRole(
  team: readonly string[],
  roles: readonly OrchestrationRoleView[],
  removing: string,
): boolean {
  const writable = new Set(roles.filter((role) => role.canWrite).map((role) => role.name));
  const remainingWritable = team.filter((role) => role !== removing && writable.has(role));
  return remainingWritable.length === 0;
}

/** 供选择器渲染的目录版本；避免组件直接依赖 shared 常量。 */
export function getOrchestrationTeamLimits(): { soft: number; hard: number } {
  return { soft: ORCHESTRATION_SOFT_TEAM_SIZE, hard: ORCHESTRATION_MAX_TEAM_SIZE };
}

export type { BuiltInSubagentDefinition };
