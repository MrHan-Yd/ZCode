import {
  BUILT_IN_SUBAGENT_DEFINITIONS,
  GENERIC_SUBAGENT_NAMES,
  ORCHESTRATION_DEFAULT_TEAM,
  ORCHESTRATION_MAX_TEAM_SIZE,
  ORCHESTRATION_SOFT_TEAM_SIZE,
  normalizeOrchestrationTeamSelection,
  type AgentSummary,
  type BuiltInSubagentDefinition,
} from "@zcode/shared";

/**
 * 编排团队选择器的纯模型。
 *
 * 组件只负责渲染；预设、搜索、专业上限与通用角色默认保留都在这里固定成纯函数，
 * 便于直接测试。真正的权威校验仍在 CLI（`resolveOrchestrationTeam`）。
 */

export type OrchestrationTeamPresetId = "full-stack" | "solo";

export interface OrchestrationTeamPreset {
  id: OrchestrationTeamPresetId;
  labelKey: string;
  descriptionKey: string;
  roles: readonly string[];
}

const genericRoleNames = new Set<string>(GENERIC_SUBAGENT_NAMES);
const specialistDefinitions = BUILT_IN_SUBAGENT_DEFINITIONS.filter(
  (definition) => !genericRoleNames.has(definition.name),
);

export const ORCHESTRATION_TEAM_PRESETS: readonly OrchestrationTeamPreset[] = [
  {
    id: "full-stack",
    labelKey: "chat.orchestration.preset.fullStack",
    descriptionKey: "chat.orchestration.preset.fullStack.description",
    roles: specialistDefinitions.map((definition) => definition.name),
  },
  {
    id: "solo",
    labelKey: "chat.orchestration.preset.solo",
    descriptionKey: "chat.orchestration.preset.solo.description",
    roles: ORCHESTRATION_DEFAULT_TEAM.filter((name) => !genericRoleNames.has(name)),
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

export type OrchestrationTeamToggleReason = "locked" | "hard_limit" | "unavailable";

export interface OrchestrationTeamToggleResult {
  team: string[];
  reason?: OrchestrationTeamToggleReason;
}

export function buildOrchestrationRoleViews(
  agents: readonly AgentSummary[],
): OrchestrationRoleView[] {
  const byName = new Map(agents.map((agent) => [agent.name, agent]));
  return specialistDefinitions.map((definition) => {
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
  if (genericRoleNames.has(role)) return { team: normalized, reason: "locked" };
  const view = findOrchestrationRole(roles, role);
  if (!view) return { team: normalized };
  if (!view.available) return { team: normalized, reason: "unavailable" };
  if (normalized.includes(role)) {
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
  // 角色目录尚未加载时保留预设；通用子代理由共享归一化补齐，不参与可用专业筛选。
  if (roles.length === 0) return normalizeOrchestrationTeamSelection(preset.roles);
  const available = new Set(roles.filter((role) => role.available).map((role) => role.name));
  return normalizeOrchestrationTeamSelection(preset.roles.filter((role) => available.has(role)));
}

/** “全选”是否已覆盖当前全部可用专业角色；没有可判定角色时不视为已全选。 */
export function isOrchestrationSelectAllApplied(
  team: readonly string[],
  roles: readonly OrchestrationRoleView[],
): boolean {
  const available = roles.filter((role) => role.available);
  if (available.length === 0) return false;
  const selected = new Set(normalizeOrchestrationTeamSelection(team));
  return available.every((role) => selected.has(role.name));
}

/**
 * “全选”按钮的一次点击语义：已全选时清空专业角色，否则选择全部可用专业角色。
 *
 * 清空后只剩通用子代理，交由 SessionPane 按“开启必须有专业角色”关闭编排；
 * 搜索词不影响全选范围，不可用角色不会被选中。
 */
export function toggleOrchestrationSelectAll(
  team: readonly string[],
  roles: readonly OrchestrationRoleView[],
): string[] {
  if (isOrchestrationSelectAllApplied(team, roles)) return normalizeOrchestrationTeamSelection([]);
  const fullStack = ORCHESTRATION_TEAM_PRESETS.find((preset) => preset.id === "full-stack")!;
  return applyOrchestrationPreset(fullStack, roles);
}

/**
 * 编排开启至少需要一个专业角色。
 *
 * 通用子代理始终随归一化进入团队，因此不能用 `team.length === 0` 判断“没选角色”；
 * 这里剔除通用角色，供开启、取消勾选与预设写入路径共用同一条判定。
 */
export function hasSelectedOrchestrationRole(team: readonly string[]): boolean {
  return normalizeOrchestrationTeamSelection(team).some((name) => !genericRoleNames.has(name));
}

export function resolveOrchestrationTeamOnEnable(
  team: readonly string[],
  roles: readonly OrchestrationRoleView[],
): string[] {
  const normalized = normalizeOrchestrationTeamSelection(team);
  // 通用子代理不代表专业选择；默认精简不能随按钮排序变成全栈，已有专业选择保持不变。
  if (hasSelectedOrchestrationRole(normalized)) return normalized;
  const solo = ORCHESTRATION_TEAM_PRESETS.find((preset) => preset.id === "solo")!;
  return applyOrchestrationPreset(solo, roles);
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

/** 面板人数只计算专业角色；协议中的通用子代理不占可选名额。 */
export function getOrchestrationTeamLimits(): { soft: number; hard: number } {
  return {
    soft: ORCHESTRATION_SOFT_TEAM_SIZE - GENERIC_SUBAGENT_NAMES.length,
    hard: ORCHESTRATION_MAX_TEAM_SIZE - GENERIC_SUBAGENT_NAMES.length,
  };
}

export type { BuiltInSubagentDefinition };
