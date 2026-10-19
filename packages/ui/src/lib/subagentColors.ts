import type { AgentColor } from "@zcode/shared";

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

export function isSubagentColor(value: string): value is AgentColor {
  return (SUBAGENT_COLORS as readonly string[]).includes(value);
}

export function resolveSubagentColorFromName(name: string): AgentColor {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }
  return SUBAGENT_COLORS[hash % SUBAGENT_COLORS.length] ?? "blue";
}
