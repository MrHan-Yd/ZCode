import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { parseOrchestrationRunRecord, type OrchestrationRunRecord } from "@zcode/contracts";
import { NodeOrchestrationJournal } from "../../adapters/src/orchestration/journal.js";
import { NodeOrchestrationArtifactStorage } from "../../adapters/src/orchestration/artifacts.js";
import { OrchestrationRunStore } from "../src/orchestration/runStore.js";
import { OrchestrationArtifacts } from "../src/orchestration/artifacts.js";
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

function setup(directory: string) {
  const owner = orchestrationOwner(directory);
  const journal = new NodeOrchestrationJournal({ rootDirectory: directory, owner });
  const store = new OrchestrationRunStore({ owner, journal, now: orchestrationClock() });
  const artifacts = new OrchestrationArtifacts({
    storage: new NodeOrchestrationArtifactStorage({ rootDirectory: directory, owner }),
  });
  return { owner, journal, store, artifacts };
}

async function completedPlan(directory: string, optional = false) {
  const context = setup(directory);
  await context.store.create(
    orchestrationInput(
      orchestrationPlan([
        orchestrationStep({ stepId: "first", optional }),
        orchestrationStep({ stepId: "second", dependsOn: ["first"] }),
      ]),
    ),
  );
  for (let index = 0; index < 2; index += 1) {
    const claim = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    const artifact = await context.artifacts.save(claim.attempt.key, `Result ${claim.step.stepId}`);
    await context.store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
      status: "completed",
      artifact,
    });
  }
  const record = await context.store.get("fixture-run");
  assert.ok(record);
  return { ...context, record };
}

function moveClaimBeforeDependency(record: OrchestrationRunRecord): OrchestrationRunRecord {
  const altered = structuredClone(record);
  const first = altered.attempts.find((attempt) => attempt.stepId === "first");
  const second = altered.attempts.find((attempt) => attempt.stepId === "second");
  assert.ok(first && second);
  const claimed = altered.events.find(
    (event) => event.type === "attempt_claimed" && event.attemptKey === second.key,
  );
  assert.ok(claimed);
  second.startedAt = first.startedAt;
  altered.state.steps.second!.startedAt = first.startedAt;
  claimed.at = first.startedAt;
  altered.events.splice(altered.events.indexOf(claimed), 1);
  altered.events.splice(2, 0, claimed);
  altered.events.forEach((event, index) => {
    event.sequence = index + 1;
  });
  return altered;
}

for (const optional of [false, true]) {
  test(`历史准入：${optional ? "optional" : "required"} 前置未完成时的 claim 必须在解析和冷恢复被拒绝`, async () => {
    await withOrchestrationDirectory(async (directory) => {
      const context = await completedPlan(directory, optional);
      const altered = moveClaimBeforeDependency(context.record);
      assert.throws(
        () => parseOrchestrationRunRecord(altered),
        orchestrationError("invalid_record"),
      );
      const content = JSON.stringify(altered);
      await writeFile(context.journal.filePath(altered.runId), content, "utf8");
      await assert.rejects(
        context.store.recover(altered.runId),
        orchestrationError("invalid_record"),
      );
      assert.equal(await readFile(context.journal.filePath(altered.runId), "utf8"), content);
    });
  });
}

test("历史准入：相同时间戳仍必须按 sequence 完成依赖后再领取", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = await completedPlan(directory);
    const altered = moveClaimBeforeDependency(context.record);
    for (const attempt of altered.attempts) {
      attempt.startedAt = 1_000;
      attempt.endedAt = 1_000;
    }
    for (const state of Object.values(altered.state.steps)) {
      state.startedAt = 1_000;
      state.endedAt = 1_000;
    }
    altered.state.startedAt = 1_000;
    altered.state.updatedAt = 1_000;
    for (const event of altered.events) event.at = 1_000;
    assert.throws(() => parseOrchestrationRunRecord(altered), orchestrationError("invalid_record"));
  });
});

test("历史准入：并发上限和写范围冲突不能被成功终态掩盖", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = await completedPlan(directory);
    for (const writeConflict of [false, true]) {
      const altered = moveClaimBeforeDependency(context.record);
      altered.state.plan.steps[1]!.dependsOn = [];
      altered.maxConcurrency = writeConflict ? 2 : 1;
      if (writeConflict) {
        altered.state.plan.steps[0]!.writeScope = ["src"];
        altered.state.plan.steps[1]!.writeScope = ["other/../src"];
      }
      assert.throws(
        () => parseOrchestrationRunRecord(altered),
        orchestrationError("invalid_record"),
      );
    }
  });
});

test("合法历史：optional 耗尽重试后才放行，required 失败仍允许独立 pending 步骤", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = setup(directory);
    await context.store.create(
      orchestrationInput(
        orchestrationPlan([
          orchestrationStep({ stepId: "optional", optional: true, maxAttempts: 1 }),
          orchestrationStep({ stepId: "join", dependsOn: ["optional"] }),
          orchestrationStep({ stepId: "required", maxAttempts: 0 }),
          orchestrationStep({ stepId: "blocked", dependsOn: ["required"] }),
          orchestrationStep({ stepId: "independent" }),
        ]),
        { maxConcurrency: 1 },
      ),
    );
    for (let index = 0; index < 2; index += 1) {
      const claim = singleOrchestrationClaim(await context.store.claim("fixture-run"));
      assert.equal(claim.step.stepId, "optional");
      await context.store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
        status: "failed",
        error: "optional failure",
      });
    }
    let claim = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    assert.equal(claim.step.stepId, "join");
    let artifact = await context.artifacts.save(claim.attempt.key, "join output");
    await context.store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
      status: "completed",
      artifact,
    });
    claim = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    assert.equal(claim.step.stepId, "required");
    await context.store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
      status: "failed",
      error: "required failure",
    });
    claim = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    assert.equal(claim.step.stepId, "independent");
    artifact = await context.artifacts.save(claim.attempt.key, "independent output");
    await context.store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
      status: "completed",
      artifact,
    });
    const record = await context.store.get("fixture-run");
    assert.ok(record);
    assert.equal(record.state.steps.blocked?.status, "blocked");
    assert.equal(record.status, "failed");
    assert.deepEqual(parseOrchestrationRunRecord(record), record);
  });
});

test("合法历史：中断禁止新 claim，但允许在飞绑定、收口及显式取消", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = setup(directory);
    await context.store.create(
      orchestrationInput(
        orchestrationPlan([
          orchestrationStep({ stepId: "first" }),
          orchestrationStep({ stepId: "second" }),
          orchestrationStep({ stepId: "third", dependsOn: ["second"] }),
        ]),
      ),
    );
    const [first, second] = await context.store.claim("fixture-run");
    assert.ok(first && second);
    await context.store.finish(first.runId, first.attempt.key, first.attempt.generation, {
      status: "interrupted",
      error: "lost first",
    });
    await context.store.bindChild(second.runId, second.attempt.key, {
      agentId: "second",
      taskId: "second",
    });
    const artifact = await context.artifacts.save(second.attempt.key, "second output");
    await context.store.finish(second.runId, second.attempt.key, second.attempt.generation, {
      status: "completed",
      artifact,
    });
    assert.deepEqual(await context.store.claim("fixture-run"), []);
    const cancelled = await context.store.cancel("fixture-run");
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(parseOrchestrationRunRecord(cancelled), cancelled);
  });
});

test("合法历史：required 步骤被取消后 run 终止，不再领取任何步骤", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = setup(directory);
    await context.store.create(
      orchestrationInput(
        orchestrationPlan([
          orchestrationStep({ stepId: "cancelled", maxAttempts: 0 }),
          orchestrationStep({ stepId: "dependent", dependsOn: ["cancelled"] }),
          orchestrationStep({ stepId: "next" }),
        ]),
        { maxConcurrency: 1 },
      ),
    );
    const cancelledClaim = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    assert.equal(cancelledClaim.step.stepId, "cancelled");
    await context.store.finish(
      cancelledClaim.runId,
      cancelledClaim.attempt.key,
      cancelledClaim.attempt.generation,
      { status: "cancelled", error: "step cancelled by user" },
    );
    assert.deepEqual(await context.store.claim("fixture-run"), []);
    const record = await context.store.get("fixture-run");
    assert.ok(record);
    assert.equal(record.status, "cancelled");
    assert.equal(record.state.steps.dependent?.status, "blocked");
    assert.equal(record.state.steps.next?.status, "pending");
    assert.deepEqual(parseOrchestrationRunRecord(record), record);
  });
});

test("合法历史：optional 步骤被取消后依赖它的步骤仍可领取", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = setup(directory);
    await context.store.create(
      orchestrationInput(
        orchestrationPlan([
          orchestrationStep({ stepId: "optional", optional: true, maxAttempts: 0 }),
          orchestrationStep({ stepId: "dependent", dependsOn: ["optional"] }),
        ]),
        { maxConcurrency: 1 },
      ),
    );
    const first = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    assert.equal(first.step.stepId, "optional");
    await context.store.finish(first.runId, first.attempt.key, first.attempt.generation, {
      status: "cancelled",
      error: "optional cancelled",
    });
    const second = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    assert.equal(second.step.stepId, "dependent");
    const artifact = await context.artifacts.save(second.attempt.key, "dependent output");
    await context.store.finish(second.runId, second.attempt.key, second.attempt.generation, {
      status: "completed",
      artifact,
    });
    const record = await context.store.get("fixture-run");
    assert.ok(record);
    assert.deepEqual(parseOrchestrationRunRecord(record), record);
  });
});

test("损坏记录：run 级取消事件携带 attemptKey 不能绕过 generation fence", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = setup(directory);
    await context.store.create(
      orchestrationInput(
        orchestrationPlan([
          orchestrationStep({ stepId: "first" }),
          orchestrationStep({ stepId: "second" }),
        ]),
        { maxConcurrency: 1 },
      ),
    );
    const claim = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    await context.store.bindChild(claim.runId, claim.attempt.key, {
      agentId: "first",
      taskId: "first",
    });
    const record = await context.store.get("fixture-run");
    assert.ok(record);
    const forged = structuredClone(record);
    assert.ok(forged.attempts[0] && forged.state.steps.first && forged.state.steps.second);
    const at = forged.state.updatedAt + 1;
    forged.status = "cancelled";
    forged.state.cancelled = true;
    forged.state.updatedAt = at;
    forged.state.steps.first = {
      ...forged.state.steps.first,
      status: "cancelled",
      endedAt: at,
    };
    forged.state.steps.second = { stepId: "second", status: "cancelled", attempts: 0, endedAt: at };
    forged.attempts[0] = {
      ...forged.attempts[0],
      status: "cancelled",
      endedAt: at,
      error: "forged",
    };
    // store 的 cancel 一定先递增 generation；这里保持 generation 不变，只给事件补上 attemptKey。
    forged.events.push({
      sequence: forged.events.length + 1,
      type: "run_cancelled",
      generation: forged.state.generation,
      at,
      attemptKey: forged.attempts[0].key,
    });
    assert.throws(() => parseOrchestrationRunRecord(forged), orchestrationError("invalid_record"));
  });
});

test("运行记录：路径点段别名的两个可写步骤不能同时领取", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = setup(directory);
    await context.store.create(
      orchestrationInput(
        orchestrationPlan([
          orchestrationStep({ stepId: "first", role: "backend", writeScope: ["src"] }),
          orchestrationStep({ stepId: "second", role: "backend", writeScope: ["other/../src"] }),
        ]),
        { maxConcurrency: 2 },
      ),
    );
    assert.equal(
      singleOrchestrationClaim(await context.store.claim("fixture-run")).step.stepId,
      "first",
    );
  });
});
