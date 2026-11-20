import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type {
  ClaimedOrchestrationAttempt,
  OrchestrationJournalPort,
  OrchestrationJournalUpdate,
  OrchestrationRunRecord,
} from "@zcode/contracts";
import { OrchestrationRunStore } from "../src/orchestration/runStore.js";
import {
  orchestrationClock,
  orchestrationInput,
  orchestrationOwner,
  orchestrationPlan,
  orchestrationStep,
  singleOrchestrationClaim,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

class RevisionTestJournal implements OrchestrationJournalPort {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly directory: string) {}

  filePath(runId: string): string {
    return join(this.directory, `${createHash("sha256").update(runId).digest("hex")}.json`);
  }

  transaction<T>(
    runId: string,
    update: (record: OrchestrationRunRecord | undefined) => OrchestrationJournalUpdate<T>,
  ): Promise<T> {
    const operation = this.tail.then(async () => {
      let current: OrchestrationRunRecord | undefined;
      try {
        current = JSON.parse(
          await readFile(this.filePath(runId), "utf8"),
        ) as OrchestrationRunRecord;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
      const next = update(current);
      if (next.record) await writeFile(this.filePath(runId), JSON.stringify(next.record), "utf8");
      return next.value;
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

function setup(directory: string) {
  const owner = orchestrationOwner(directory);
  const journal = new RevisionTestJournal(directory);
  const store = new OrchestrationRunStore({ owner, journal, now: orchestrationClock() });
  return { owner, journal, store };
}

async function complete(context: ReturnType<typeof setup>, claim: ClaimedOrchestrationAttempt) {
  const content = `Output ${claim.step.stepId}`;
  const artifact = {
    artifactId: claim.attempt.key,
    attemptKey: claim.attempt.key,
    uri: `artifact:${claim.attempt.key}`,
    summary: content,
    originalBytes: Buffer.byteLength(content),
    savedBytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
    truncated: false,
    summaryTruncated: false,
  };
  assert.equal(
    await context.store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
      status: "completed",
      artifact,
    }),
    true,
  );
  return artifact;
}

test("原地修订：保留 completed 产物和 running 身份，只失效改变的工作", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = setup(directory);
    const original = orchestrationPlan([
      orchestrationStep({ stepId: "done" }),
      orchestrationStep({ stepId: "retained", dependsOn: ["done"] }),
      orchestrationStep({ stepId: "changed", dependsOn: ["done"] }),
    ]);
    await context.store.create(orchestrationInput(original, { generation: 7, maxConcurrency: 2 }));
    const artifact = await complete(
      context,
      singleOrchestrationClaim(await context.store.claim("fixture-run")),
    );
    const claims = await context.store.claim("fixture-run");
    const retained = claims.find((claim) => claim.step.stepId === "retained");
    const changed = claims.find((claim) => claim.step.stepId === "changed");
    assert.ok(retained && changed);
    const child = {
      agentId: "retained-agent",
      taskId: "retained-task",
      childSessionId: "retained-child",
    };
    await context.store.bindChild(retained.runId, retained.attempt.key, child);
    const before = await context.store.get("fixture-run");
    assert.ok(before);
    const plan = structuredClone(original);
    plan.revision += 1;
    plan.steps[2]!.task = "Use the revised contract";
    const revised = await context.store.revise({ runId: "fixture-run", expectedRevision: 0, plan });
    assert.equal(revised.record.runId, before.runId);
    assert.equal(revised.record.version, 1);
    assert.equal(revised.record.state.generation, 7);
    assert.equal(revised.record.state.steps.done?.generation, 7);
    assert.equal(revised.record.state.steps.retained?.generation, 7);
    assert.equal(revised.record.state.steps.changed?.generation, 8);
    assert.equal(revised.record.state.steps.changed?.attempts, 0);
    assert.equal(revised.record.state.steps.changed?.status, "pending");
    assert.deepEqual(revised.record.attempts[0]?.artifact, artifact);
    assert.deepEqual(revised.record.attempts[1], before.attempts[1]);
    assert.deepEqual(revised.invalidatedAttemptKeys, [changed.attempt.key]);
    assert.equal(revised.record.attempts[2]?.status, "cancelled");
    assert.equal(revised.record.attempts[2]?.cancellationPending, true);
    assert.deepEqual(revised.record.events.slice(0, before.events.length), before.events);
    assert.deepEqual(revised.record.events.at(-1), {
      sequence: before.events.at(-1)!.sequence + 1,
      type: "plan_revised",
      generation: 7,
      at: revised.record.state.updatedAt,
      previousPlan: original,
      plan,
    });
    assert.equal(await context.store.bindChild(retained.runId, retained.attempt.key, child), false);
    await complete(context, retained);
    assert.deepEqual(await context.store.claim("fixture-run"), []);
    assert.equal(
      await context.store.confirmAttemptQuiesced("fixture-run", changed.attempt.key),
      true,
    );
    const replacement = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    assert.equal(replacement.attempt.revision, 1);
    assert.equal(replacement.attempt.generation, 8);
    assert.equal(replacement.attempt.attempt, 1);
    assert.notEqual(replacement.attempt.key, changed.attempt.key);
    assert.equal(
      await context.store.finish(changed.runId, changed.attempt.key, changed.attempt.generation, {
        status: "failed",
        error: "Late old outcome",
      }),
      false,
    );
    await complete(context, replacement);
    const finished = await context.store.get("fixture-run");
    assert.ok(finished);
    assert.equal(finished.status, "completed");
    assert.deepEqual(await setup(directory).store.get("fixture-run"), finished);
    assert.deepEqual(
      JSON.parse(await readFile(context.journal.filePath("fixture-run"), "utf8")),
      finished,
    );
  });
});

test("展示与等价默认值修订：标题、顺序、goal、规范 scope 不重启 child", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = setup(directory);
    const original = orchestrationPlan([
      orchestrationStep({ stepId: "first", role: "backend", writeScope: ["SRC/**", "src/file"] }),
      orchestrationStep({ stepId: "second", dependsOn: ["first"], inputs: "auto" }),
    ]);
    await context.store.create(orchestrationInput(original, { generation: 4 }));
    const first = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    const plan = structuredClone(original);
    plan.revision = 1;
    plan.goal = "A clearer display goal";
    plan.steps[0] = {
      ...plan.steps[0]!,
      title: "Renamed",
      maxAttempts: 1,
      optional: false,
      writeScope: ["other/../src"],
    };
    delete plan.steps[1]!.inputs;
    plan.steps.reverse();
    const revised = await context.store.revise({ runId: "fixture-run", expectedRevision: 0, plan });
    assert.deepEqual(revised.invalidatedAttemptKeys, []);
    assert.equal(revised.record.state.steps.first?.generation, 4);
    assert.equal(revised.record.state.steps.second?.generation, 4);
    assert.deepEqual(revised.record.attempts[0], first.attempt);
    const child = { agentId: "late-retained", taskId: "late-retained-task" };
    assert.equal(await context.store.bindChild(first.runId, first.attempt.key, child), true);
    await complete(context, first);
    const second = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    assert.equal(second.attempt.revision, 1);
    assert.equal(second.attempt.generation, 4);
    await complete(context, second);
    assert.equal((await context.store.get("fixture-run"))?.status, "completed");
  });
});

test("依赖失效：旧新后继闭包重做，removed 历史和原始产物不改写", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = setup(directory);
    const original = orchestrationPlan([
      orchestrationStep({ stepId: "root" }),
      orchestrationStep({ stepId: "middle", dependsOn: ["root"] }),
      orchestrationStep({ stepId: "leaf", dependsOn: ["middle"] }),
      orchestrationStep({ stepId: "retained" }),
    ]);
    await context.store.create(orchestrationInput(original, { maxConcurrency: 1 }));
    for (let index = 0; index < original.steps.length; index += 1) {
      await complete(context, singleOrchestrationClaim(await context.store.claim("fixture-run")));
    }
    const before = await context.store.get("fixture-run");
    assert.ok(before);
    const plan = orchestrationPlan(
      [
        orchestrationStep({ stepId: "added" }),
        orchestrationStep({ stepId: "middle", dependsOn: ["added"] }),
        orchestrationStep({ stepId: "leaf", dependsOn: ["middle"] }),
        orchestrationStep({ stepId: "retained" }),
      ],
      { revision: 1 },
    );
    const result = await context.store.revise({ runId: "fixture-run", expectedRevision: 0, plan });
    assert.deepEqual(result.record.attempts, before.attempts);
    assert.equal(result.record.state.steps.root, undefined);
    for (const stepId of ["added", "middle", "leaf"]) {
      assert.deepEqual(result.record.state.steps[stepId], {
        stepId,
        status: "pending",
        attempts: 0,
        generation: 1,
      });
    }
    assert.equal(result.record.state.steps.retained?.status, "completed");
    assert.equal(result.record.state.steps.retained?.generation, 0);
    assert.equal(
      singleOrchestrationClaim(await context.store.claim("fixture-run")).step.stepId,
      "added",
    );
  });
});

test("重试工作代：保留 epoch 继续 number，执行变化新 epoch 重置预算", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = setup(directory);
    const original = orchestrationPlan();
    await context.store.create(orchestrationInput(original));
    const first = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    await context.store.finish(first.runId, first.attempt.key, first.attempt.generation, {
      status: "failed",
      error: "Retryable",
    });
    const display = { ...original, revision: 1, goal: "Display only" };
    await context.store.revise({ runId: "fixture-run", expectedRevision: 0, plan: display });
    const retry = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    assert.equal(retry.attempt.attempt, 2);
    assert.equal(retry.attempt.generation, 0);
    assert.equal(retry.attempt.revision, 1);
    await context.store.finish(retry.runId, retry.attempt.key, retry.attempt.generation, {
      status: "failed",
      error: "Exhausted",
    });
    const changed = structuredClone(display);
    changed.revision = 2;
    changed.steps[0]!.task = "Execute revised work";
    const result = await context.store.revise({
      runId: "fixture-run",
      expectedRevision: 1,
      plan: changed,
    });
    assert.equal(result.record.state.steps.first?.attempts, 0);
    const fresh = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    assert.equal(fresh.attempt.attempt, 1);
    assert.equal(fresh.attempt.generation, 1);
    assert.equal(fresh.attempt.revision, 2);
    await complete(context, fresh);
    assert.equal((await context.store.get("fixture-run"))?.attempts.length, 3);
  });
});

for (const field of [
  "role",
  "task",
  "acceptance",
  "maxAttempts",
  "optional",
  "writeScope",
] as const) {
  test(`执行语义 ${field} 变化失效当前步骤及 completed 后继`, async () => {
    await withOrchestrationDirectory(async (directory) => {
      const context = setup(directory);
      const original = orchestrationPlan([
        orchestrationStep({ stepId: "first", writeScope: ["src"] }),
        orchestrationStep({ stepId: "second", dependsOn: ["first"] }),
      ]);
      await context.store.create(orchestrationInput(original));
      for (let index = 0; index < 2; index += 1) {
        await complete(context, singleOrchestrationClaim(await context.store.claim("fixture-run")));
      }
      const plan = structuredClone(original);
      plan.revision = 1;
      Object.assign(plan.steps[0]!, {
        [field]: {
          role: "reviewer",
          task: "Different execution",
          acceptance: "Verify result",
          maxAttempts: 0,
          optional: true,
          writeScope: ["other"],
        }[field],
      });
      const result = await context.store.revise({
        runId: "fixture-run",
        expectedRevision: 0,
        plan,
      });
      assert.equal(result.record.state.steps.first?.generation, 1);
      assert.equal(result.record.state.steps.second?.generation, 1);
      assert.equal(result.record.state.steps.second?.status, "pending");
    });
  });
}
