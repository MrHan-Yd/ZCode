import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import {
  createOrchestrationAttemptKey,
  parseOrchestrationRunRecord,
  type OrchestrationRunRecord,
} from "@zcode/contracts";
import { NodeOrchestrationJournal } from "../../adapters/src/orchestration/journal.js";
import { NodeOrchestrationArtifactStorage } from "../../adapters/src/orchestration/artifacts.js";
import { OrchestrationRunStore } from "../src/orchestration/runStore.js";
import { OrchestrationArtifacts } from "../src/orchestration/artifacts.js";
import {
  orchestrationInput,
  orchestrationOwner,
  orchestrationPlan,
  orchestrationStep,
  orchestrationError,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

async function setup(directory: string) {
  const owner = orchestrationOwner(directory);
  const journal = new NodeOrchestrationJournal({ rootDirectory: directory, owner });
  const store = new OrchestrationRunStore({ owner, journal, now: () => 1_000 });
  const artifacts = new OrchestrationArtifacts({
    storage: new NodeOrchestrationArtifactStorage({ rootDirectory: directory, owner }),
  });
  return { store, journal, artifacts };
}

test("损坏记录不能把无依赖且未执行的 optional root 标 blocked 后当作 completed", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store, journal } = await setup(directory);
    const created = await store.create(
      orchestrationInput(
        orchestrationPlan([orchestrationStep({ stepId: "root", optional: true })]),
      ),
    );
    const record: OrchestrationRunRecord = {
      ...created,
      status: "completed",
      state: {
        ...created.state,
        steps: { root: { stepId: "root", status: "blocked", attempts: 0, endedAt: 1_000 } },
      },
    };
    assert.throws(() => parseOrchestrationRunRecord(record), orchestrationError("invalid_record"));
    await writeFile(journal.filePath(record.runId), JSON.stringify(record), "utf8");
    await assert.rejects(store.recover(record.runId), orchestrationError("invalid_record"));
  });
});

for (const priorStatus of ["completed", "cancelled", "interrupted"] as const) {
  test(`损坏记录不能在 ${priorStatus} 后重试同一步并伪造成功`, async () => {
    await withOrchestrationDirectory(async (directory) => {
      const { store, artifacts } = await setup(directory);
      const created = await store.create(orchestrationInput());
      const key1 = createOrchestrationAttemptKey(created.runId, 0, 0, "first", 1);
      const key2 = createOrchestrationAttemptKey(created.runId, 0, 0, "first", 2);
      const artifact1 = await artifacts.save(key1, "first result");
      const artifact2 = await artifacts.save(key2, "second result");
      const eventType =
        priorStatus === "completed"
          ? "attempt_completed"
          : priorStatus === "cancelled"
            ? "attempt_cancelled"
            : "run_interrupted";
      const record: OrchestrationRunRecord = {
        ...created,
        status: "completed",
        state: {
          ...created.state,
          updatedAt: 1_004,
          steps: {
            first: {
              stepId: "first",
              status: "completed",
              attempts: 2,
              startedAt: 1_003,
              endedAt: 1_004,
            },
          },
        },
        attempts: [
          {
            key: key1,
            revision: 0,
            generation: 0,
            stepId: "first",
            attempt: 1,
            status: priorStatus,
            startedAt: 1_001,
            endedAt: 1_002,
            ...(priorStatus === "completed" ? { artifact: artifact1 } : {}),
          },
          {
            key: key2,
            revision: 0,
            generation: 0,
            stepId: "first",
            attempt: 2,
            status: "completed",
            startedAt: 1_003,
            endedAt: 1_004,
            artifact: artifact2,
          },
        ],
        events: [
          ...created.events,
          { sequence: 2, type: "attempt_claimed", generation: 0, at: 1_001, attemptKey: key1 },
          { sequence: 3, type: eventType, generation: 0, at: 1_002, attemptKey: key1 },
          { sequence: 4, type: "attempt_claimed", generation: 0, at: 1_003, attemptKey: key2 },
          { sequence: 5, type: "attempt_completed", generation: 0, at: 1_004, attemptKey: key2 },
        ],
      };
      assert.throws(
        () => parseOrchestrationRunRecord(record),
        orchestrationError("invalid_record"),
      );
    });
  });
}
