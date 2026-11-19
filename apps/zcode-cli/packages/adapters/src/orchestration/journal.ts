import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertOrchestrationOwner,
  OrchestrationStoreError,
  parseOrchestrationRunRecord,
  type OrchestrationJournalListing,
  type OrchestrationJournalPort,
  type OrchestrationJournalUpdate,
  type OrchestrationRunOwner,
  type OrchestrationRunRecord,
} from "@zcode/contracts";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { OrchestrationStoragePaths, isMissingFile, readOrchestrationJson } from "./paths.js";

/**
 * 冷恢复每次最多读多少条快照。run 目录按 owner/session 隔离，正常量级远低于此；
 * 上限只防长寿命会话把无界历史读成启动抖动。截断取 mtime 最新的若干条。
 */
const RESTORE_SCAN_LIMIT = 512;
const RESTORE_RECORD_LIMIT = 32;

export class NodeOrchestrationJournal implements OrchestrationJournalPort {
  private readonly paths: OrchestrationStoragePaths;

  constructor(options: { rootDirectory: string; owner: OrchestrationRunOwner }) {
    this.paths = new OrchestrationStoragePaths(options);
  }

  filePath(runId: string): string {
    return this.paths.file("runs", runId);
  }

  async transaction<T>(
    runId: string,
    update: (current: OrchestrationRunRecord | undefined) => OrchestrationJournalUpdate<T>,
  ): Promise<T> {
    const filePath = this.filePath(runId);
    await this.paths.prepare(filePath);
    return withFileLock(filePath, async () => {
      await this.paths.prepare(filePath);
      const raw = await readOrchestrationJson(filePath);
      const current = raw === undefined ? undefined : this.validate(raw, runId);
      const next = update(current);
      if (next.record) {
        const record = this.validate(next.record, runId);
        await atomicWritePrivateTextFile(filePath, JSON.stringify(record));
      }
      return next.value;
    });
  }

  /**
   * 冷恢复清单：只读、不加锁。运行中的写入由原子替换保证「要么旧快照要么新快照」，
   * 因此不需要为列表阻塞持锁写入；随后真正要推进的 run 由 recover 走正常事务。
   */
  async list(): Promise<OrchestrationJournalListing> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.paths.runsDirectory, { withFileTypes: true });
    } catch (error) {
      if (isMissingFile(error)) return { records: [], invalidRecords: 0 };
      throw error;
    }
    const candidates: { filePath: string; modifiedAt: number }[] = [];
    for (const entry of entries) {
      // symlink / junction 不参与恢复：readdir 的 dirent 已是链接本身，不跟随根外目标。
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = join(this.paths.runsDirectory, entry.name);
      try {
        const stat = await lstat(filePath);
        if (!stat.isFile()) continue;
        candidates.push({ filePath, modifiedAt: stat.mtimeMs });
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    }
    candidates.sort((left, right) => right.modifiedAt - left.modifiedAt);
    const records: OrchestrationRunRecord[] = [];
    let invalidRecords = 0;
    for (const candidate of candidates.slice(0, Math.min(RESTORE_RECORD_LIMIT, RESTORE_SCAN_LIMIT))) {
      try {
        const raw = await readOrchestrationJson(candidate.filePath);
        if (raw === undefined) continue;
        const record = parseOrchestrationRunRecord(raw);
        assertOrchestrationOwner(record.owner, this.paths.owner);
        records.push(record);
      } catch {
        // 损坏 / 版本未知 / owner 不匹配：计数交给上层落日志，不删除原文件，
        // 也不把该 run 当成空记录参与调度。
        invalidRecords += 1;
      }
    }
    return { records, invalidRecords };
  }

  private validate(value: unknown, runId: string): OrchestrationRunRecord {
    const record = parseOrchestrationRunRecord(value);
    assertOrchestrationOwner(record.owner, this.paths.owner);
    if (record.runId !== runId) {
      throw new OrchestrationStoreError(
        "run_conflict",
        "Orchestration snapshot has a different run identity.",
      );
    }
    return record;
  }
}
