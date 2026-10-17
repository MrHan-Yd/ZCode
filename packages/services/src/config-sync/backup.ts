import { access, cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describeRequestError } from "#src/http/describeRequestError.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";

/**
 * 应用前的本地备份与失败回滚。
 *
 * 一次同步要写多个文件（子智能体：多个 md + state；MCP：一份配置），没有全局原子写，
 * 所以宁可「先备份再写、失败回滚」，也不靠重试掩盖半完成状态。
 */

const log = createServiceLogger("configSync");

const DEFAULT_MAX_BACKUPS = 3;

export interface ConfigSyncBackupEntry {
  /** 要备份的绝对路径（目录或文件）。 */
  readonly source: string;
  /** 备份目录内的相对名。 */
  readonly name: string;
}

export interface ConfigSyncBackup {
  /** 备份并返回备份目录；备份本身失败会抛出，由调用方中止本次应用。 */
  create(): Promise<string>;
  /** 回滚；返回是否成功（源不存在视为无需回滚，不算失败）。 */
  restore(backupDir: string): Promise<boolean>;
}

export function createConfigSyncBackup(options: {
  /** 备份根目录（各功能独立，避免互相清理）；路径解析是异步的，因此传解析函数。 */
  readonly rootDir: () => Promise<string>;
  readonly entries: () => Promise<readonly ConfigSyncBackupEntry[]>;
  readonly maxBackups?: number;
}): ConfigSyncBackup {
  const maxBackups = options.maxBackups ?? DEFAULT_MAX_BACKUPS;

  return {
    async create() {
      const rootDir = await options.rootDir();
      const backupDir = join(rootDir, String(Date.now()));
      await mkdir(backupDir, { recursive: true });
      for (const entry of await options.entries()) {
        if (!(await exists(entry.source))) continue;
        await cp(entry.source, join(backupDir, entry.name), { recursive: true });
      }
      await pruneBackups(rootDir, maxBackups);
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
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 目录名是 `Date.now()` 字符串，字典序即时间序；只留最近 maxBackups 份。 */
async function pruneBackups(rootDir: string, maxBackups: number): Promise<void> {
  const entries = await readdir(rootDir).catch(() => []);
  for (const name of entries.sort().slice(0, Math.max(0, entries.length - maxBackups))) {
    await rm(join(rootDir, name), { recursive: true, force: true }).catch(() => {});
  }
}
