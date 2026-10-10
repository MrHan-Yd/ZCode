import type { PromptInputTrigger } from "@/lib/promptInputTriggers.js";

export type MentionPanelGroupId = "plugins" | "files" | "sessions" | "whiteboards" | "skills";
export type SessionMentionWorkspaceScope = "current-workspace" | "same-authority-workspaces";

// 会话引用统一走 `#`，`@` 不再返回会话候选，避免与 `#` 重复。
const CONTEXT_GROUP_ORDER: readonly MentionPanelGroupId[] = ["plugins", "files", "whiteboards"];
const SESSION_GROUP_ORDER: readonly MentionPanelGroupId[] = ["sessions"];
const SKILL_GROUP_ORDER: readonly MentionPanelGroupId[] = ["skills"];

/**
 * 输入触发器只负责发现入口，不改变候选选中后的 canonical mention。
 * `#` 与 `$`（含输入层归一后的 `¥` / `￥`）继续保留旧单分组面板。
 */
export function getMentionPanelGroupOrder(
  trigger: PromptInputTrigger | null | undefined,
): readonly MentionPanelGroupId[] {
  if (trigger === "@") {
    return CONTEXT_GROUP_ORDER;
  }
  if (trigger === "#") {
    return SESSION_GROUP_ORDER;
  }
  if (trigger === "$") {
    return SKILL_GROUP_ORDER;
  }
  return [];
}

/**
 * 会话候选只由 `#` 触发（`@` 已不再查询会话），`#` 可扩展到同 authority 的 workspace；
 * 保留 default 分支兜底，避免触发器路由改动连带到 provider 行为。
 */
export function getSessionMentionWorkspaceScope(
  trigger: PromptInputTrigger | null | undefined,
): SessionMentionWorkspaceScope {
  return trigger === "#" ? "same-authority-workspaces" : "current-workspace";
}
