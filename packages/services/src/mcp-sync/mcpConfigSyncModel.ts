import { canonicalJson } from "../config-sync/manifest.js";
import type { ConfigSyncItem, ConfigSyncProfile } from "../config-sync/types.js";

/**
 * MCP 服务器侧的同步语义：远端文件名映射、server 配置的可加载性判定，以及「名称 → 配置对象」的合并。
 * 通用部分（manifest / 指纹 / 计划 / 密钥扫描）在 `config-sync/` 里。
 */

/** 私有 gist 的固定 description：只用于「本机没有 gistId」时的一次性发现。 */
export const MCP_CONFIG_GIST_DESCRIPTION = "zcode-mcp-config-sync";
const SERVER_FILE_PREFIX = "server.";
const SERVER_FILE_SUFFIX = ".json";

/**
 * 服务器名可以是任意用户字符串（含空格、中文、`/`），而 gist 文件名是扁平的，
 * 所以只对「会破坏文件名语义」的字符做百分号转义，其余原样保留以便在 gist 里可读。
 */
// eslint-disable-next-line no-control-regex -- 控制字符正是要转义的对象
const UNSAFE_NAME_CHARS = /[%\\/\u0000-\u001f\u007f]/gu;

function encodeMcpServerName(name: string): string {
  return name.replace(UNSAFE_NAME_CHARS, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `%${code.toString(16).padStart(2, "0")}`;
  });
}

function decodeMcpServerName(encoded: string): string | null {
  if (!encoded.includes("%")) return encoded;
  try {
    const decoded = decodeURIComponent(encoded);
    // 只有「再编码后与原文完全一致」才算合法，避免把用户手写的 %xx 当成转义。
    return encodeMcpServerName(decoded) === encoded ? decoded : null;
  } catch {
    return null;
  }
}

export function mcpServerFileName(name: string): string | null {
  const encoded = encodeMcpServerName(name);
  return encoded.length > 0 ? `${SERVER_FILE_PREFIX}${encoded}${SERVER_FILE_SUFFIX}` : null;
}

export function mcpServerNameFromFileName(fileName: string): string | null {
  if (!fileName.startsWith(SERVER_FILE_PREFIX) || !fileName.endsWith(SERVER_FILE_SUFFIX)) {
    return null;
  }
  const encoded = fileName.slice(SERVER_FILE_PREFIX.length, -SERVER_FILE_SUFFIX.length);
  return decodeMcpServerName(encoded);
}

/** server 配置对象：`enabled` 按既有约定写在对象内（见 mcpSyncService 的启用状态迁移注释）。 */
export type McpServerConfigObject = Record<string, unknown>;

export function parseMcpServerConfig(content: string): McpServerConfigObject | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as McpServerConfigObject;
  } catch {
    return null;
  }
}

/** 条目内容 = 归一化后的 server 配置对象（含解析出来的 enabled），保证往返一致。 */
export function mcpServerItemContent(config: McpServerConfigObject, enabled: boolean): string {
  return canonicalJson({ ...config, enabled });
}

export const MCP_CONFIG_PROFILE: ConfigSyncProfile = {
  fileNameFor: mcpServerFileName,
  nameFromFileName: mcpServerNameFromFileName,
  isValidContent: (_fileName, content) => parseMcpServerConfig(content) !== null,
  // MCP 没有额外通道：启用状态写在每个 server 配置对象里。
  extraFileNames: [],
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};

/**
 * 解析出要写回本机配置文件的 server 映射。
 *
 * MCP 配置是**整份重写**：`base` 是保留的本地条目（merge 时为本机全集、replace 时为空），
 * `remoteItems` 必须是远端**全部**条目（含内容未变的 `same`），否则镜像下载会把未变更的服务器一起删掉。
 */
export function resolveServerMap(params: {
  readonly base: ReadonlyMap<string, McpServerConfigObject>;
  readonly remoteItems: readonly ConfigSyncItem[];
}): Record<string, McpServerConfigObject> | null {
  const next = new Map<string, McpServerConfigObject>(params.base);
  for (const item of params.remoteItems) {
    const config = parseMcpServerConfig(item.content);
    if (!config) return null;
    next.set(item.name, config);
  }
  return Object.fromEntries([...next].sort(([left], [right]) => left.localeCompare(right)));
}
