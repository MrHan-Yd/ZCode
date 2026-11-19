import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import test from "node:test";
import type { SubagentPort } from "@zcode/contracts";
import { NodeOrchestrationArtifactStorage } from "../../adapters/src/orchestration/artifacts.js";
import { NodeOrchestrationJournal } from "../../adapters/src/orchestration/journal.js";
import { OrchestrationRunStore } from "../src/orchestration/runStore.js";
import { OrchestrationService } from "../src/orchestration/service.js";
import { parseStoredOrchestrationConfig } from "../src/orchestration/session-config.js";
import {
  orchestrationOwner,
  orchestrationPlan,
  orchestrationStep,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

const TEAM = ["general-purpose", "tester"] as const;
const WRITABLE_ROLES = ["general-purpose", "tester"] as const;
const SHA256 = "a".repeat(64);

function stubSubagents(): SubagentPort {
  return {} as SubagentPort;
}

function serviceFor(
  directory: string,
  owner: ReturnType<typeof orchestrationOwner>,
): OrchestrationService {
  return new OrchestrationService({
    sessionId: owner.sessionId,
    owner,
    journal: new NodeOrchestrationJournal({ rootDirectory: directory, owner }),
    artifactStorage: new NodeOrchestrationArtifactStorage({ rootDirectory: directory, owner }),
    subagents: stubSubagents(),
    team: [...TEAM],
    notify: () => {},
  });
}

test("cold restore marks live attempts interrupted and keeps completed steps", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const owner = orchestrationOwner(directory);
    const journal = new NodeOrchestrationJournal({ rootDirectory: directory, owner });
    const store = new OrchestrationRunStore({ owner, journal });
    const plan = orchestrationPlan([
      orchestrationStep({ stepId: "done", role: "tester", writeScope: ["src"] }),
      orchestrationStep({
        stepId: "live",
        role: "general-purpose",
        dependsOn: ["done"],
        writeScope: ["src"],
      }),
    ]);
    await store.create({
      runId: "fixture-run",
      plan,
      team: [...TEAM],
      writableRoles: [...WRITABLE_ROLES],
    });

    const first = (await store.claim("fixture-run"))[0];
    assert.ok(first, "the first runnable step should be claimed");
    await store.finish("fixture-run", first.attempt.key, 0, {
      status: "completed",
      artifact: {
        artifactId: SHA256,
        attemptKey: first.attempt.key,
        uri: "orchestration-artifact://fixture-run/done",
        summary: "done",
        originalBytes: 4,
        savedBytes: 4,
        sha256: SHA256,
        truncated: false,
        summaryTruncated: false,
      },
    });
    const claims = await store.claim("fixture-run");
    assert.equal(claims.length, 1, "the dependent step should start after completion");
    const live = claims[0];
    assert.ok(live);

    // 新 service 模拟进程重启后的冷恢复；completed 步骤不能重跑，在飞 attempt 必须收口。
    const restored = serviceFor(directory, owner);
    const report = await restored.restore();
    assert.deepEqual(report, { records: 1, interrupted: 1, invalidRecords: 0 });

    const record = await restored.get("fixture-run");
    assert.ok(record);
    assert.equal(record.status, "interrupted");
    assert.equal(record.state.steps.done?.status, "completed");
    assert.equal(record.state.steps.live?.status, "interrupted");
    const liveAttempt = record.attempts.find((attempt) => attempt.key === live.attempt.key);
    assert.equal(liveAttempt?.status, "interrupted");
    assert.equal(record.events.at(-1)?.type, "run_interrupted");
    assert.equal(record.state.generation, 1);
  });
});

test("cold restore keeps terminal runs untouched and reports corrupted snapshots", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const owner = orchestrationOwner(directory);
    const journal = new NodeOrchestrationJournal({ rootDirectory: directory, owner });
    const store = new OrchestrationRunStore({ owner, journal });
    await store.create({
      runId: "terminal-run",
      plan: orchestrationPlan([
        orchestrationStep({ stepId: "only", role: "tester", writeScope: ["src"] }),
      ]),
      team: [...TEAM],
      writableRoles: [...WRITABLE_ROLES],
    });
    const claim = (await store.claim("terminal-run"))[0];
    assert.ok(claim);
    await store.finish("terminal-run", claim.attempt.key, 0, {
      status: "completed",
      artifact: {
        artifactId: SHA256,
        attemptKey: claim.attempt.key,
        uri: "orchestration-artifact://terminal-run/only",
        summary: "done",
        originalBytes: 4,
        savedBytes: 4,
        sha256: SHA256,
        truncated: false,
        summaryTruncated: false,
      },
    });

    const corruptPath = journal.filePath("corrupt-run");
    await mkdir(dirname(corruptPath), { recursive: true });
    await writeFile(corruptPath, "{not-json", "utf8");

    const restored = serviceFor(directory, owner);
    const report = await restored.restore();
    assert.deepEqual(report, { records: 1, interrupted: 0, invalidRecords: 1 });
    const record = await restored.get("terminal-run");
    assert.equal(record?.status, "completed");
    assert.equal(record?.state.generation, 0);

    // 恢复只读一次；重复调用不会重复解析或重复改写 journal。
    assert.deepEqual(await restored.restore(), report);
  });
});

test("restore tolerates journals without a listing capability", async () => {
  const owner = orchestrationOwner("/virtual");
  const restored = new OrchestrationService({
    sessionId: owner.sessionId,
    owner,
    journal: { transaction: () => Promise.reject(new Error("unused")) },
    artifactStorage: {
      write: () => Promise.reject(new Error("unused")),
      read: () => Promise.reject(new Error("unused")),
    },
    subagents: stubSubagents(),
    notify: () => {},
  });
  assert.deepEqual(await restored.restore(), {
    records: 0,
    interrupted: 0,
    invalidRecords: 0,
  });
  assert.deepEqual(restored.listRuns(), []);
});

test("stored orchestration config fails closed on malformed entries", () => {
  assert.deepEqual(parseStoredOrchestrationConfig({ enabled: true, team: ["tester"] }), {
    enabled: true,
    team: ["tester"],
  });
  assert.deepEqual(
    parseStoredOrchestrationConfig({ enabled: false, team: [], maxConcurrency: 2 }),
    { enabled: false, team: [], maxConcurrency: 2 },
  );
  for (const invalid of [
    undefined,
    null,
    "enabled",
    [],
    { enabled: "yes" },
    { enabled: true, team: "tester" },
    { enabled: true, team: [1] },
    { enabled: true, maxConcurrency: 0 },
    { enabled: true, maxConcurrency: 1.5 },
    { enabled: true, maxConcurrency: 99 },
  ]) {
    assert.equal(parseStoredOrchestrationConfig(invalid), undefined);
  }
});
