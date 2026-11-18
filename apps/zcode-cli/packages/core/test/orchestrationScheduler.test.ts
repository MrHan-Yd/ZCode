import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestrationPlan, OrchestrationStep } from "@zcode/shared";
import {
  cancelRun,
  claimRunnableSteps,
  completeStep,
  createInitialRunState,
  failStep,
  isRunTerminal,
  summarizeRun,
} from "../src/orchestration/scheduler.js";

function step(
  overrides: Partial<OrchestrationStep> & Pick<OrchestrationStep, "stepId" | "role">,
): OrchestrationStep {
  return {
    stepId: overrides.stepId,
    title: overrides.title ?? overrides.stepId,
    role: overrides.role,
    task: overrides.task ?? `Do ${overrides.stepId}`,
    dependsOn: overrides.dependsOn ?? [],
    ...(overrides.writeScope ? { writeScope: overrides.writeScope } : {}),
    ...(overrides.maxAttempts !== undefined ? { maxAttempts: overrides.maxAttempts } : {}),
    ...(overrides.optional !== undefined ? { optional: overrides.optional } : {}),
  };
}

function plan(steps: OrchestrationStep[]): OrchestrationPlan {
  return { planId: "plan-1", revision: 0, goal: "Ship it", steps };
}

let clock = 1_000;
function tick(): number {
  clock += 1;
  return clock;
}

test("顺序 DAG：architecture 完成前 design/frontend 不启动", () => {
  const run = createInitialRunState(
    plan([
      step({ stepId: "architecture", role: "architect" }),
      step({ stepId: "design", role: "ui-designer", dependsOn: ["architecture"] }),
      step({
        stepId: "frontend",
        role: "frontend",
        dependsOn: ["architecture", "design"],
        writeScope: ["apps/web"],
      }),
    ]),
    { now: tick() },
  );

  assert.deepEqual(claimRunnableSteps(run, { now: tick() }), ["architecture"]);
  completeStep(run, "architecture", { now: tick() });
  assert.deepEqual(claimRunnableSteps(run, { now: tick() }), ["design"]);
  completeStep(run, "design", { now: tick() });
  assert.deepEqual(claimRunnableSteps(run, { now: tick() }), ["frontend"]);
});

test("契约完成后前后端并行；写范围不重叠时同时启动", () => {
  const run = createInitialRunState(
    plan([
      step({ stepId: "architecture", role: "architect" }),
      step({
        stepId: "frontend",
        role: "frontend",
        dependsOn: ["architecture"],
        writeScope: ["apps/web"],
      }),
      step({
        stepId: "backend",
        role: "backend",
        dependsOn: ["architecture"],
        writeScope: ["apps/api"],
      }),
    ]),
    { now: tick() },
  );

  claimRunnableSteps(run, { maxConcurrency: 3, now: tick() });
  completeStep(run, "architecture", { now: tick() });
  assert.deepEqual(claimRunnableSteps(run, { maxConcurrency: 3, now: tick() }), [
    "frontend",
    "backend",
  ]);
});

test("写范围重叠时串行：先启动声明在前的步骤，完成后再启动另一个", () => {
  const run = createInitialRunState(
    plan([
      step({ stepId: "architecture", role: "architect" }),
      step({
        stepId: "frontend",
        role: "frontend",
        dependsOn: ["architecture"],
        writeScope: ["apps"],
      }),
      step({
        stepId: "backend",
        role: "backend",
        dependsOn: ["architecture"],
        writeScope: ["apps/api"],
      }),
    ]),
    { now: tick() },
  );

  claimRunnableSteps(run, { maxConcurrency: 3, now: tick() });
  completeStep(run, "architecture", { now: tick() });
  assert.deepEqual(claimRunnableSteps(run, { maxConcurrency: 3, now: tick() }), ["frontend"]);
  completeStep(run, "frontend", { now: tick() });
  assert.deepEqual(claimRunnableSteps(run, { maxConcurrency: 3, now: tick() }), ["backend"]);
});

test("等价写范围必须串行，包括点段、大小写与 workspace 根别名", () => {
  for (const alias of ["other/../src", "src/./", "other\\..\\src", "SRC", ".", "src/..", "src/**"]) {
    const run = createInitialRunState(plan([
      step({ stepId: "first", role: "backend", writeScope: ["src"] }),
      step({ stepId: "second", role: "backend", writeScope: [alias] }),
    ]), { now: tick() });
    assert.deepEqual(claimRunnableSteps(run, { maxConcurrency: 2, now: tick() }), ["first"]);
    completeStep(run, "first", { now: tick() });
    assert.deepEqual(claimRunnableSteps(run, { maxConcurrency: 2, now: tick() }), ["second"]);
  }
});

test("join：tester 必须等 frontend 与 backend 都完成", () => {
  const run = createInitialRunState(
    plan([
      step({ stepId: "architecture", role: "architect" }),
      step({
        stepId: "frontend",
        role: "frontend",
        dependsOn: ["architecture"],
        writeScope: ["apps/web"],
      }),
      step({
        stepId: "backend",
        role: "backend",
        dependsOn: ["architecture"],
        writeScope: ["apps/api"],
      }),
      step({
        stepId: "test",
        role: "tester",
        dependsOn: ["frontend", "backend"],
        writeScope: ["tests"],
      }),
    ]),
    { now: tick() },
  );

  claimRunnableSteps(run, { maxConcurrency: 3, now: tick() });
  completeStep(run, "architecture", { now: tick() });
  assert.deepEqual(claimRunnableSteps(run, { maxConcurrency: 3, now: tick() }), [
    "frontend",
    "backend",
  ]);
  completeStep(run, "frontend", { now: tick() });
  assert.deepEqual(claimRunnableSteps(run, { maxConcurrency: 3, now: tick() }), []);
  completeStep(run, "backend", { now: tick() });
  assert.deepEqual(claimRunnableSteps(run, { maxConcurrency: 3, now: tick() }), ["test"]);
});

test("失败重试：maxAttempts=1 时失败一次回 pending，第二次失败才 failed 并阻塞依赖", () => {
  const run = createInitialRunState(
    plan([
      step({ stepId: "frontend", role: "frontend", writeScope: ["src"], maxAttempts: 1 }),
      step({
        stepId: "test",
        role: "tester",
        dependsOn: ["frontend"],
        writeScope: ["tests"],
      }),
    ]),
    { now: tick() },
  );

  assert.deepEqual(claimRunnableSteps(run, { now: tick() }), ["frontend"]);
  failStep(run, "frontend", "boom", { now: tick() });
  assert.equal(run.steps.frontend?.status, "pending");
  assert.equal(run.steps.frontend?.attempts, 1);

  assert.deepEqual(claimRunnableSteps(run, { now: tick() }), ["frontend"]);
  failStep(run, "frontend", "boom again", { now: tick() });
  assert.equal(run.steps.frontend?.status, "failed");
  assert.equal(run.steps.test?.status, "blocked");
  assert.equal(run.steps.test?.error, "Blocked by dependency frontend.");
});

test("optional 步骤失败不阻塞依赖它的步骤", () => {
  const run = createInitialRunState(
    plan([
      step({
        stepId: "optional-review",
        role: "reviewer",
        maxAttempts: 0,
        optional: true,
      }),
      step({
        stepId: "test",
        role: "tester",
        dependsOn: ["optional-review"],
        writeScope: ["tests"],
      }),
    ]),
    { now: tick() },
  );

  claimRunnableSteps(run, { now: tick() });
  failStep(run, "optional-review", "review unavailable", { now: tick() });
  assert.equal(run.steps["optional-review"]?.status, "failed");
  assert.deepEqual(claimRunnableSteps(run, { now: tick() }), ["test"]);
});

test("取消：running 与 pending 都变 cancelled，之后不再 claim", () => {
  const run = createInitialRunState(
    plan([
      step({ stepId: "frontend", role: "frontend", writeScope: ["src"] }),
      step({ stepId: "backend", role: "backend", writeScope: ["api"] }),
    ]),
    { now: tick() },
  );

  claimRunnableSteps(run, { maxConcurrency: 1, now: tick() });
  cancelRun(run, { now: tick() });
  assert.equal(run.steps.frontend?.status, "cancelled");
  assert.equal(run.steps.backend?.status, "cancelled");
  assert.deepEqual(claimRunnableSteps(run, { now: tick() }), []);
  assert.equal(isRunTerminal(run), true);
});

test("maxConcurrency 限制同时 claim 的数量", () => {
  const run = createInitialRunState(
    plan([
      step({ stepId: "a", role: "architect" }),
      step({ stepId: "b", role: "reviewer" }),
      step({ stepId: "c", role: "ui-designer" }),
    ]),
    { now: tick() },
  );

  assert.deepEqual(claimRunnableSteps(run, { maxConcurrency: 2, now: tick() }), ["a", "b"]);
  completeStep(run, "a", { now: tick() });
  assert.deepEqual(claimRunnableSteps(run, { maxConcurrency: 2, now: tick() }), ["c"]);
});

test("summarizeRun 汇总状态与尝试次数", () => {
  const run = createInitialRunState(
    plan([
      step({ stepId: "a", role: "architect" }),
      step({ stepId: "b", role: "frontend", dependsOn: ["a"], writeScope: ["src"] }),
    ]),
    { now: tick() },
  );
  claimRunnableSteps(run, { now: tick() });
  completeStep(run, "a", { now: tick() });
  claimRunnableSteps(run, { now: tick() });

  const summary = summarizeRun(run);
  assert.equal(summary.total, 2);
  assert.equal(summary.completed, 1);
  assert.equal(summary.running, 1);
  assert.equal(summary.attempts, 2);
});
