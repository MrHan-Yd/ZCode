import assert from "node:assert/strict";
import test from "node:test";
import { BUILT_IN_SUBAGENT_NAMES } from "./subagents-types.js";
import {
  parseOrchestrationPlan,
  normalizeWriteScope,
  validateOrchestrationPlan,
  writeScopesOverlap,
  type OrchestrationPlan,
  type OrchestrationStep,
} from "./orchestration.js";
const TEAM = [...BUILT_IN_SUBAGENT_NAMES];
const WRITABLE_ROLES = ["general-purpose", "frontend", "backend", "tester"];

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
    ...(overrides.acceptance ? { acceptance: overrides.acceptance } : {}),
    ...(overrides.maxAttempts !== undefined ? { maxAttempts: overrides.maxAttempts } : {}),
    ...(overrides.optional !== undefined ? { optional: overrides.optional } : {}),
  };
}

function plan(steps: OrchestrationStep[]): OrchestrationPlan {
  return { planId: "plan-1", revision: 0, goal: "Ship it", steps };
}

function validate(steps: OrchestrationStep[]) {
  return validateOrchestrationPlan(plan(steps), {
    team: TEAM,
    writableRoles: WRITABLE_ROLES,
  });
}

test("合法的顺序 DAG 没有 issue", () => {
  const result = validate([
    step({ stepId: "architecture", role: "architect" }),
    step({ stepId: "design", role: "ui-designer", dependsOn: ["architecture"] }),
    step({
      stepId: "frontend",
      role: "frontend",
      dependsOn: ["architecture", "design"],
      writeScope: ["apps/web"],
    }),
    step({ stepId: "test", role: "tester", dependsOn: ["frontend"], writeScope: ["apps/web"] }),
  ]);

  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.warnings, []);
});

test("依赖环、未知依赖、自依赖、重复依赖都会报错", () => {
  const result = validate([
    step({ stepId: "a", role: "frontend", writeScope: ["src"], dependsOn: ["b"] }),
    step({ stepId: "b", role: "frontend", writeScope: ["src"], dependsOn: ["a"] }),
    step({ stepId: "c", role: "frontend", writeScope: ["src"], dependsOn: ["missing"] }),
    step({ stepId: "d", role: "frontend", writeScope: ["src"], dependsOn: ["d"] }),
    step({ stepId: "e", role: "frontend", writeScope: ["src"], dependsOn: ["a", "a"] }),
  ]);

  const codes = new Set(result.issues.map((issue) => issue.code));
  assert.equal(codes.has("cycle"), true);
  assert.equal(codes.has("unknown_dependency"), true);
  assert.equal(codes.has("self_dependency"), true);
  assert.equal(codes.has("duplicate_dependency"), true);
});

test("重复 stepId、角色不在团队、可写步骤缺少 writeScope 都会报错", () => {
  const result = validate([
    step({ stepId: "same", role: "frontend", writeScope: ["src"] }),
    step({ stepId: "same", role: "backend", writeScope: ["src"] }),
    step({ stepId: "outsider", role: "unknown-role", writeScope: ["src"] }),
    step({ stepId: "no-scope", role: "backend" }),
  ]);

  const codes = new Set(result.issues.map((issue) => issue.code));
  assert.equal(codes.has("duplicate_step_id"), true);
  assert.equal(codes.has("role_not_in_team"), true);
  assert.equal(codes.has("missing_write_scope"), true);
});

test("可能并行的步骤写范围重叠只产生 warning；有依赖关系时不警告", () => {
  const parallel = validate([
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
  ]);
  assert.equal(parallel.warnings.length, 1);
  assert.deepEqual(parallel.warnings[0]?.stepIds, ["frontend", "backend"]);
  assert.deepEqual(parallel.issues, []);

  const serial = validate([
    step({ stepId: "frontend", role: "frontend", writeScope: ["apps"] }),
    step({
      stepId: "backend",
      role: "backend",
      dependsOn: ["frontend"],
      writeScope: ["apps"],
    }),
  ]);
  assert.deepEqual(serial.warnings, []);
});

test("writeScopesOverlap 支持目录前缀与通配", () => {
  assert.equal(writeScopesOverlap(["apps/web"], ["apps/web/src"]), true);
  assert.equal(writeScopesOverlap(["apps/web"], ["apps/api"]), false);
  assert.equal(writeScopesOverlap(["*"], ["apps/api"]), true);
  assert.equal(writeScopesOverlap(["apps\\web\\"], ["apps/web/src"]), true);
  assert.equal(writeScopesOverlap(undefined, ["apps/web"]), false);
});

test("写范围点段、分隔符及目录 glob 别名规范化后仍检测冲突", () => {
  for (const alias of [
    "other/../src",
    "src/./",
    "./other/../src",
    "other\\..\\src",
    "src//",
    "src/**",
    "SRC",
  ]) {
    assert.equal(normalizeWriteScope(alias), "src");
    assert.equal(writeScopesOverlap(["src"], [alias]), true);
  }
  assert.equal(normalizeWriteScope("apps/api/../web"), "apps/web");
  assert.equal(writeScopesOverlap(["apps/api/../web"], ["apps/api"]), false);
  const result = validate([
    step({ stepId: "first", role: "backend", writeScope: ["src"] }),
    step({ stepId: "second", role: "backend", writeScope: ["other/../src"] }),
  ]);
  assert.deepEqual(result.issues, []);
  assert.equal(result.warnings.length, 1);
});

test("Win32 尾随点/空格与 Unicode 归一化别名不能绕过串行", () => {
  for (const alias of [
    "src.",
    "src ",
    "src. ",
    "src .",
    "src . ",
    "./src./",
    "SRC.",
    "other/../src ",
  ]) {
    assert.equal(normalizeWriteScope(alias), "src");
    assert.equal(writeScopesOverlap(["src"], [alias]), true);
  }
  for (const alias of ["a/ . /b", "a/. ./b", "a/.. ./b"]) {
    assert.equal(normalizeWriteScope(alias), "a/b");
    assert.equal(writeScopesOverlap(["a/b"], [alias]), true);
    assert.equal(writeScopesOverlap(["a"], [alias]), true);
  }
  assert.equal(normalizeWriteScope("a /b"), "a/b");
  assert.equal(normalizeWriteScope("a/.. /b"), "b");
  assert.equal(normalizeWriteScope("a/.../b"), "a/b");
  assert.equal(normalizeWriteScope("a/... /b"), "a/b");
  // macOS 默认按归一化形式比较文件名：NFC 与 NFD 的同一名称必须视为同一范围。
  assert.equal(normalizeWriteScope("cafe\u0301"), normalizeWriteScope("caf\u00e9"));
  assert.equal(writeScopesOverlap(["caf\u00e9"], ["cafe\u0301"]), true);
  assert.equal(writeScopesOverlap(["caf\u00e9/child"], ["cafe\u0301"]), true);
});

test("workspace 根范围别名都是全范围，不能并行写入任意目录", () => {
  for (const root of [".", "./", "src/..", "src/../.", "src/../**", "**", "*"]) {
    assert.equal(normalizeWriteScope(root), "*");
    assert.equal(writeScopesOverlap([root], ["apps/api/file.ts"]), true);
  }
});

test("写范围拒绝绝对、drive-relative、越界和未定义 glob", () => {
  for (const scope of [
    "../src",
    "src/../../other",
    "/src",
    "C:/src",
    "C:src",
    "\\\\server\\share",
    "src/*.ts",
    "src/**/file.ts",
    "src/?.ts",
    "",
  ]) {
    assert.throws(() => normalizeWriteScope(scope));
    if (!scope) continue;
    const result = validate([step({ stepId: "first", role: "backend", writeScope: [scope] })]);
    assert.ok(result.issues.some((issue) => issue.code === "invalid_write_scope"));
  }
});

test("显式 inputs 只允许依赖祖先且不能重复引用", () => {
  const validPlan = plan([
    step({ stepId: "contract", role: "architect" }),
    step({ stepId: "backend", role: "backend", writeScope: ["api"], dependsOn: ["contract"] }),
    {
      ...step({ stepId: "test", role: "tester", writeScope: ["tests"], dependsOn: ["backend"] }),
      inputs: ["contract"],
    },
  ]);
  assert.deepEqual(
    validateOrchestrationPlan(validPlan, { team: TEAM, writableRoles: WRITABLE_ROLES }).issues,
    [],
  );

  for (const inputs of [["future"], ["missing"], ["test"], ["contract", "contract"]]) {
    const invalidPlan = plan([
      ...validPlan.steps.slice(0, 2),
      { ...validPlan.steps[2]!, inputs },
      step({ stepId: "future", role: "reviewer", dependsOn: ["test"] }),
    ]);
    const result = validateOrchestrationPlan(invalidPlan, {
      team: TEAM,
      writableRoles: WRITABLE_ROLES,
    });
    assert.ok(result.issues.some((issue) => issue.code === "invalid_input_dependency"));
  }
});

test("schema 拒绝非法 stepId 和空步骤集", () => {
  assert.equal(
    parseOrchestrationPlan({
      planId: "p",
      revision: 0,
      goal: "g",
      steps: [step({ stepId: "BadId", role: "frontend", writeScope: ["src"] })],
    }).success,
    false,
  );
  assert.equal(
    parseOrchestrationPlan({ planId: "p", revision: 0, goal: "g", steps: [] }).success,
    false,
  );
});
