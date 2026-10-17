import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { createConfigSyncMetadataStore } from "../config-sync/metadata.js";
import type { ConfigSyncBackupEntry } from "../config-sync/backup.js";
import type { ConfigSyncExtra, ConfigSyncItem, ConfigSyncSnapshot } from "../config-sync/types.js";
import { serializeCuratedState } from "./subagentConfigSyncModel.js";
import {
  resolveSubagentStateFile,
  resolveUserSubagentRoot,
  type SubagentStorageOptions,
} from "./subagentStorage.js";

/**
 * 子智能体的本机事实：`agents/` 根目录下的 md（条目）+ `agents-state.json` 的精选子集（额外通道）。
 * 唯一写入方是 `SubagentsService`；这里只负责读快照与给出备份清单。
 */

const AGENT_FILE_PATTERN = /\.(?:md|markdown)$/iu;
const SYNC_METADATA_FILE_NAME = "subagents-config-sync.json";
const BACKUP_DIR_NAME = "subagents-config-sync-backup";

export function resolveSubagentSyncMetadataStore(storageOptions?: SubagentStorageOptions) {
  return createConfigSyncMetadataStore(async () =>
    join(dirname(await resolveSubagentStateFile(storageOptions)), SYNC_METADATA_FILE_NAME),
  );
}

export async function resolveSubagentSyncBackupRoot(
  storageOptions?: SubagentStorageOptions,
): Promise<string> {
  return join(dirname(await resolveSubagentStateFile(storageOptions)), BACKUP_DIR_NAME);
}

export function resolveSubagentSyncBackupEntries(
  storageOptions?: SubagentStorageOptions,
): () => Promise<readonly ConfigSyncBackupEntry[]> {
  return async () => {
    const [agentsRoot, stateFile] = await Promise.all([
      resolveUserSubagentRoot(storageOptions),
      resolveSubagentStateFile(storageOptions),
    ]);
    return [
      { source: agentsRoot, name: "agents" },
      { source: stateFile, name: "agents-state.json" },
    ];
  };
}

export async function collectSubagentSyncSnapshot(
  storageOptions: SubagentStorageOptions | undefined,
  readCuratedState: () => Promise<Parameters<typeof serializeCuratedState>[0]>,
): Promise<ConfigSyncSnapshot> {
  const agentsRoot = await resolveUserSubagentRoot(storageOptions);
  const items: ConfigSyncItem[] = [];
  const skippedLocalFiles: string[] = [];
  const entries = await readdir(agentsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = join(agentsRoot, entry.name);
    if (entry.isDirectory()) {
      skippedLocalFiles.push(...(await collectNestedAgentFiles(agentsRoot, entryPath)));
      continue;
    }
    if (!entry.isFile() || !AGENT_FILE_PATTERN.test(entry.name)) continue;
    items.push({
      name: entry.name.replace(AGENT_FILE_PATTERN, ""),
      content: await readFile(entryPath, "utf-8"),
    });
  }
  items.sort((left, right) => left.name.localeCompare(right.name));
  const extras: ConfigSyncExtra[] = [
    { fileName: "state.json", content: serializeCuratedState(await readCuratedState()) },
  ];
  return {
    items,
    extras,
    skippedLocalFiles: skippedLocalFiles.sort((left, right) => left.localeCompare(right)),
  };
}

export function resolveSubagentAgentPath(agentsRoot: string, name: string): string {
  return join(agentsRoot, `${name}.md`);
}

export function resolveSubagentAgentsRoot(
  storageOptions?: SubagentStorageOptions,
): Promise<string> {
  return resolveUserSubagentRoot(storageOptions);
}

/** 子目录里的 md 不参与同步（工作区级/嵌套结构随仓库版本化），但要在状态里报出来。 */
async function collectNestedAgentFiles(rootPath: string, dirPath: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await collectNestedAgentFiles(rootPath, entryPath)));
      continue;
    }
    if (entry.isFile() && AGENT_FILE_PATTERN.test(entry.name)) {
      result.push(relative(rootPath, entryPath));
    }
  }
  return result;
}
