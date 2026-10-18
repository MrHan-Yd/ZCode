import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ICredentialService } from "../credential/credential.js";
import { getAppConfigDir } from "../paths.js";
import { createConfigSyncBackup } from "../config-sync/backup.js";
import { createConfigSyncMetadataStore } from "../config-sync/metadata.js";
import {
  createConfigSync,
  type ConfigSyncAdapter,
  type ConfigSyncOperations,
} from "../config-sync/orchestrator.js";
import type { ConfigSyncItem, ConfigSyncSnapshot } from "../config-sync/types.js";
import {
  MCP_CONFIG_GIST_DESCRIPTION,
  MCP_CONFIG_PROFILE,
  mcpServerItemContent,
  parseMcpServerConfig,
  resolveServerMap,
  type McpServerConfigObject,
} from "./mcpConfigSyncModel.js";

/**
 * MCP 服务器配置 ↔ 私有 gist 的同步：通用编排在 `config-sync/orchestrator.ts`，
 * 这里只描述「条目 = 一个用户级 server 配置」这条业务语义。
 *
 * 读写端口由 `McpSyncService` 注入（它才是用户目录 MCP 配置的唯一所有者）。
 */

export interface McpConfigSyncServerRecord {
  readonly name: string;
  readonly config: McpServerConfigObject;
  readonly enabled: boolean;
}

export interface CreateMcpConfigSyncOptions {
  /** 读当前生效的用户级 MCP server（ZCode 目录优先，回退 agents 目录）。 */
  readonly readEffectiveServers: () => Promise<readonly McpConfigSyncServerRecord[]>;
  /** 把合并后的 server 映射写回 ZCode 用户配置。 */
  readonly writeUserServers: (servers: Record<string, McpServerConfigObject>) => Promise<void>;
  /** ZCode 用户配置文件绝对路径（备份对象）。 */
  readonly userConfigPath: () => Promise<string>;
  /** 同步元数据与备份的目录；缺省用设置里的数据存储路径（`{dataBaseDir}/.zcode/v2`）。 */
  readonly dataDir?: () => Promise<string>;
  readonly credentialService?: Pick<ICredentialService, "load">;
  readonly fetchImpl?: typeof fetch;
  readonly enqueueWrite: <T>(run: () => Promise<T>) => Promise<T>;
  readonly now?: () => number;
}

export function createMcpConfigSync(options: CreateMcpConfigSyncOptions): ConfigSyncOperations {
  // 元数据与备份跟随设置里的数据存储路径（`{dataBaseDir}/.zcode/v2`）。
  const dataDir = options.dataDir ?? (async () => getAppConfigDir());
  const adapter: ConfigSyncAdapter = {
    gistDescription: MCP_CONFIG_GIST_DESCRIPTION,
    profile: MCP_CONFIG_PROFILE,
    metadata: createConfigSyncMetadataStore(async () =>
      join(await dataDir(), "mcp-config-sync.json"),
    ),
    backup: createConfigSyncBackup({
      rootDir: async () => join(await dataDir(), "mcp-config-sync-backup"),
      entries: async () => [{ source: await options.userConfigPath(), name: "config.json" }],
    }),
    collectSnapshot: () => collectMcpSnapshot(options.readEffectiveServers),
    countBackupItems: countMcpBackupItems,

    async apply({ remoteItems, local, strategy }) {
      // merge 用本机当前生效集合打底（含从 agents 目录读到的服务器），因此写回 ZCode 配置不会把
      // 这些服务器「遮掉」；replace 只留远端条目。两者都按远端全集重写，未变更的 server 必须保留。
      const servers = resolveServerMap({
        base: strategy === "merge" ? toServerMap(local.items) : new Map(),
        remoteItems,
      });
      if (!servers) throw new Error("远端 server 配置无法解析");
      await options.writeUserServers(servers);
    },
  };

  return createConfigSync({
    adapter,
    credentialService: options.credentialService,
    fetchImpl: options.fetchImpl,
    enqueueWrite: options.enqueueWrite,
    ...(options.now ? { now: options.now } : {}),
  });
}

/** 统计一份备份里的 server 数（备份里是整份 config.json）。 */
async function countMcpBackupItems(backupDir: string): Promise<number | null> {
  try {
    const raw = await readFile(join(backupDir, "config.json"), "utf-8");
    const parsed = JSON.parse(raw) as { mcp?: { servers?: Record<string, unknown> } };
    const servers = parsed.mcp?.servers;
    return servers && typeof servers === "object" ? Object.keys(servers).length : null;
  } catch {
    return null;
  }
}

async function collectMcpSnapshot(
  readEffectiveServers: () => Promise<readonly McpConfigSyncServerRecord[]>,
): Promise<ConfigSyncSnapshot> {
  const records = await readEffectiveServers();
  const items: ConfigSyncItem[] = records.map((record) => ({
    name: record.name,
    content: mcpServerItemContent(record.config, record.enabled),
  }));
  items.sort((left, right) => left.name.localeCompare(right.name));
  return { items, extras: [], skippedLocalFiles: [] };
}

/** 快照条目 → server 映射：本地集合用于 merge 打底，内容解析失败时由调用方按 invalid 处理。 */
function toServerMap(items: readonly ConfigSyncItem[]): Map<string, McpServerConfigObject> {
  const result = new Map<string, McpServerConfigObject>();
  for (const item of items) {
    const config = parseMcpServerConfig(item.content);
    if (config) result.set(item.name, config);
  }
  return result;
}
