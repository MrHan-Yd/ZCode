import type { PromptInputSuggestionItem } from "@/lib/promptInputTriggers.js";
import {
  buildMcpMentionMarkdown,
  buildSkillMentionMarkdown,
  buildSubagentMentionMarkdown,
} from "@/mentions/mentionMarkdown.js";
import { MCP_SUGGESTION_ID_PREFIX, normalizeSlashCommandValue } from "@/slashCommandHelpers.js";
import type { PromptMentionPayload } from "@/mentions/nodes/PromptMentionNode.js";

/** 将 `/` 面板选中的建议转成 PromptMention 载荷；skill/subagent 仍复用既有 $skill 与 @agent markdown 语义。 */
export function buildSlashApplyMentionPayload(
  suggestion: PromptInputSuggestionItem,
): PromptMentionPayload {
  if (suggestion.id.startsWith("skill:")) {
    return {
      id: suggestion.id,
      category: "skills",
      label: suggestion.value,
      value: suggestion.value,
      markdown: buildSkillMentionMarkdown(suggestion.value, suggestion.data?.path),
      description: suggestion.description,
      data: suggestion.data,
    };
  }

  if (suggestion.id.startsWith("subagent:")) {
    return {
      id: suggestion.id,
      category: "subagents",
      label: suggestion.value,
      value: suggestion.value,
      markdown: buildSubagentMentionMarkdown(suggestion.value),
      description: suggestion.description,
      data: suggestion.data,
    };
  }

  if (suggestion.id.startsWith(MCP_SUGGESTION_ID_PREFIX)) {
    return {
      id: suggestion.id,
      category: "mcp",
      label: suggestion.value,
      value: suggestion.value,
      // 身份是服务器名（运行时 MCP 配置的 record key），名字本身即 destination。
      markdown: buildMcpMentionMarkdown(suggestion.value, suggestion.value),
      description: suggestion.description,
      data: suggestion.data,
    };
  }

  const commandValue = normalizeSlashCommandValue(suggestion.value);
  return {
    id: suggestion.id,
    category: "commands",
    label: commandValue,
    value: commandValue,
    markdown: `/${commandValue}`,
    description: suggestion.description,
  };
}
