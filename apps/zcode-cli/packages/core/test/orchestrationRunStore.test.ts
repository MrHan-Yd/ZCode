import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";
import { NodeOrchestrationArtifactStorage } from "../../adapters/src/orchestration/artifacts.js";
import { NodeOrchestrationJournal } from "../../adapters/src/orchestration/journal.js";
import { OrchestrationArtifacts } from "../src/orchestration/artifacts.js";
import type {
  ClaimedOrchestrationAttempt,
  OrchestrationRunOwner,
  OrchestrationRunRecord,
} from "../src/orchestration/contract.js";
import { OrchestrationRunStore } from "../src/orchestration/runStore.js";
import {
  FailingOrchestrationJournal,
  orchestrationClock,
  orchestrationError,
  orchestrationInput,
  orchestrationOwner,
  orchestrationPlan,
  orchestrationStep,
  singleOrchestrationClaim,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

function harness(directory: string, owner: OrchestrationRunOwner = orchestrationOwner(directory)) {
  const rootDirectory = join(directory, "data");
  const journal = new NodeOrchestrationJournal({ rootDirectory, owner });
  const store = new OrchestrationRunStore({ owner, journal, now: orchestrationClock() });
  const storage = new NodeOrchestrationArtifactStorage({ rootDirectory, owner });
  return { journal, store, artifacts: new OrchestrationArtifacts({ storage }) };
}

async function record(store: OrchestrationRunStore, runId = "fixture-run") {
  const current = await store.get(runId);
  assert.ok(current);
  return current;
}

function monotonicEvents(current: OrchestrationRunRecord): void {
  let previous = -1;
  for (const event of current.events) {
    assert.ok(Number.isInteger(event.sequence) && event.sequence > previous);
    assert.ok(Number.isFinite(event.at));
    previous = event.sequence;
  }
}

async function complete(context: ReturnType<typeof harness>, claim: ClaimedOrchestrationAttempt) {
  const artifact = await context.artifacts.save(
    claim.attempt.key,
    `Result for ${claim.step.stepId}`,
  );
  assert.equal(
    await context.store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
      status: "completed",
      artifact,
    }),
    true,
  );
  return artifact;
}

test("Node journal：真实目录往返计划、状态、attempt 与单调事件", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = harness(directory);
    const input = orchestrationInput(orchestrationPlan(), { generation: 7 });
    const created = await context.store.create(input);
    assert.equal(created.version, 1);
    assert.equal(created.status, "pending");
    assert.deepEqual(created.owner, context.store.owner);
    assert.deepEqual(created.state.plan, input.plan);
    assert.equal(created.state.generation, 7);
    assert.equal(created.state.steps.first?.status, "pending");
    assert.deepEqual(created.attempts, []);
    assert.deepEqual(
      created.events.map((event) => event.type),
      ["run_created"],
    );
    const claim = singleOrchestrationClaim(await context.store.claim(input.runId));
    assert.equal(claim.attempt.status, "claimed");
    assert.equal(claim.attempt.attempt, 1);
    assert.equal(claim.attempt.revision, input.plan.revision);
    assert.equal(claim.attempt.generation, 7);
    const child = {
      agentId: "agent-first",
      taskId: "task-first",
      childSessionId: "child-first",
      outputFile: join(directory, "child.txt"),
    };
    assert.equal(await context.store.bindChild(input.runId, claim.attempt.key, child), true);
    const artifact = await complete(context, claim);
    const finished = await record(context.store);
    assert.equal(finished.status, "completed");
    assert.equal(finished.state.steps.first?.status, "completed");
    assert.equal(finished.attempts[0]?.status, "completed");
    assert.deepEqual(finished.attempts[0]?.child, child);
    assert.deepEqual(finished.attempts[0]?.artifact, artifact);
    assert.ok((finished.attempts[0]?.endedAt ?? 0) >= claim.attempt.startedAt);
    assert.deepEqual(
      finished.events.map((event) => event.type),
      ["run_created", "attempt_claimed", "child_bound", "attempt_completed"],
    );
    monotonicEvents(finished);
    const persisted: unknown = JSON.parse(
      await readFile(context.journal.filePath(input.runId), "utf8"),
    );
    assert.deepEqual(persisted, finished);
    assert.deepEqual(await harness(directory).store.get(input.runId), finished);
    assert.equal((await readdir(join(context.journal.filePath(input.runId), ".."))).length, 1);
  });
});

test("create：同 run 同参数幂等，不同计划或执行配置冲突且不覆盖", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store, journal } = harness(directory);
    const input = orchestrationInput();
    const created = await store.create(input);
    const before = await readFile(journal.filePath(input.runId), "utf8");
    assert.deepEqual(await harness(directory).store.create(structuredClone(input)), created);
    for (const changed of [
      { ...input, plan: { ...input.plan, goal: "Different goal" } },
      { ...input, plan: { ...input.plan, revision: 1 } },
      { ...input, generation: 1 },
      { ...input, maxConcurrency: 1 },
      { ...input, team: input.team.filter((role) => role !== "reviewer") },
      { ...input, writableRoles: ["frontend"] },
    ])
      await assert.rejects(store.create(changed), orchestrationError("run_conflict"));
    assert.deepEqual(await store.get(input.runId), created);
    assert.equal(await readFile(journal.filePath(input.runId), "utf8"), before);
  });
});

test("claim：多个同 owner store 并发领取不重复，不越过并发上限", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const first = harness(directory);
    const second = harness(directory);
    await first.store.create(
      orchestrationInput(
        orchestrationPlan(["a", "b", "c", "d"].map((stepId) => orchestrationStep({ stepId }))),
        { maxConcurrency: 3 },
      ),
    );
    const batches = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        (index % 2 ? first : second).store.claim("fixture-run"),
      ),
    );
    const claims = batches.flat();
    assert.equal(claims.length, 3);
    assert.equal(new Set(claims.map((claim) => claim.attempt.key)).size, 3);
    assert.equal(new Set(claims.map((claim) => claim.step.stepId)).size, 3);
    assert.deepEqual(await second.store.claim("fixture-run"), []);
    const current = await record(first.store);
    assert.equal(current.status, "running");
    assert.equal(current.attempts.length, 3);
    assert.equal(current.events.filter((event) => event.type === "attempt_claimed").length, 3);
    assert.equal(
      Object.values(current.state.steps).filter((step) => step.status === "running").length,
      3,
    );
    assert.ok(
      current.attempts.every((attempt) => attempt.attempt === 1 && attempt.status === "claimed"),
    );
    monotonicEvents(current);
    assert.deepEqual(await second.store.get("fixture-run"), current);
  });
});

test("bindChild：同身份重复 false，任何身份或引用变化均冲突", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store, journal } = harness(directory);
    await store.create(orchestrationInput());
    const claim = singleOrchestrationClaim(await store.claim("fixture-run"));
    const child = {
      agentId: "agent-1",
      taskId: "task-1",
      childSessionId: "child-1",
      outputFile: join(directory, "output.txt"),
    };
    assert.equal(await store.bindChild(claim.runId, claim.attempt.key, child), true);
    const before = await readFile(journal.filePath(claim.runId), "utf8");
    assert.equal(await store.bindChild(claim.runId, claim.attempt.key, { ...child }), false);
    for (const changed of [
      { ...child, agentId: "other" },
      { ...child, taskId: "other" },
      { ...child, childSessionId: "other" },
      { ...child, outputFile: join(directory, "other.txt") },
    ]) {
      await assert.rejects(
        store.bindChild(claim.runId, claim.attempt.key, changed),
        orchestrationError("attempt_conflict"),
      );
    }
    const current = await record(store);
    assert.equal(current.attempts[0]?.status, "running");
    assert.deepEqual(current.attempts[0]?.child, child);
    assert.equal(await readFile(journal.filePath(claim.runId), "utf8"), before);
  });
});

test("finish：旧 generation 和重复 terminal 返回 false，不发布第二次事件", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = harness(directory);
    await context.store.create(
      orchestrationInput(orchestrationPlan(undefined, { revision: 3 }), { generation: 8 }),
    );
    const claim = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    const artifact = await context.artifacts.save(claim.attempt.key, "Confirmed result");
    const before = await record(context.store);
    assert.equal(
      await context.store.finish(claim.runId, claim.attempt.key, 7, {
        status: "completed",
        artifact,
      }),
      false,
    );
    assert.deepEqual(await record(context.store), before);
    assert.equal(
      await context.store.finish(claim.runId, claim.attempt.key, 8, {
        status: "completed",
        artifact,
      }),
      true,
    );
    const finished = await record(context.store);
    assert.equal(
      await context.store.finish(claim.runId, claim.attempt.key, 8, {
        status: "completed",
        artifact,
      }),
      false,
    );
    assert.equal(
      await context.store.finish(claim.runId, claim.attempt.key, 8, {
        status: "failed",
        error: "late failure",
      }),
      false,
    );
    assert.deepEqual(await record(context.store), finished);
    assert.equal(finished.attempts[0]?.revision, 3);
    assert.equal(finished.events.filter((event) => event.type === "attempt_completed").length, 1);
    assert.deepEqual(await context.store.claim(claim.runId), []);
  });
});

for (const maxAttempts of [undefined, 0, 1, 5]) {
  test(`重试：maxAttempts=${String(maxAttempts)} 是额外次数，每次 number/key 不同`, async () => {
    await withOrchestrationDirectory(async (directory) => {
      const { store } = harness(directory);
      const step = orchestrationStep({
        stepId: "first",
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
      });
      await store.create(
        orchestrationInput(
          orchestrationPlan([step, orchestrationStep({ stepId: "join", dependsOn: ["first"] })]),
        ),
      );
      const keys = new Set<string>();
      const total = (maxAttempts ?? 1) + 1;
      for (let number = 1; number <= total; number += 1) {
        const claim = singleOrchestrationClaim(await store.claim("fixture-run"));
        assert.equal(claim.attempt.attempt, number);
        assert.equal(claim.step.stepId, "first");
        assert.ok(!keys.has(claim.attempt.key));
        keys.add(claim.attempt.key);
        assert.equal(
          await store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
            status: "failed",
            error: `failure-${number}`,
          }),
          true,
        );
        assert.equal(
          await store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
            status: "failed",
            error: "duplicate",
          }),
          false,
        );
        assert.equal(
          (await record(store)).state.steps.first?.status,
          number < total ? "pending" : "failed",
        );
      }
      const current = await record(store);
      assert.equal(current.status, "failed");
      assert.equal(current.attempts.length, total);
      assert.ok(
        current.attempts.every(
          (attempt) => attempt.status === "failed" && attempt.endedAt !== undefined,
        ),
      );
      assert.equal(current.state.steps.join?.status, "blocked");
      assert.equal(current.events.filter((event) => event.type === "attempt_failed").length, total);
      assert.deepEqual(await store.claim("fixture-run"), []);
      monotonicEvents(current);
    });
  });
}

test("cancel：先持久化 generation+1，保留完成产物和 child，二次取消幂等", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = harness(directory);
    await context.store.create(
      orchestrationInput(
        orchestrationPlan([
          orchestrationStep({ stepId: "first" }),
          orchestrationStep({ stepId: "second", dependsOn: ["first"] }),
          orchestrationStep({ stepId: "third", dependsOn: ["second"] }),
        ]),
      ),
    );
    const first = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    const artifact = await complete(context, first);
    const second = singleOrchestrationClaim(await context.store.claim("fixture-run"));
    const child = {
      agentId: "agent-second",
      taskId: "task-second",
      childSessionId: "child-second",
    };
    await context.store.bindChild(second.runId, second.attempt.key, child);
    const cancelled = await context.store.cancel("fixture-run");
    assert.equal(cancelled.status, "cancelled");
    assert.equal(cancelled.state.generation, second.attempt.generation + 1);
    assert.equal(cancelled.state.steps.first?.status, "completed");
    assert.equal(cancelled.state.steps.second?.status, "cancelled");
    assert.equal(cancelled.state.steps.third?.status, "cancelled");
    assert.deepEqual(cancelled.attempts[0]?.artifact, artifact);
    assert.deepEqual(cancelled.attempts[1]?.child, child);
    assert.equal(cancelled.attempts[1]?.status, "cancelled");
    assert.equal(cancelled.events.filter((event) => event.type === "run_cancelled").length, 1);
    assert.deepEqual(await context.store.cancel("fixture-run"), cancelled);
    assert.deepEqual(await harness(directory).store.recover("fixture-run"), cancelled);
    assert.equal(
      await context.store.finish(second.runId, second.attempt.key, second.attempt.generation, {
        status: "failed",
        error: "late",
      }),
      false,
    );
    assert.deepEqual(await context.store.claim("fixture-run"), []);
    assert.deepEqual(await record(context.store), cancelled);
  });
});

test("recover：完整 completed run 不重跑、不新增事件或 generation", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = harness(directory);
    await context.store.create(orchestrationInput());
    await complete(context, singleOrchestrationClaim(await context.store.claim("fixture-run")));
    const finished = await record(context.store);
    const restored = harness(directory).store;
    assert.deepEqual(await restored.recover("fixture-run"), finished);
    assert.deepEqual(await restored.recover("fixture-run"), finished);
    assert.deepEqual(await restored.claim("fixture-run"), []);
  });
});

test("recover：completed 步骤不重跑，未领取 pending 依赖可继续", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = harness(directory);
    await context.store.create(
      orchestrationInput(
        orchestrationPlan([
          orchestrationStep({ stepId: "first" }),
          orchestrationStep({ stepId: "second", dependsOn: ["first"] }),
        ]),
      ),
    );
    const artifact = await complete(
      context,
      singleOrchestrationClaim(await context.store.claim("fixture-run")),
    );
    const restored = harness(directory).store;
    const recovered = await restored.recover("fixture-run");
    assert.equal(recovered.state.steps.first?.status, "completed");
    assert.deepEqual(recovered.attempts[0]?.artifact, artifact);
    assert.equal(recovered.attempts.length, 1);
    assert.equal(
      singleOrchestrationClaim(await restored.claim("fixture-run")).step.stepId,
      "second",
    );
  });
});

for (const bindChild of [false, true]) {
  test(`recover：${bindChild ? "已绑定 child" : "仅 claimed"} 的 running 无 terminal 证据则 interrupted，禁止重放`, async () => {
    await withOrchestrationDirectory(async (directory) => {
      const context = harness(directory);
      await context.store.create(
        orchestrationInput(
          orchestrationPlan([
            orchestrationStep({ stepId: "first" }),
            orchestrationStep({ stepId: "second", dependsOn: ["first"] }),
            orchestrationStep({ stepId: "third", dependsOn: ["second"] }),
          ]),
          { generation: 4 },
        ),
      );
      const artifact = await complete(
        context,
        singleOrchestrationClaim(await context.store.claim("fixture-run")),
      );
      const running = singleOrchestrationClaim(await context.store.claim("fixture-run"));
      const child = {
        agentId: "active-agent",
        taskId: "active-task",
        childSessionId: "active-child",
      };
      if (bindChild) await context.store.bindChild(running.runId, running.attempt.key, child);
      const restored = harness(directory);
      const recovered = await restored.store.recover("fixture-run");
      assert.equal(recovered.status, "interrupted");
      assert.equal(recovered.state.generation, 5);
      assert.equal(recovered.state.steps.first?.status, "completed");
      assert.equal(recovered.state.steps.second?.status, "interrupted");
      assert.equal(recovered.state.steps.second?.attempts, 1);
      assert.equal(recovered.state.steps.third?.status, "pending");
      assert.equal(recovered.attempts.length, 2);
      assert.deepEqual(recovered.attempts[0]?.artifact, artifact);
      assert.equal(recovered.attempts[1]?.status, "interrupted");
      if (bindChild) assert.deepEqual(recovered.attempts[1]?.child, child);
      assert.equal(recovered.events.filter((event) => event.type === "run_interrupted").length, 1);
      assert.deepEqual(await restored.store.recover("fixture-run"), recovered);
      assert.deepEqual(await restored.store.claim("fixture-run"), []);
      assert.equal(
        await restored.store.finish(running.runId, running.attempt.key, 4, {
          status: "failed",
          error: "stale",
        }),
        false,
      );
      assert.equal(
        await restored.store.finish(running.runId, running.attempt.key, 5, {
          status: "failed",
          error: "no evidence",
        }),
        false,
      );
      assert.deepEqual(await restored.store.get("fixture-run"), recovered);
      monotonicEvents(recovered);
    });
  });
}

test("owner：identity、父 session、remote session 隔离，identity trim 和 path fallback 一致", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const owners = [
      orchestrationOwner(directory, { workspaceIdentity: "identity-a" }),
      orchestrationOwner(directory, { workspaceIdentity: "identity-b" }),
      orchestrationOwner(directory, { workspaceIdentity: "identity-a", sessionId: "other-parent" }),
      orchestrationOwner(directory, {
        workspaceIdentity: "identity-a",
        remoteSessionId: "remote-a",
      }),
      orchestrationOwner(directory, {
        workspaceIdentity: "identity-a",
        remoteSessionId: "remote-b",
      }),
    ];
    const contexts = owners.map((owner) => harness(directory, owner));
    assert.equal(
      new Set(contexts.map((context) => context.journal.filePath("fixture-run"))).size,
      owners.length,
    );
    for (const [index, context] of contexts.entries())
      await context.store.create(
        orchestrationInput(orchestrationPlan(undefined, { goal: `Owner ${index}` })),
      );
    for (const [index, context] of contexts.entries())
      assert.equal((await record(context.store)).state.plan.goal, `Owner ${index}`);
    assert.deepEqual(
      await harness(
        directory,
        orchestrationOwner(directory, { workspaceIdentity: "  identity-a  " }),
      ).store.get("fixture-run"),
      await contexts[0]?.store.get("fixture-run"),
    );
    const local = harness(directory);
    const created = await local.store.create(orchestrationInput());
    assert.deepEqual(
      await harness(
        directory,
        orchestrationOwner(directory, { workspaceIdentity: "   " }),
      ).store.get("fixture-run"),
      created,
    );
    const path = local.journal.filePath("../unsafe-run\\nested:name");
    assert.ok(isAbsolute(path));
    assert.ok(
      !isAbsolute(relative(directory, path)) &&
        !relative(directory, path).split(sep).includes(".."),
    );
    assert.ok(!basename(path).includes("unsafe-run"));
  });
});

test("异常 owner：构造拒绝空 workspacePath/sessionId，不创建数据目录", async () => {
  await withOrchestrationDirectory(async (directory) => {
    for (const override of [
      { workspacePath: "" },
      { workspacePath: "   " },
      { sessionId: "" },
      { sessionId: "   " },
    ]) {
      assert.throws(
        () => harness(directory, orchestrationOwner(directory, override)),
        orchestrationError("owner_mismatch"),
      );
    }
    assert.deepEqual(await readdir(directory), []);
  });
});

test("损坏 snapshot/unknown version/owner 篡改：明确错误，历史不当 empty 或被覆盖", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store, journal } = harness(directory);
    const created = await store.create(orchestrationInput());
    const cases = [
      { text: "{broken", code: "invalid_record" },
      { text: "{}", code: "invalid_record" },
      { text: JSON.stringify({ ...created, version: 2 }), code: "unsupported_version" },
      {
        text: JSON.stringify({ ...created, owner: { ...created.owner, sessionId: "wrong-owner" } }),
        code: "owner_mismatch",
      },
      {
        text: JSON.stringify({
          ...created,
          state: {
            ...created.state,
            plan: {
              ...created.state.plan,
              steps: [orchestrationStep({ stepId: "first", dependsOn: ["missing"] })],
            },
          },
        }),
        code: "invalid_record",
      },
      {
        text: JSON.stringify({ ...created, state: { ...created.state, steps: {} } }),
        code: "invalid_record",
      },
      {
        text: JSON.stringify({
          ...created,
          events: [{ sequence: 1, type: "unknown", generation: 0, at: 1 }],
        }),
        code: "invalid_record",
      },
    ] satisfies Array<{ text: string; code: Parameters<typeof orchestrationError>[0] }>;
    for (const damaged of cases) {
      await writeFile(journal.filePath(created.runId), damaged.text, "utf8");
      const restored = harness(directory).store;
      await assert.rejects(restored.get(created.runId), orchestrationError(damaged.code));
      await assert.rejects(restored.recover(created.runId), orchestrationError(damaged.code));
      await assert.rejects(restored.create(orchestrationInput()), orchestrationError(damaged.code));
      assert.equal(await readFile(journal.filePath(created.runId), "utf8"), damaged.text);
    }
  });
});

test("非法计划与执行边界：拒绝而不保存 run；不存在的 run 不伪装成功", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store } = harness(directory);
    const input = orchestrationInput();
    for (const changed of [
      { ...input, team: ["architect"] },
      { ...input, maxConcurrency: 0 },
      { ...input, maxConcurrency: 33 },
      { ...input, maxConcurrency: 1.5 },
      {
        ...input,
        plan: orchestrationPlan([orchestrationStep({ stepId: "first", role: "unknown" })]),
      },
      {
        ...input,
        plan: orchestrationPlan([orchestrationStep({ stepId: "first", dependsOn: ["first"] })]),
      },
      {
        ...input,
        plan: orchestrationPlan([orchestrationStep({ stepId: "first", role: "backend" })]),
      },
    ]) {
      await assert.rejects(store.create(changed), orchestrationError("invalid_plan"));
      assert.equal(await store.get(input.runId), undefined);
    }
    for (const operation of [
      () => store.claim("absent"),
      () => store.cancel("absent"),
      () => store.recover("absent"),
    ])
      await assert.rejects(operation, orchestrationError("not_found"));
  });
});

test("IO commit 失败：create/claim/bind/finish/cancel/recover 都不发布未持久化状态", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const context = harness(directory);
    const journal = new FailingOrchestrationJournal(context.journal);
    const store = new OrchestrationRunStore({
      owner: context.store.owner,
      journal,
      now: orchestrationClock(),
    });
    const failure = new Error("Injected journal commit failure");
    journal.nextCommitError = failure;
    await assert.rejects(store.create(orchestrationInput()), (error: unknown) => error === failure);
    assert.equal(await store.get("fixture-run"), undefined);
    await store.create(orchestrationInput());
    journal.nextCommitError = failure;
    const initial = await record(store);
    await assert.rejects(store.claim("fixture-run"), (error: unknown) => error === failure);
    assert.deepEqual(await record(store), initial);
    const claim = singleOrchestrationClaim(await store.claim("fixture-run"));
    assert.equal(claim.attempt.attempt, 1);
    for (const operation of [
      () => store.bindChild(claim.runId, claim.attempt.key, { agentId: "agent", taskId: "task" }),
      () =>
        store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
          status: "failed",
          error: "failure",
        }),
      () => store.cancel(claim.runId),
      () => store.recover(claim.runId),
    ]) {
      const before = await record(store);
      const text = await readFile(context.journal.filePath(claim.runId), "utf8");
      journal.nextCommitError = failure;
      await assert.rejects(operation, (error: unknown) => error === failure);
      assert.deepEqual(await record(store), before);
      assert.equal(await readFile(context.journal.filePath(claim.runId), "utf8"), text);
    }
  });
});

test("Node IO 失败透传：文件阻塞 root 不创建幽灵 run，移除阻塞后可正常 create", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const rootDirectory = join(directory, "blocked");
    await writeFile(rootDirectory, "not a directory", "utf8");
    const owner = orchestrationOwner(directory);
    const journal = new NodeOrchestrationJournal({ rootDirectory, owner });
    const store = new OrchestrationRunStore({ owner, journal });
    await assert.rejects(
      store.create(orchestrationInput()),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOTDIR" || error.code === "EEXIST"),
    );
    await rm(rootDirectory);
    await mkdir(rootDirectory);
    assert.equal(await store.get("fixture-run"), undefined);
    assert.equal((await store.create(orchestrationInput())).status, "pending");
    assert.equal(singleOrchestrationClaim(await store.claim("fixture-run")).attempt.attempt, 1);
  });
});
