import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  orchestrationError,
  orchestrationInput,
  orchestrationOwner,
  orchestrationPlan,
  orchestrationStep,
  singleOrchestrationClaim,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

class RevisionMemoryJournal implements OrchestrationJournalPort {
  readonly records = new Map<string, OrchestrationRunRecord>();
  nextCommitError?: Error;

  transaction<T>(
    runId: string,
    update: (record: OrchestrationRunRecord | undefined) => OrchestrationJournalUpdate<T>,
  ): Promise<T> {
    try {
      const next = update(structuredClone(this.records.get(runId)));
      if (next.record) {
        if (this.nextCommitError) {
          const error = this.nextCommitError;
          this.nextCommitError = undefined;
          throw error;
        }
        this.records.set(runId, structuredClone(next.record));
      }
      return Promise.resolve(structuredClone(next.value));
    } catch (error) {
      return Promise.reject(error);
    }
  }
}

function setup(directory: string) {
  const owner = orchestrationOwner(directory);
  const journal = new RevisionMemoryJournal();
  const store = new OrchestrationRunStore({ owner, journal, now: orchestrationClock() });
  return { owner, journal, store };
}

function artifact(claim: ClaimedOrchestrationAttempt) {
  return {
    artifactId: claim.attempt.key,
    attemptKey: claim.attempt.key,
    uri: `artifact:${claim.attempt.key}`,
    summary: "Confirmed output",
    originalBytes: 16,
    savedBytes: 16,
    sha256: createHash("sha256").update("Confirmed output").digest("hex"),
    truncated: false,
    summaryTruncated: false,
  };
}

test("修订取消占位：旧 scope 与并发上限保持，晚到绑定不恢复 live", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store } = setup(directory);
    const original = orchestrationPlan([
      orchestrationStep({ stepId: "changed", role: "backend", writeScope: ["src"] }),
      orchestrationStep({ stepId: "retained", role: "backend", writeScope: ["keep"] }),
    ]);
    await store.create(orchestrationInput(original, { maxConcurrency: 3 }));
    const initial = await store.claim("fixture-run");
    const old = initial.find((claim) => claim.step.stepId === "changed");
    const retained = initial.find((claim) => claim.step.stepId === "retained");
    assert.ok(old && retained);
    const plan = orchestrationPlan(
      [
        orchestrationStep({
          stepId: "changed",
          role: "backend",
          writeScope: ["new"],
          task: "Revised work",
        }),
        original.steps[1]!,
        orchestrationStep({ stepId: "overlap", role: "backend", writeScope: ["other/../SRC/**"] }),
        orchestrationStep({ stepId: "free", role: "backend", writeScope: ["free"] }),
      ],
      { revision: 1 },
    );
    await store.revise({ runId: "fixture-run", expectedRevision: 0, plan });
    const free = singleOrchestrationClaim(await store.claim("fixture-run"));
    assert.equal(free.step.stepId, "free");
    assert.deepEqual(await store.claim("fixture-run"), []);
    const child = { agentId: "late-agent", taskId: "late-task", childSessionId: "late-child" };
    assert.equal(await store.bindChild(old.runId, old.attempt.key, child), true);
    assert.equal(await store.bindChild(old.runId, old.attempt.key, { ...child }), false);
    await assert.rejects(
      store.bindChild(old.runId, old.attempt.key, { ...child, taskId: "other" }),
      orchestrationError("attempt_conflict"),
    );
    const pending = await store.get("fixture-run");
    assert.equal(pending?.attempts[0]?.status, "cancelled");
    assert.equal(pending?.attempts[0]?.cancellationPending, true);
    assert.equal(pending?.state.steps.changed?.status, "pending");
    assert.equal(await store.confirmAttemptQuiesced("fixture-run", retained.attempt.key), false);
    assert.equal(await store.confirmAttemptQuiesced("fixture-run", "missing"), false);
    assert.equal(await store.confirmAttemptQuiesced("fixture-run", old.attempt.key), true);
    const confirmed = await store.get("fixture-run");
    assert.equal(confirmed?.attempts[0]?.cancellationPending, false);
    assert.equal(confirmed?.events.at(-1)?.type, "attempt_quiesced");
    assert.equal(await store.confirmAttemptQuiesced("fixture-run", old.attempt.key), false);
    assert.equal(
      await store.bindChild(old.runId, old.attempt.key, { agentId: "another", taskId: "another" }),
      false,
    );
    const replacement = singleOrchestrationClaim(await store.claim("fixture-run"));
    assert.equal(replacement.step.stepId, "changed");
    assert.equal(
      await store.finish(old.runId, old.attempt.key, old.attempt.generation, {
        status: "completed",
        artifact: artifact(old),
      }),
      false,
    );
    assert.equal(
      await store.finish(retained.runId, retained.attempt.key, retained.attempt.generation, {
        status: "completed",
        artifact: artifact(retained),
      }),
      true,
    );
  });
});

test("修订幂等与拒绝：expectedRevision、planId 和非法 DAG 在事务副作用前阻止", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store } = setup(directory);
    const original = orchestrationPlan();
    await store.create(orchestrationInput(original));
    const claim = singleOrchestrationClaim(await store.claim("fixture-run"));
    const plan = orchestrationPlan([orchestrationStep({ stepId: "first", task: "New work" })], {
      revision: 1,
    });
    const revised = await store.revise({ runId: "fixture-run", expectedRevision: 0, plan });
    assert.deepEqual(
      await store.revise({
        runId: "fixture-run",
        expectedRevision: 0,
        plan: structuredClone(plan),
      }),
      revised,
    );
    for (const changed of [
      { expectedRevision: 1, plan },
      { expectedRevision: 0, plan: { ...plan, goal: "Not identical" } },
      { expectedRevision: 1, plan: { ...plan, revision: 3 } },
      { expectedRevision: 1, plan: { ...plan, revision: 2, planId: "other-plan" } },
    ]) {
      await assert.rejects(
        store.revise({ runId: "fixture-run", ...changed }),
        orchestrationError("run_conflict"),
      );
      assert.deepEqual(await store.get("fixture-run"), revised.record);
    }
    await assert.rejects(
      store.revise({
        runId: "fixture-run",
        expectedRevision: 1,
        plan: orchestrationPlan([orchestrationStep({ stepId: "first", dependsOn: ["missing"] })], {
          revision: 2,
        }),
      }),
      orchestrationError("invalid_plan"),
    );
    assert.equal(await store.confirmAttemptQuiesced("fixture-run", claim.attempt.key), true);
    const duplicate = await store.revise({ runId: "fixture-run", expectedRevision: 0, plan });
    assert.deepEqual(duplicate.invalidatedAttemptKeys, []);
    const otherOwner = new OrchestrationRunStore({
      owner: { ...store.owner, sessionId: "other-session" },
      journal: setup(directory).journal,
    });
    await assert.rejects(
      otherOwner.revise({ runId: "fixture-run", expectedRevision: 0, plan }),
      orchestrationError("not_found"),
    );
  });
});

test("整 run 取消：关闭不同工作代 retained live，保留并允许旧占位清理", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store } = setup(directory);
    const original = orchestrationPlan([
      orchestrationStep({ stepId: "first" }),
      orchestrationStep({ stepId: "second" }),
    ]);
    await store.create(orchestrationInput(original));
    const [first, second] = await store.claim("fixture-run");
    assert.ok(first && second);
    const plan = structuredClone(original);
    plan.revision = 1;
    plan.steps[0]!.task = "Changed";
    await store.revise({ runId: "fixture-run", expectedRevision: 0, plan });
    await store.confirmAttemptQuiesced("fixture-run", first.attempt.key);
    const newFirst = singleOrchestrationClaim(await store.claim("fixture-run"));
    assert.equal(newFirst.attempt.generation, 1);
    const next = structuredClone(plan);
    next.revision = 2;
    next.steps[0]!.task = "Changed again";
    await store.revise({ runId: "fixture-run", expectedRevision: 1, plan: next });
    const cancelled = await store.cancel("fixture-run");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.state.generation, 1);
    assert.equal(
      cancelled.attempts.find((attempt) => attempt.key === second.attempt.key)?.status,
      "cancelled",
    );
    assert.equal(
      cancelled.attempts.find((attempt) => attempt.key === newFirst.attempt.key)
        ?.cancellationPending,
      true,
    );
    assert.equal(
      await store.bindChild("fixture-run", newFirst.attempt.key, {
        agentId: "late",
        taskId: "late",
      }),
      true,
    );
    assert.equal(await store.confirmAttemptQuiesced("fixture-run", newFirst.attempt.key), true);
    assert.deepEqual(await store.claim("fixture-run"), []);
    await assert.rejects(
      store.revise({ runId: "fixture-run", expectedRevision: 2, plan: { ...next, revision: 3 } }),
      orchestrationError("run_conflict"),
    );
    assert.equal(
      await store.finish(second.runId, second.attempt.key, second.attempt.generation, {
        status: "completed",
        artifact: artifact(second),
      }),
      false,
    );
  });
});

test("冷恢复仅清理占位：追加 interrupted fence，确认退出不自动解除暂停", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store } = setup(directory);
    await store.create(orchestrationInput());
    const first = singleOrchestrationClaim(await store.claim("fixture-run"));
    const plan = orchestrationPlan([orchestrationStep({ stepId: "first", task: "New work" })], {
      revision: 1,
    });
    await store.revise({ runId: "fixture-run", expectedRevision: 0, plan });
    const recovered = await store.recover("fixture-run");
    assert.equal(recovered.state.interrupted, true);
    assert.equal(recovered.state.generation, 1);
    assert.equal(recovered.status, "interrupted");
    assert.equal(recovered.attempts[0]?.cancellationPending, true);
    assert.deepEqual(await store.recover("fixture-run"), recovered);
    assert.equal(
      await store.bindChild("fixture-run", first.attempt.key, { agentId: "late", taskId: "late" }),
      true,
    );
    assert.equal(await store.confirmAttemptQuiesced("fixture-run", first.attempt.key), true);
    assert.equal((await store.get("fixture-run"))?.status, "interrupted");
    assert.deepEqual(await store.claim("fixture-run"), []);
    await assert.rejects(
      store.revise({ runId: "fixture-run", expectedRevision: 1, plan: { ...plan, revision: 2 } }),
      orchestrationError("run_conflict"),
    );
  });
});

test("修订和退出提交失败：不发布内存状态，原错误透传", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store, journal } = setup(directory);
    await store.create(orchestrationInput());
    const claim = singleOrchestrationClaim(await store.claim("fixture-run"));
    const before = await store.get("fixture-run");
    const plan = orchestrationPlan([orchestrationStep({ stepId: "first", task: "Changed" })], {
      revision: 1,
    });
    const error = new Error("Injected commit failure");
    journal.nextCommitError = error;
    await assert.rejects(
      store.revise({ runId: "fixture-run", expectedRevision: 0, plan }),
      (failure: unknown) => failure === error,
    );
    assert.deepEqual(await store.get("fixture-run"), before);
    const revised = await store.revise({ runId: "fixture-run", expectedRevision: 0, plan });
    journal.nextCommitError = error;
    await assert.rejects(
      store.confirmAttemptQuiesced("fixture-run", claim.attempt.key),
      (failure: unknown) => failure === error,
    );
    assert.deepEqual(await store.get("fixture-run"), revised.record);
    const wrongOwner = new OrchestrationRunStore({
      owner: orchestrationOwner(join(directory, "other")),
      journal,
    });
    await assert.rejects(
      wrongOwner.revise({ runId: "fixture-run", expectedRevision: 0, plan }),
      orchestrationError("owner_mismatch"),
    );
  });
});
