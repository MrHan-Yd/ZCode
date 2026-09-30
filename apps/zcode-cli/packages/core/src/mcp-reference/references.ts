// MCP 对话引用的严格 canonical 解析。
// 契约：
// - 只接受 Markdown 链接 destination 形如 `mcp://<serverName>`，协议名大小写敏感（仅小写）。
// - serverName 必须与运行时 MCP 配置的 record key 完全一致，且通过 shared 的
//   `isMcpReferenceName`（字母表唯一所有者在 `@zcode/shared`，UI 生成引用时读同一判据）。
// - 身份只来自 destination；label 永不参与解析。
import { isMcpReferenceName, MCP_REFERENCE_SCHEME } from "@zcode/shared";

// 与 mentionMarkdown 的链接语法保持一致：label 支持 \ 转义，destination 支持 <...> 或裸形式。
const MARKDOWN_LINK_PATTERN = /\[(?:\\.|[^\\\]])*\]\((?:<((?:\\.|[^>])*?)>|((?:\\.|[^)\s])*))\)/g;

/** 单轮最多注入的 MCP 引用条数。 */
export const MAX_MCP_REFERENCES_PER_TURN = 8;

function parseMcpDestination(destination: string): string | null {
  // 协议名大小写敏感：`Mcp://`、`MCP://` 都不接受。
  if (!destination.startsWith(MCP_REFERENCE_SCHEME)) {
    return null;
  }
  const serverName = destination.slice(MCP_REFERENCE_SCHEME.length);
  if (!isMcpReferenceName(serverName)) {
    return null;
  }
  return serverName;
}

function isMcpSchemeDestination(destination: string): boolean {
  // 只把"意图上是 mcp 协议"的 destination 计入 invalid 统计；大小写变体也算意图命中但解析失败。
  return /^mcp:\/\//i.test(destination);
}

export interface ExtractMcpReferencesResult {
  /** 按正文首次出现顺序、按服务器名去重后的引用。 */
  references: string[];
  /** 超过单轮上限被丢弃的引用次数（fail closed，调用侧记 debug truncated）。 */
  truncatedCount: number;
  /** 命中 mcp 协议意图但解析失败的 destination 数量。 */
  invalidCount: number;
}

/**
 * 从 canonical 用户文本中提取 MCP 引用（服务器名）。
 * 身份只来自链接 destination；Markdown label 完全不参与。
 */
export function extractMcpReferences(input: string): ExtractMcpReferencesResult {
  const references: string[] = [];
  const seen = new Set<string>();
  let truncatedCount = 0;
  let invalidCount = 0;

  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  for (const match of input.matchAll(MARKDOWN_LINK_PATTERN)) {
    const destination = match[1] ?? match[2] ?? "";
    if (!isMcpSchemeDestination(destination)) {
      continue;
    }
    const serverName = parseMcpDestination(destination);
    if (serverName === null) {
      invalidCount++;
      continue;
    }
    if (seen.has(serverName)) {
      continue;
    }
    if (references.length >= MAX_MCP_REFERENCES_PER_TURN) {
      truncatedCount++;
      continue;
    }
    seen.add(serverName);
    references.push(serverName);
  }

  return { references, truncatedCount, invalidCount };
}
