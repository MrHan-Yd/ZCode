import {
  BUILT_IN_SUBAGENT_DEFINITIONS,
  createAgentStateId,
  type AgentColor,
  type AgentSummary,
  type ZCodeProvider,
} from "@zcode/shared";

// 按色环顺序排列，让单行色板呈现连续的暖→冷→暖过渡。
// 四个深色档紧跟在同色相的浅色档后面（red/deepRed、purple/deepPurple…），
// 既保持色环单调，也让「同色相、两种深浅」在单行里相邻可比。
export const SUBAGENT_COLORS: AgentColor[] = [
  "yellow",
  "orange",
  "red",
  "deepRed",
  "pink",
  "fuchsia",
  "purple",
  "deepPurple",
  "indigo",
  "blue",
  "deepBlue",
  "cyan",
  "teal",
  "green",
  "deepGreen",
  "lime",
];

export const SUBAGENT_COLOR_CLASS: Record<AgentColor, string> = {
  blue: "bg-sky-300 text-sky-900 dark:bg-sky-400/32 dark:text-sky-50",
  // 深色档在两个主题下都用实色 -600：浅色档在深色主题里是 32% 的淡色，
  // 实色才能让「深浅两档」在暗色背景下也分得出来。
  deepBlue: "bg-sky-600 text-sky-50",
  deepGreen: "bg-emerald-600 text-emerald-50",
  deepPurple: "bg-violet-600 text-violet-50",
  deepRed: "bg-rose-600 text-rose-50",
  cyan: "bg-cyan-300 text-cyan-900 dark:bg-cyan-400/32 dark:text-cyan-50",
  fuchsia: "bg-fuchsia-300 text-fuchsia-900 dark:bg-fuchsia-400/32 dark:text-fuchsia-50",
  green: "bg-emerald-300 text-emerald-900 dark:bg-emerald-400/32 dark:text-emerald-50",
  indigo: "bg-indigo-300 text-indigo-900 dark:bg-indigo-400/32 dark:text-indigo-50",
  lime: "bg-lime-300 text-lime-900 dark:bg-lime-400/32 dark:text-lime-50",
  orange: "bg-orange-300 text-orange-900 dark:bg-orange-400/32 dark:text-orange-50",
  pink: "bg-pink-300 text-pink-900 dark:bg-pink-400/32 dark:text-pink-50",
  purple: "bg-violet-300 text-violet-900 dark:bg-violet-400/32 dark:text-violet-50",
  red: "bg-rose-300 text-rose-900 dark:bg-rose-400/32 dark:text-rose-50",
  teal: "bg-teal-300 text-teal-900 dark:bg-teal-400/32 dark:text-teal-50",
  yellow: "bg-amber-300 text-amber-900 dark:bg-amber-300/32 dark:text-amber-50",
};

export const SUBAGENT_TEXT_COLOR_CLASS: Record<AgentColor, string> = {
  blue: "text-sky-700 dark:text-sky-300",
  deepBlue: "text-sky-800 dark:text-sky-400",
  deepGreen: "text-emerald-800 dark:text-emerald-400",
  deepPurple: "text-violet-800 dark:text-violet-400",
  deepRed: "text-rose-800 dark:text-rose-400",
  cyan: "text-cyan-700 dark:text-cyan-300",
  fuchsia: "text-fuchsia-700 dark:text-fuchsia-300",
  green: "text-emerald-700 dark:text-emerald-300",
  indigo: "text-indigo-700 dark:text-indigo-300",
  lime: "text-lime-700 dark:text-lime-300",
  orange: "text-orange-700 dark:text-orange-300",
  pink: "text-pink-700 dark:text-pink-300",
  purple: "text-violet-700 dark:text-violet-300",
  red: "text-rose-700 dark:text-rose-300",
  teal: "text-teal-700 dark:text-teal-300",
  yellow: "text-amber-700 dark:text-amber-300",
};

// 身份点与身份文字必须使用同一主题色；选择器继续使用上面的弱 surface 色板。
export const SUBAGENT_DOT_COLOR_CLASS = Object.fromEntries(
  SUBAGENT_COLORS.map((color) => [color, `${SUBAGENT_TEXT_COLOR_CLASS[color]} bg-current`]),
) as Record<AgentColor, string>;

export type SubagentIdentityProfile = Pick<AgentSummary, "name" | "color" | "scope" | "source"> &
  Pick<Partial<AgentSummary>, "id">;

interface SubagentColorWorkspace {
  workspacePath: string;
  workspaceIdentity?: string | null;
  provider: ZCodeProvider;
}

interface SubagentColorContextSnapshot extends SubagentColorWorkspace {
  loaded: boolean;
  agents: readonly SubagentIdentityProfile[];
}

interface SubagentColorLegacySnapshot {
  loadedWorkspacePath: string | null;
  loadedWorkspaceIdentity: string | null;
  loadedProvider: ZCodeProvider | null;
  agents: readonly SubagentIdentityProfile[];
}

const EMPTY_IDENTITY_PROFILES: readonly SubagentIdentityProfile[] = [];
const AGENT_NAME_SEPARATORS = /[\p{White_Space}\p{Pd}_]/gu;

function normalizeAgentIdentityName(value: string): string {
  // 命名空间的冒号不可删除：plugin:reviewer 不是内置 reviewer。
  return value.trim().normalize("NFKC").toLowerCase().replace(AGENT_NAME_SEPARATORS, "");
}

const BUILT_IN_BY_NAME = new Map(
  BUILT_IN_SUBAGENT_DEFINITIONS.map((definition) => [
    normalizeAgentIdentityName(definition.name),
    definition,
  ]),
);
const BUILT_IN_BY_ID = new Map(
  BUILT_IN_SUBAGENT_DEFINITIONS.map((definition) => [
    createAgentStateId({ name: definition.name, scope: "built-in", source: "built-in" }),
    definition,
  ]),
);

function resolveBuiltInIdentity(name: string) {
  return (
    BUILT_IN_BY_ID.get(name.trim().normalize("NFKC").toLowerCase()) ??
    BUILT_IN_BY_NAME.get(normalizeAgentIdentityName(name))
  );
}

function matchSubagentProfile(
  name: string,
  profiles: readonly SubagentIdentityProfile[],
): SubagentIdentityProfile | undefined {
  const exact = profiles.filter((profile) => profile.name === name || profile.id === name);
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
  const normalizedName = normalizeAgentIdentityName(name);
  if (!normalizedName) return undefined;
  const matches = profiles.filter(
    (profile) =>
      normalizeAgentIdentityName(profile.name) === normalizedName ||
      (profile.id !== undefined && normalizeAgentIdentityName(profile.id) === normalizedName),
  );
  // 同名自建配置可能归一化成同一值；不能依赖列表顺序选中其中一个。
  return matches.length === 1 ? matches[0] : undefined;
}

export function isSubagentColor(value: string): value is AgentColor {
  return (SUBAGENT_COLORS as readonly string[]).includes(value);
}

export function resolveSubagentColorFromName(name: string): AgentColor {
  const normalizedName = normalizeAgentIdentityName(name);
  let hash = 0;
  for (let index = 0; index < normalizedName.length; index += 1) {
    hash = (hash * 31 + normalizedName.charCodeAt(index)) >>> 0;
  }
  return SUBAGENT_COLORS[hash % SUBAGENT_COLORS.length] ?? "blue";
}

/** 当前匹配配置 → 内置目录 → 非内置旧工具色 → 同名稳定兜底。 */
export function resolveSubagentIdentityColor({
  name,
  color,
  profiles = EMPTY_IDENTITY_PROFILES,
}: {
  name: string;
  color?: unknown;
  profiles?: readonly SubagentIdentityProfile[];
}): AgentColor {
  const profile = matchSubagentProfile(name, profiles);
  if (profile) {
    if (profile.color && isSubagentColor(profile.color)) return profile.color;
    if (profile.scope === "built-in" && profile.source === "built-in") {
      const builtIn =
        resolveBuiltInIdentity(profile.name) ?? resolveBuiltInIdentity(profile.id ?? "");
      if (builtIn) return builtIn.color;
    }
    // 自建/插件缺色按其定义名兜底，不能借用同名内置色或旧工具元数据。
    return resolveSubagentColorFromName(profile.name);
  }
  // 历史工具可能把所有角色写成 red；已知内置身份必须先取权威目录色。
  const builtIn = resolveBuiltInIdentity(name);
  if (builtIn) return builtIn.color;
  if (typeof color === "string" && isSubagentColor(color)) return color;
  return resolveSubagentColorFromName(name);
}

/** 只读现有配置快照；返回原数组以保持 Zustand selector 的引用稳定。 */
export function selectSubagentIdentityProfiles(
  workspace: SubagentColorWorkspace,
  context?: SubagentColorContextSnapshot,
  legacy?: SubagentColorLegacySnapshot,
): readonly SubagentIdentityProfile[] {
  const workspaceIdentity = workspace.workspaceIdentity?.trim() || null;
  if (
    context?.loaded &&
    context.workspacePath === workspace.workspacePath &&
    (context.workspaceIdentity?.trim() || null) === workspaceIdentity &&
    context.provider === workspace.provider
  ) {
    return context.agents;
  }
  // 旧单例属于已加载的 workspace，而非当前路由；同 path 的不同远端身份也不能复用。
  if (
    legacy?.loadedWorkspacePath === workspace.workspacePath &&
    (legacy.loadedWorkspaceIdentity?.trim() || null) === workspaceIdentity &&
    legacy.loadedProvider === workspace.provider
  ) {
    return legacy.agents;
  }
  return EMPTY_IDENTITY_PROFILES;
}
