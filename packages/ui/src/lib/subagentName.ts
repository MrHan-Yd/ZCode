/**
 * 子智能体显示名的唯一策略点（状态面板运行中的行）。
 *
 * 名字来自 runtime 报出的 `subagentType`：照抄不改写、不本地化——它是标识符不是文案，
 * 本地化它等于改用户/模型说的话。同一会话里 Agent 工具行显示的就是同一个词。
 *
 * 投影在 payload 缺 `agentType` 时会落 `subagent` 哨兵（product-projection 与
 * transcript-hydration 的兜底），空串同样不是名字：两者都返回 undefined，让调用方整段不渲染。
 * 行的图标已经说明「这是子智能体」，再写一遍哨兵只是噪声。
 */

/** payload 缺 `agentType` 时投影落的兜底值；它不是任何子智能体的名字。 */
export const SUBAGENT_UNNAMED_TYPE = "subagent";

export function resolveSubagentDisplayName(subagentType: string | undefined): string | undefined {
  const name = subagentType?.trim();
  if (!name || name === SUBAGENT_UNNAMED_TYPE) return undefined;
  return name;
}
