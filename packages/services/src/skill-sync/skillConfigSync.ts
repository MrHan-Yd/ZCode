import { mkdir, readFile, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { CredentialServiceAccess } from "../credential/credential.js";
import { SKILL_FILE_NAME, shouldWalkSkillDirectoryEntry } from "@zcode/shared";
import { getAppConfigDir } from "../paths.js";
import { createConfigSyncBackup } from "../config-sync/backup.js";
import { createConfigSyncMetadataStore } from "../config-sync/metadata.js";
import {
  createConfigSync,
  type ConfigSyncAdapter,
  type ConfigSyncOperations,
} from "../config-sync/orchestrator.js";
import {
  resolveConfigSyncScope,
  scopeBackupDirName,
  scopeGistDescription,
} from "../config-sync/scope.js";
import type { ConfigSyncItem, ConfigSyncSnapshot } from "../config-sync/types.js";
import { MAX_SKILL_SCAN_DEPTH, walkSkillMarkdownPaths } from "../skills/skillDiscoveryWalk.js";
import {
  SKILL_CONFIG_GIST_DESCRIPTION,
  SKILL_CONFIG_PROFILE,
  decodeSkillSyncItemContent,
  encodeSkillSyncItemContent,
  validateSkillSyncGroups,
} from "./skillConfigSyncModel.js";
import { normalizeSkillNameKey, parseSkillSyncMetadata } from "./skillSyncMetadata.js";
import { resolveSkillSyncPathWithin } from "./skillSyncPath.js";

/**
 * 技能目录 ↔ 私有 gist 的同步：通用编排在 `config-sync/orchestrator.ts`，
 * 这里只描述「条目 = 技能目录里的一个文件」这条业务语义。
 */

/** 读取根（ZCode 优先，agents 兜底）与写入根。 */
export interface SkillSyncRoots {
  readonly readRoots: readonly string[];
  readonly writeRoot: string;
}

export function resolveSkillSyncRoots(params: {
  readonly homeDir: string;
  readonly workspacePath?: string;
}): SkillSyncRoots {
  const workspacePath = params.workspacePath?.trim();
  if (workspacePath) {
    return {
      readRoots: [
        join(workspacePath, ".zcode", "skills"),
        join(workspacePath, ".agents", "skills"),
      ],
      writeRoot: join(workspacePath, ".zcode", "skills"),
    };
  }
  return {
    readRoots: [
      join(params.homeDir, ".zcode", "skills"),
      join(params.homeDir, ".agents", "skills"),
    ],
    writeRoot: join(params.homeDir, ".zcode", "skills"),
  };
}

export interface CreateSkillConfigSyncOptions {
  readonly roots: () => SkillSyncRoots;
  /** 给出即工作区级；只用于推导 gist description / 元数据分片 / 备份子目录。 */
  readonly workspacePath?: string;
  readonly dataDir?: () => Promise<string>;
  readonly credentialService?: CredentialServiceAccess;
  readonly fetchImpl?: typeof fetch;
  readonly enqueueWrite: <T>(run: () => Promise<T>) => Promise<T>;
  readonly now?: () => number;
}

export function createSkillConfigSync(options: CreateSkillConfigSyncOptions): ConfigSyncOperations {
  const dataDir = options.dataDir ?? (async () => getAppConfigDir());
  const scope = resolveConfigSyncScope(options.workspacePath);
  const adapter: ConfigSyncAdapter = {
    gistDescription: scopeGistDescription(SKILL_CONFIG_GIST_DESCRIPTION, scope),
    ...(scope.kind === "workspace" ? { scopeLabel: scope.label } : {}),
    profile: SKILL_CONFIG_PROFILE,
    metadata: createConfigSyncMetadataStore(
      async () => join(await dataDir(), "skill-config-sync.json"),
      scope,
    ),
    backup: createConfigSyncBackup({
      rootDir: async () =>
        join(await dataDir(), "skill-config-sync-backup", scopeBackupDirName(scope)),
      entries: async () => [{ source: options.roots().writeRoot, name: "skills" }],
    }),
    collectSnapshot: () => collectSkillSnapshot(options.roots()),

    async apply({ writes, removals, remoteItems }) {
      const invalidGroup = validateSkillSyncGroups(remoteItems);
      if (invalidGroup) {
        throw new Error(`远端技能缺少 ${SKILL_FILE_NAME}: ${invalidGroup}`);
      }
      await writeSkillFiles(options.roots().writeRoot, writes);
      await removeSkillFiles(options.roots().writeRoot, removals);
    },

    countBackupItems: countSkillBackupItems,
  };

  return createConfigSync({
    adapter,
    credentialService: options.credentialService,
    fetchImpl: options.fetchImpl,
    enqueueWrite: options.enqueueWrite,
    ...(options.now ? { now: options.now } : {}),
  });
}

interface SkillCandidate {
  readonly directoryName: string;
  readonly directoryPath: string;
}

async function collectSkillSnapshot(roots: SkillSyncRoots): Promise<ConfigSyncSnapshot> {
  const candidates = await collectSkillCandidates(roots.readRoots);
  const candidateItemPrefixes = new Set(candidates.map((candidate) => candidate.directoryName));
  const items: ConfigSyncItem[] = [];
  const skippedLocalFiles: string[] = [];

  for (const candidate of candidates) {
    await collectSkillFiles({
      directoryPath: candidate.directoryPath,
      itemPrefix: candidate.directoryName,
      candidateItemPrefixes,
      items,
      skippedLocalFiles,
    });
  }

  items.sort((left, right) => left.name.localeCompare(right.name));
  skippedLocalFiles.sort();
  return { items, extras: [], skippedLocalFiles };
}

async function collectSkillCandidates(
  readRoots: readonly string[],
): Promise<readonly SkillCandidate[]> {
  const seenDirectoryNames = new Set<string>();
  const seenSkillNameKeys = new Set<string>();
  const candidates: SkillCandidate[] = [];

  for (const root of readRoots) {
    for await (const skillFilePath of walkSkillMarkdownPaths(root)) {
      const directoryPath = dirname(skillFilePath);
      const directoryName = relative(root, directoryPath).replaceAll("\\", "/");
      if (!directoryName) continue;
      const content = await readFileOrNull(skillFilePath);
      if (content === null) continue;
      const metadata = parseSkillSyncMetadata(content, basename(directoryPath));
      const nameKey = normalizeSkillNameKey(metadata.name);
      if (seenDirectoryNames.has(directoryName) || seenSkillNameKeys.has(nameKey)) {
        continue;
      }
      seenDirectoryNames.add(directoryName);
      seenSkillNameKeys.add(nameKey);
      candidates.push({ directoryName, directoryPath });
    }
  }

  return candidates;
}

async function collectSkillFiles(params: {
  readonly directoryPath: string;
  readonly itemPrefix: string;
  readonly candidateItemPrefixes: ReadonlySet<string>;
  readonly items: ConfigSyncItem[];
  readonly skippedLocalFiles: string[];
}): Promise<void> {
  const stack: Array<{ directoryPath: string; itemPrefix: string; depth: number }> = [
    { directoryPath: params.directoryPath, itemPrefix: params.itemPrefix, depth: 0 },
  ];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = await readdir(current.directoryPath, { withFileTypes: true });
    } catch {
      params.skippedLocalFiles.push(current.itemPrefix);
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!shouldWalkSkillDirectoryEntry(entry.name)) continue;
      const entryPath = join(current.directoryPath, entry.name);
      const itemName = `${current.itemPrefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        // 软链可能指向技能根之外；不把它的内容写进 gist。
        params.skippedLocalFiles.push(itemName);
        continue;
      }
      if (entry.isDirectory()) {
        // 嵌套技能目录是独立候选，父技能的枚举不能把它一起打包。
        if (params.candidateItemPrefixes.has(itemName)) continue;
        if (current.depth >= MAX_SKILL_SCAN_DEPTH) {
          params.skippedLocalFiles.push(itemName);
          continue;
        }
        stack.push({ directoryPath: entryPath, itemPrefix: itemName, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) {
        params.skippedLocalFiles.push(itemName);
        continue;
      }
      const buffer = await readFile(entryPath).catch(() => null);
      if (buffer === null) {
        params.skippedLocalFiles.push(itemName);
        continue;
      }
      if (buffer.byteLength > SKILL_CONFIG_PROFILE.maxFileBytes) {
        params.skippedLocalFiles.push(itemName);
        continue;
      }
      params.items.push({ name: itemName, content: encodeSkillSyncItemContent(buffer) });
    }
  }
}

async function writeSkillFiles(writeRoot: string, items: readonly ConfigSyncItem[]): Promise<void> {
  for (const item of items) {
    const targetPath = resolveWritePath(writeRoot, item.name);
    const content = decodeSkillSyncItemContent(item.content);
    if (!content) {
      throw new Error(`技能文件内容无法解码: ${item.name}`);
    }
    await mkdir(dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
  }
}

async function removeSkillFiles(writeRoot: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    const targetPath = resolveWritePath(writeRoot, name);
    await rm(targetPath, { force: true });
    await pruneEmptyDirectories(writeRoot, dirname(targetPath));
  }
}

function resolveWritePath(writeRoot: string, itemName: string): string {
  // 复用既有路径守卫：拒绝 `..`、绝对路径、盘符、反斜杠与空段。
  return resolveSkillSyncPathWithin(writeRoot, itemName, {
    unsafePathLabel: "unsafe skill sync path",
  });
}

async function pruneEmptyDirectories(root: string, start: string): Promise<void> {
  let current = start;
  const resolvedRoot = join(root);
  while (current !== resolvedRoot && current.startsWith(resolvedRoot)) {
    try {
      await rmdir(current);
    } catch {
      return;
    }
    current = dirname(current);
  }
}

async function countSkillBackupItems(backupDir: string): Promise<number | null> {
  try {
    return await countFiles(join(backupDir, "skills"));
  } catch {
    return null;
  }
}

async function countFiles(directoryPath: string): Promise<number> {
  let count = 0;
  const stack = [directoryPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        count += 1;
      }
    }
  }
  return count;
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
