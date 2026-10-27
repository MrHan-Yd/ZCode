import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROMPT_LIBRARY_LIMITS,
  formatZodError,
  promptLibraryFileV1Schema,
  type PromptLibraryFileV1,
  type PromptTemplate,
} from "@zcode/shared";
import type { CredentialServiceAccess } from "../credential/credential.js";
import { createConfigSyncBackup } from "../config-sync/backup.js";
import { createConfigSyncMetadataStore } from "../config-sync/metadata.js";
import { createConfigSync, type ConfigSyncOperations } from "../config-sync/orchestrator.js";
import { ConfigSyncLocalInvalidError } from "../config-sync/types.js";
import type {
  ConfigSyncItem,
  ConfigSyncProfile,
  ConfigSyncSnapshot,
} from "../config-sync/types.js";
import { getAppConfigDir } from "../paths.js";

/**
 * 提示词库 ↔ 私有 gist 的同步：通用编排在 `config-sync/orchestrator.ts`，
 * 这里只描述「整库 = 一个 prompts.json 条目」这条业务语义。
 *
 * 写盘不在这里直连文件系统：`PromptLibrarySyncAccess` 由 `PromptLibraryService` 实现，
 * 内部复用其 withFileLock + 原子写与损坏/版本保护，避免出现第二条写入路径。
 */

export const PROMPT_LIBRARY_CONFIG_GIST_DESCRIPTION = "zcode-prompt-library-config-sync";
export const PROMPT_LIBRARY_SYNC_ITEM_NAME = "prompts";
export const PROMPT_LIBRARY_SYNC_FILE_NAME = "prompts.json";

const SYNC_METADATA_FILE_NAME = "prompt-library-sync-metadata.json";
const SYNC_BACKUP_DIR_NAME = "prompt-library";
const SYNC_BACKUP_ITEM_NAME = "prompt-library.json";

/** 库自身状态的读写端口；`readOnly` 表示损坏或文件版本高于当前 Host。 */
export interface PromptLibrarySyncAccess {
  /** 文件不存在 → 空 v1；损坏/未来版本 → 空 v1 且 readOnly。 */
  read(): Promise<{ file: PromptLibraryFileV1; readOnly: boolean }>;
  /** 在提示词库自己的文件锁内读改写，并在写前校验；失败时抛错且不写盘。 */
  update(mutate: (current: PromptLibraryFileV1) => PromptLibraryFileV1): Promise<void>;
  /** 从校验过的文件整份还原（备份还原路径）；失败返回 false。 */
  restore(file: PromptLibraryFileV1): Promise<boolean>;
  /** `prompt-library.json` 的绝对路径，用于备份。 */
  filePath(): string;
}

export interface CreatePromptLibraryConfigSyncOptions {
  readonly access: PromptLibrarySyncAccess;
  readonly credentialService?: CredentialServiceAccess;
  readonly fetchImpl?: typeof fetch;
  /** 与普通写路径串行的执行器；缺省直接执行，真正的互斥仍由 PromptLibrary 文件锁保证。 */
  readonly enqueueWrite?: <T>(run: () => Promise<T>) => Promise<T>;
  readonly now?: () => number;
}

function parsePromptLibraryFile(content: string): PromptLibraryFileV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  const validated = promptLibraryFileV1Schema.safeParse(parsed);
  return validated.success ? validated.data : null;
}

function compareById(left: PromptTemplate, right: PromptTemplate): number {
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** 稳定序列化：items 按 id 排序，2 空格缩进 + 末尾换行，保证同一内容产生同一指纹。 */
export function serializePromptLibraryFileForSync(file: PromptLibraryFileV1): string {
  const stable: PromptLibraryFileV1 = {
    version: 1,
    updatedAt: file.updatedAt,
    items: [...file.items].sort(compareById),
  };
  return `${JSON.stringify(stable, null, 2)}\n`;
}

export function createEmptyPromptLibraryFile(timestamp: number): PromptLibraryFileV1 {
  return { version: 1, updatedAt: timestamp, items: [] };
}

/**
 * 写盘前先校验合并结果：超过 500 条、alias 冲突等本地约束失败要映射为 `local_invalid`，
 * 并与网络/IO 错误区分开。校验失败时抛错，调用方不会写盘。
 */
function assertSyncFileValid(file: PromptLibraryFileV1): void {
  const validated = promptLibraryFileV1Schema.safeParse(file);
  if (!validated.success) {
    throw new ConfigSyncLocalInvalidError(formatZodError(validated.error));
  }
}

/**
 * merge：同 id 远端优先，本地独有保留。
 *
 * alias 先由远端条目占位，再遍历合并结果；本地独有项与远端 alias 冲突（大小写不敏感）时清空本地
 * 条目的 alias，而不是删除条目。远端内部的重复 alias 也在这里收敛，避免写出违反库不变量的数据。
 */
export function mergePromptLibraryFiles(
  local: PromptLibraryFileV1,
  remote: PromptLibraryFileV1,
): PromptLibraryFileV1 {
  const remoteIds = new Set(remote.items.map((item) => item.id));
  const merged = new Map<string, PromptTemplate>();
  // 先放远端：Map 的插入顺序让远端 alias 优先被占用。
  for (const item of remote.items) merged.set(item.id, item);
  for (const item of local.items) {
    if (!remoteIds.has(item.id)) merged.set(item.id, item);
  }

  const claimedAliases = new Set<string>();
  for (const [id, item] of merged) {
    if (!item.alias) continue;
    const aliasKey = item.alias.toLowerCase();
    if (claimedAliases.has(aliasKey)) {
      merged.set(id, { ...item, alias: undefined });
      continue;
    }
    claimedAliases.add(aliasKey);
  }

  return {
    version: 1,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    items: [...merged.values()].sort(compareById),
  };
}

export const PROMPT_LIBRARY_CONFIG_PROFILE: ConfigSyncProfile = {
  fileNameFor(name) {
    return name === PROMPT_LIBRARY_SYNC_ITEM_NAME ? PROMPT_LIBRARY_SYNC_FILE_NAME : null;
  },
  nameFromFileName(fileName) {
    return fileName === PROMPT_LIBRARY_SYNC_FILE_NAME ? PROMPT_LIBRARY_SYNC_ITEM_NAME : null;
  },
  isValidContent(fileName, content) {
    return fileName === PROMPT_LIBRARY_SYNC_FILE_NAME && parsePromptLibraryFile(content) !== null;
  },
  extraFileNames: [],
  maxFileBytes: PROMPT_LIBRARY_LIMITS.maxFileBytes,
  maxTotalBytes: PROMPT_LIBRARY_LIMITS.maxFileBytes,
};

export function createPromptLibraryConfigSync(
  options: CreatePromptLibraryConfigSyncOptions,
): ConfigSyncOperations {
  const now = options.now ?? Date.now;
  const enqueueWrite = options.enqueueWrite ?? (<T>(run: () => Promise<T>) => run());

  const collectSnapshot = async (): Promise<ConfigSyncSnapshot> => {
    // 损坏/未来版本时 read() 返回空 v1；同步动作入口会在 readOnly 时先返回 local_invalid。
    const { file } = await options.access.read();
    const items: ConfigSyncItem[] = [
      {
        name: PROMPT_LIBRARY_SYNC_ITEM_NAME,
        content: serializePromptLibraryFileForSync(file),
      },
    ];
    return { items, extras: [], skippedLocalFiles: [] };
  };

  return createConfigSync({
    adapter: {
      gistDescription: PROMPT_LIBRARY_CONFIG_GIST_DESCRIPTION,
      profile: PROMPT_LIBRARY_CONFIG_PROFILE,
      metadata: createConfigSyncMetadataStore(async () =>
        join(getAppConfigDir(), SYNC_METADATA_FILE_NAME),
      ),
      backup: createConfigSyncBackup({
        rootDir: async () => join(getAppConfigDir(), "backups", SYNC_BACKUP_DIR_NAME),
        entries: async () => [{ source: options.access.filePath(), name: SYNC_BACKUP_ITEM_NAME }],
      }),
      collectSnapshot,

      async apply({ remoteItems, strategy }) {
        const remoteContent = remoteItems.find(
          (item) => item.name === PROMPT_LIBRARY_SYNC_ITEM_NAME,
        )?.content;
        const remoteFile = remoteContent ? parsePromptLibraryFile(remoteContent) : null;

        if (strategy === "replace") {
          const next = remoteFile ?? createEmptyPromptLibraryFile(now());
          assertSyncFileValid(next);
          await options.access.update(() => next);
          return;
        }

        // merge 且远端没有该条目：保持本地不变。
        if (!remoteFile) return;
        // 在文件锁内用最新本地状态合并并校验；校验抛错时 update 不会写盘。
        await options.access.update((current) => {
          const merged = mergePromptLibraryFiles(current, remoteFile);
          assertSyncFileValid(merged);
          return merged;
        });
      },

      countBackupItems: countPromptLibraryBackupItems,

      async restoreFromBackup(backupDir) {
        try {
          const raw = await readFile(join(backupDir, SYNC_BACKUP_ITEM_NAME), "utf-8");
          const file = parsePromptLibraryFile(raw);
          if (!file) return false;
          return await options.access.restore(file);
        } catch {
          return false;
        }
      },
    },
    credentialService: options.credentialService,
    fetchImpl: options.fetchImpl,
    enqueueWrite,
    now,
  });
}

/** 统计备份里的提示词条数；文件缺失/损坏返回 null。 */
async function countPromptLibraryBackupItems(backupDir: string): Promise<number | null> {
  try {
    const raw = await readFile(join(backupDir, SYNC_BACKUP_ITEM_NAME), "utf-8");
    const file = parsePromptLibraryFile(raw);
    return file ? file.items.length : null;
  } catch {
    return null;
  }
}
