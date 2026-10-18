import { access, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { describeRequestError } from "#src/http/describeRequestError.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ConfigSyncBackupDirList } from "./types.js";

/**
 * 应用前的本地备份、失败回滚与用户主动还原。
 *
 * 一次同步要写多个文件（子智能体：多个 md + state；MCP：一份配置），没有全局原子写，
 * 所以宁可「先备份再写、失败回滚」，也不靠重试掩盖半完成状态。
 * 备份同时是「下载后悔了」的还原来源，因此保留策略要兼顾份数与时间。
 */

const log = createServiceLogger("configSync");

const DEFAULT_MAX_BACKUPS = 10;
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface ConfigSyncBackupEntry {
  /** 要备份的绝对路径（目录或文件）。 */
  readonly source: string;
  /** 备份目录内的相对名。 */
  readonly name: string;
}

export interface ConfigSyncBackup {
  /** 备份并返回备份目录；备份本身失败会抛出，由调用方中止本次应用。 */
  create(): Promise<string>;
  /** 把本地文件恢复成指定备份的样子；返回是否成功。 */
  restore(backupDir: string): Promise<boolean>;
  /** 列出可用备份（新的在前）；只列包含全部声明条目的目录，坏备份不展示。 */
  list(): Promise<ConfigSyncBackupDirList>;
}

export function createConfigSyncBackup(options: {
  /** 备份根目录（各功能独立，避免互相清理）；路径解析是异步的，因此传解析函数。 */
  readonly rootDir: () => Promise<string>;
  readonly entries: () => Promise<readonly ConfigSyncBackupEntry[]>;
  readonly maxBackups?: number;
  readonly maxAgeMs?: number;
}): ConfigSyncBackup {
  const maxBackups = options.maxBackups ?? DEFAULT_MAX_BACKUPS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;

  return {
    async create() {
      const rootDir = await options.rootDir();
      const backupDir = join(rootDir, String(Date.now()));
      await mkdir(backupDir, { recursive: true });
      for (const entry of await options.entries()) {
        if (!(await exists(entry.source))) continue;
        await cp(entry.source, join(backupDir, entry.name), { recursive: true });
      }
      await pruneBackups(rootDir, maxBackups, maxAgeMs);
      return backupDir;
    },

    async restore(backupDir) {
      try {
        for (const entry of await options.entries()) {
          const backupPath = join(backupDir, entry.name);
          if (!(await exists(backupPath))) continue;
          const backupStat = await stat(backupPath);
          if (backupStat.isDirectory()) {
            await rm(entry.source, { recursive: true, force: true });
            await cp(backupPath, entry.source, { recursive: true });
            continue;
          }
          await mkdir(dirname(entry.source), { recursive: true });
          await cp(backupPath, entry.source);
        }
        return true;
      } catch (error) {
        log.warn(undefined, "config sync rollback failed", describeRequestError(error));
        return false;
      }
    },

    async list(): Promise<ConfigSyncBackupDirList> {
      const rootDir = await options.rootDir();
      const entries = await options.entries();
      const names = await readdir(rootDir).catch(() => []);
      const backups = [];
      for (const name of names) {
        const backupDir = join(rootDir, name);
        if (!(await isCompleteBackup(backupDir, entries))) continue;
        backups.push({ backupDir, createdAt: Number(name) });
      }
      // 目录名是 Date.now() 字符串，字典序即时间序；新的在前。
      backups.sort((left, right) => right.backupDir.localeCompare(left.backupDir));
      return { backupRoot: rootDir, backups };
    },
  };
}

/** 还原请求必须指向真实存在且完整的备份，避免任意路径被当成「备份」拷回本地配置。 */
export async function isKnownBackupDir(
  backup: ConfigSyncBackup,
  backupDir: string,
): Promise<boolean> {
  const { backups } = await backup.list();
  const target = resolve(backupDir);
  return backups.some((entry) => resolve(entry.backupDir) === target);
}

async function isCompleteBackup(
  dir: string,
  entries: readonly ConfigSyncBackupEntry[],
): Promise<boolean> {
  const dirStat = await stat(dir).catch(() => undefined);
  if (!dirStat?.isDirectory()) return false;
  for (const entry of entries) {
    if (!(await exists(join(dir, entry.name)))) return false;
  }
  return true;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 同时按份数与时间清理：超出份数上限或过旧的备份都删掉。 */
async function pruneBackups(rootDir: string, maxBackups: number, maxAgeMs: number): Promise<void> {
  const names = (await readdir(rootDir).catch(() => [])).sort();
  const now = Date.now();
  for (const [index, name] of names.entries()) {
    const createdAt = Number(name);
    const beyondCount = names.length - index > maxBackups;
    const expired = Number.isFinite(createdAt) && now - createdAt > maxAgeMs;
    if (!beyondCount && !expired) continue;
    await rm(join(rootDir, name), { recursive: true, force: true }).catch(() => {});
  }
}
