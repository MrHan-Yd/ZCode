/**
 * slashCommandHelpers — 纯函数辅助工具，供 SlashCommandPlugin.tsx 使用
 */
import { $getRoot, $getSelection, $isRangeSelection, $isTextNode } from "lexical";
import {
  isMcpReferenceName,
  type AgentSummary,
  type Locale,
  type SkillSummary,
  type ZCodeMcpServer,
  type ZCodeSlashCommand,
} from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import type { MentionItem } from "@/mentions/mentionTypes.js";
import { filterLocalMcpServers } from "@/settings/pluginManagedResourceGroups.js";
import { mapSubagentsToMentionItemsForTest } from "@/mentions/providers/subagentsMentionProvider.js";
import { mapSkillsToMentionItemsForTest } from "@/mentions/providers/skillsMentionProvider.js";
import type { PromptInputSuggestionItem } from "./lib/promptInputTriggers.js";

export interface SlashCommandPluginProps {
  container?: HTMLElement | null;
  workspacePath: string;
  workspaceIdentity?: string;
  /** 已有 Session 的 id；null/undefined 表示新建草稿，决定 Skill catalog authority。 */
  sessionId?: string | null;
  disabled?: boolean;
  excludedCommandNames?: readonly string[];
  /**
   * App 层本地命令（如 `/side`）。命令目录仍以 CLI catalog 为权威；这里只允许渲染层
   * 追加"选中即执行 UI 行为"的命令，不参与发送，也不写回 CLI 命令列表。
   */
  appCommands?: readonly AppSlashCommand[];
}

/** App 层斜杠命令：选中即执行 UI 行为（不插入 mention、不发送）。 */
export interface AppSlashCommand {
  /** 命令值（不含 `/`），如 "side"。 */
  value: string;
  /** 本地化描述，直接展示在 `/` 面板。 */
  description: string;
  /** 额外搜索关键词；应同时包含中英文别名，保证两种输入习惯都能搜到。 */
  keywords?: readonly string[];
  /** 选中命令后立即执行的 UI 行为。 */
  run: () => void;
}

const APP_SLASH_SUGGESTION_ID_PREFIX = "app-slash:";

/** `/` 面板里 MCP 建议的 id 前缀；与 `buildSlashApplyMentionPayload` 的分支判定共用。 */
export const MCP_SUGGESTION_ID_PREFIX = "mcp:";

export function buildAppSlashCommandSuggestions(
  commands: readonly AppSlashCommand[],
): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.value);
    if (!value) {
      return [];
    }
    return [
      {
        id: `${APP_SLASH_SUGGESTION_ID_PREFIX}${value}`,
        trigger: "/",
        value,
        label: `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.description, ...(command.keywords ?? [])])],
      },
    ];
  });
}

export function isAppSlashCommandSuggestion(suggestion: PromptInputSuggestionItem): boolean {
  return suggestion.id.startsWith(APP_SLASH_SUGGESTION_ID_PREFIX);
}

/**
 * `/side` 门禁：草稿态没有父 session 可挂 child，辅助对话自身不允许再开辅助对话，
 * 只读与手机 viewport 与固定入口保持一致地隐藏。
 */
export function shouldOfferSideSlashCommand(options: {
  isDraft: boolean;
  selectionSideChat: boolean;
  readOnly: boolean;
  isMobileViewport: boolean;
}): boolean {
  return (
    !options.isDraft && !options.selectionSideChat && !options.readOnly && !options.isMobileViewport
  );
}

export function normalizeSlashCommandValue(name: string): string {
  // ZCode Agent 在远端可能直接返回 "/init" 作为命令名。
  // UI 的 value 需要去掉前导斜杠，否则插入 markdown 时会变成 "//init"，并影响 / 面板匹配。
  return name.trim().replace(/^\/+/, "");
}

export function buildSlashSuggestions(commands: ZCodeSlashCommand[]): PromptInputSuggestionItem[] {
  return commands.flatMap((command) => {
    const value = normalizeSlashCommandValue(command.name);
    // UI 曾同时维护内建白名单、GLM `/goal` fallback 和 v4 追加目录，
    // CLI catalog 丢失时仍会显示部分命令，掩盖 `/init` 与自定义命令缺失。命令发现
    // 统一以 CLI protocol catalog 为权威，UI 不再追加命令或维护内建白名单。
    if (!value) {
      return [];
    }
    return [
      {
        id: `slash:${value}`,
        trigger: "/",
        value,
        label: command.inputHint?.trim() || `/${value}`,
        description: command.description,
        keywords: [...new Set([value, command.name, command.description, command.inputHint ?? ""])],
      },
    ];
  });
}

export function buildSubagentSuggestions(
  agents: Array<
    Pick<
      AgentSummary,
      "id" | "name" | "description" | "path" | "scope" | "source" | "enabled" | "modelSelection"
    >
  >,
): PromptInputSuggestionItem[] {
  return mapSubagentsToMentionItemsForTest(agents).map((item) =>
    mapSubagentMentionItemToSuggestion(item),
  );
}

export function buildSkillSuggestions(
  skills: Array<
    Pick<SkillSummary, "id" | "name" | "description" | "path" | "scope" | "pluginName">
  >,
  locale?: Locale,
): PromptInputSuggestionItem[] {
  return mapSkillsToMentionItemsForTest(skills, locale).map((item) => ({
    id: item.id,
    trigger: "/",
    value: item.value,
    label: `$${item.value}`,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "skill", "skills", item.value])],
    data: item.data,
  }));
}

/**
 * MCP 服务器建议。只列可引用的本地服务器（复用 `filterLocalMcpServers`：项目级 + 全局），
 * 已禁用或名称含引用不支持字符的服务器不进列表——UI 不能生成一个 CLI 必然拒绝的引用。
 * 运行时 MCP 配置以服务器名为键，同名在运行时无法区分：这里按名去重，项目级优先。
 */
export function buildMcpSuggestions(
  servers: readonly ZCodeMcpServer[],
  intl: IntlInstance,
): PromptInputSuggestionItem[] {
  const byName = new Map<string, ZCodeMcpServer>();
  for (const server of filterLocalMcpServers([...servers], "")) {
    const existing = byName.get(server.name);
    if (!existing || (existing.scope !== "workspace" && server.scope === "workspace")) {
      byName.set(server.name, server);
    }
  }

  return [...byName.values()]
    .filter((server) => server.enabled !== false && isMcpReferenceName(server.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((server) => ({
      id: `${MCP_SUGGESTION_ID_PREFIX}${server.name}`,
      trigger: "/" as const,
      value: server.name,
      label: `@${server.name}`,
      description: describeMcpSuggestion(server, intl),
      keywords: [
        ...new Set(
          [server.name, "mcp", server.config.command, server.config.url].filter(
            (entry): entry is string => typeof entry === "string" && entry.length > 0,
          ),
        ),
      ],
      data: {
        scope: server.scope === "workspace" ? ("workspace" as const) : ("user" as const),
        source: "user" as const,
      },
    }));
}

/** 候选行副标题：作用域 · 传输方式 · 工具数；缺项不占位。 */
function describeMcpSuggestion(server: ZCodeMcpServer, intl: IntlInstance): string {
  const scope = intl.formatMessage({
    id:
      server.scope === "workspace" ? "chat.slash.mcp.scope.project" : "chat.slash.mcp.scope.global",
  });
  const transport =
    server.config.command !== undefined && server.config.command.length > 0
      ? "stdio"
      : (server.config.type ?? (server.config.url ? "http" : "")).trim();
  const tools =
    typeof server.toolCount === "number" && server.toolCount > 0
      ? intl.formatMessage({ id: "chat.slash.mcp.toolCount" }, { count: server.toolCount })
      : "";

  return [scope, transport, tools].filter((part) => part.length > 0).join(" · ");
}

function mapSubagentMentionItemToSuggestion(item: MentionItem): PromptInputSuggestionItem {
  return {
    id: item.id,
    trigger: "/",
    value: item.value,
    label: item.label,
    description: item.description,
    keywords: [...new Set([...(item.keywords ?? []), "subagent", "agent"])],
    data: item.data,
  };
}

export function getTextAroundCursor() {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return null;
  }

  const anchor = selection.anchor;
  if (anchor.type !== "text") {
    return {
      textAfterCursor: "",
      textBeforeCursor: $getRoot().getTextContent(),
    };
  }

  const node = anchor.getNode();
  if (!$isTextNode(node)) {
    return null;
  }

  const textContent = node.getTextContent();
  return {
    textAfterCursor: textContent.slice(anchor.offset),
    textBeforeCursor: textContent.slice(0, anchor.offset),
  };
}
