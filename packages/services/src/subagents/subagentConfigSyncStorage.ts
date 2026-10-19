import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { getAppConfigDir } from "../paths.js";
import { createConfigSyncMetadataStore } from "../config-sync/metadata.js";
import { resolveConfigSyncScope, scopeBackupDirName } from "../config-sync/scope.js";
import type { ConfigSyncBackupEntry } from "../config-sync/backup.js";
import type { ConfigSyncExtra, ConfigSyncItem, ConfigSyncSnapshot } from "../config-sync/types.js";
import { serializeCuratedState } from "./subagentConfigSyncModel.js";
import {
  resolveSubagentStateFile,
  resolveUserSubagentRoot,
  resolveWorkspaceSubagentRoot,
  type SubagentStorageOptions,
} from "./subagentStorage.js";

/**
 * 子智能体的本机事实：`agents/` 根目录下的 md（条目）+ 用户级 `agents-state.json` 的精选子集（额外通道）。
 * 唯一写入方是 `SubagentsService`；这里只负责读快照与给出备份清单。
 *
 * 作用域由「有没有 `workspacePath`」决定：用户级读 `{storageRoot}/agents`，工作区级读
 * `<workspace>/.zcode/agents` 且没有额外通道（工作区 agent 恒为启用）。
 */

const AGENT_FILE_PATTERN = /\.(?:md|markdown)$/iu;
const SYNC_METADATA_FILE_NAME = "subagents-config-sync.json";
const BACKUP_DIR_NAME = "subagents-config-sync-backup";

/**
 * 同步元数据与备份落在**设置里的数据存储路径**下（`{dataBaseDir}/.zcode/v2`），
 * 与模型智能配置等服务同层；默认设置下就是 `~/.zcode/v2`。
 *
 * 两个作用域共用同一份元数据文件，靠文件内的分片区分（见 `config-sync/metadata.ts`）；
 * 备份则按作用域分根目录，切换分区看到的就是该作用域自己的备份。
 */
export function resolveSubagentSyncMetadataStore(workspacePath?: string) {
  const scope = resolveConfigSyncScope(workspacePath);
  return createConfigSyncMetadataStore(
    async () => join(getAppConfigDir(), SYNC_METADATA_FILE_NAME),
    scope,
  );
}

export async function resolveSubagentSyncBackupRoot(workspacePath?: string): Promise<string> {
  const scope = resolveConfigSyncScope(workspacePath);
  return join(getAppConfigDir(), BACKUP_DIR_NAME, scopeBackupDirName(scope));
}

/** 统计一份备份里的 agent 数（备份里是整份 `agents/` 目录），供还原界面区分备份。 */
export async function countSubagentBackupItems(backupDir: string): Promise<number | null> {
  const entries = await readdir(join(backupDir, "agents"), { withFileTypes: true }).catch(
    () => null,
  );
  if (!entries) return null;
  return entries.filter((entry) => entry.isFile() && AGENT_FILE_PATTERN.test(entry.name)).length;
}

export function resolveSubagentSyncBackupEntries(
  workspacePath: string | undefined,
  storageOptions?: SubagentStorageOptions,
): () => Promise<readonly ConfigSyncBackupEntry[]> {
  return async () => {
    const agentsRoot = await resolveSubagentAgentsRoot(workspacePath, storageOptions);
    // 工作区级没有 state 文件，备份里也就没有这一项。
    if (workspacePath) return [{ source: agentsRoot, name: "agents" }];
    return [
      { source: agentsRoot, name: "agents" },
      { source: await resolveSubagentStateFile(storageOptions), name: "agents-state.json" },
    ];
  };
}

export async function collectSubagentSyncSnapshot(
  workspacePath: string | undefined,
  storageOptions: SubagentStorageOptions | undefined,
  readCuratedState: () => Promise<Parameters<typeof serializeCuratedState>[0]>,
): Promise<ConfigSyncSnapshot> {
  const agentsRoot = await resolveSubagentAgentsRoot(workspacePath, storageOptions);
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
  const extras: ConfigSyncExtra[] = workspacePath
    ? []
    : [{ fileName: "state.json", content: serializeCuratedState(await readCuratedState()) }];
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
  workspacePath: string | undefined,
  storageOptions?: SubagentStorageOptions,
): Promise<string> {
  return workspacePath
    ? Promise.resolve(resolveWorkspaceSubagentRoot(workspacePath))
    : resolveUserSubagentRoot(storageOptions);
}

/** 子目录里的 md 不参与同步（嵌套结构随仓库版本化），但要在状态里报出来。 */
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
