import type { AgentColor, AgentSummary } from "@zcode/shared";
import { resolveSubagentColorFromName } from "./subagentColors.js";

/** 颜色占用统计只关心这几个字段，便于测试直接构造最小对象。 */
export type SubagentColorUsageAgent = Pick<AgentSummary, "name" | "color" | "scope" | "source"> &
  Pick<Partial<AgentSummary>, "readOnly">;

/**
 * 自建子智能体：用户在用户目录或工作区里创建、可以编辑的 agent。
 * 内置（general-purpose / Explore）与插件 agent 都不是自建，不参与颜色占用统计——
 * 它们的颜色由程序或插件决定，标成「已占用」只会误导用户。
 */
export function isSelfCreatedSubagent(agent: SubagentColorUsageAgent): boolean {
  return (
    (agent.scope === "user" || agent.scope === "workspace") &&
    agent.source === "user" &&
    agent.readOnly !== true
  );
}

/**
 * 子智能体实际显示的身份色：显式 `color` 优先，未设置时按名称 hash 兜底。
 * 与列表行、工具调用区块的取色口径一致，否则会把「运行时显示成紫色」的 agent 当成没有颜色。
 */
export function resolveSubagentDisplayColor(agent: SubagentColorUsageAgent): AgentColor {
  return agent.color ?? resolveSubagentColorFromName(agent.name);
}

/**
 * 统计每个颜色被多少个自建子智能体占用。
 * 返回值只用于提示（哪些颜色还没人用），不参与任何选择限制。
 */
export function countSubagentColorUsage(
  agents: readonly SubagentColorUsageAgent[],
): Map<AgentColor, number> {
  const counts = new Map<AgentColor, number>();
  for (const agent of agents) {
    if (!isSelfCreatedSubagent(agent)) {
      continue;
    }
    const color = resolveSubagentDisplayColor(agent);
    counts.set(color, (counts.get(color) ?? 0) + 1);
  }
  return counts;
}
