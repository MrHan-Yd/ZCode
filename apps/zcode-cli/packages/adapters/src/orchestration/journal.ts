import {
  assertOrchestrationOwner,
  OrchestrationStoreError,
  parseOrchestrationRunRecord,
  type OrchestrationJournalPort,
  type OrchestrationJournalUpdate,
  type OrchestrationRunOwner,
  type OrchestrationRunRecord,
} from "@zcode/contracts";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { OrchestrationStoragePaths, readOrchestrationJson } from "./paths.js";

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
