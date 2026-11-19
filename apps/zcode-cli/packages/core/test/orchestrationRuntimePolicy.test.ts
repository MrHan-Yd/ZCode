import assert from "node:assert/strict";
import test from "node:test";
import { createSessionId } from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/runtime/deps.js";
import { registerBuiltInTools } from "../src/tool/handlers/index.js";
import { writeToolEntry } from "../src/tool/handlers/write.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { createToolExecutor } from "../src/tool/executor.js";
import {
  AMEND_ORCHESTRATION_PLAN_TOOL_NAME,
  CANCEL_ORCHESTRATION_RUN_TOOL_NAME,
  CREATE_ORCHESTRATION_PLAN_TOOL_NAME,
  ORCHESTRATOR_ALLOWED_TOOL_NAMES,
  DEFAULT_ORCHESTRATION_TEAM,
  isOrchestrationHardDeniedTool,
  isOrchestratorRuntimeConfig,
  resolveOrchestrationTeam,
  resolveOrchestrationWritableRoles,
  resolveOrchestratorHiddenToolNames,
  shouldForceOrchestrationReadOnly,
} from "../src/orchestration/tool-policy.js";

test("provider 边界：编排主会话隐藏白名单之外的工具，registry 仍保持完整", () => {
  const registered = [
    ...ORCHESTRATOR_ALLOWED_TOOL_NAMES,
    "Edit",
    "Write",
    "Bash",
    "Agent",
    "Task",
    "js",
    "mcp__server__tool",
  ];
  const hidden = resolveOrchestratorHiddenToolNames(registered, {
    orchestration: { enabled: true },
  });
  assert.deepEqual(
    [...(hidden ?? [])].sort(),
    ["Agent", "Bash", "Edit", "Task", "Write", "js", "mcp__server__tool"].sort(),
  );
  assert.equal(
    resolveOrchestratorHiddenToolNames(registered, { orchestration: { enabled: false } }),
    undefined,
  );
});

test("subagent child 即使带 orchestration 配置也不会隐藏任何工具", () => {
  const hidden = resolveOrchestratorHiddenToolNames(["Read", "Write", "Bash"], {
    orchestration: { enabled: true },
    taskType: "subagent_child",
  });
  assert.equal(hidden, undefined);
  assert.equal(
    isOrchestratorRuntimeConfig({
      orchestration: { enabled: true },
      taskType: "subagent_child",
    }),
    false,
  );
});

test("注册面：主会话 registry 保持完整，includeOrchestration 只决定三个规划工具", () => {
  const registry = createToolRegistry();
  registerBuiltInTools(registry, {
    includeOrchestration: true,
    includeAgent: true,
    embeddedSearchEnabled: false,
  });
  const names = new Set(registry.list());
  assert.ok(names.has(CREATE_ORCHESTRATION_PLAN_TOOL_NAME));
  assert.ok(names.has(AMEND_ORCHESTRATION_PLAN_TOOL_NAME));
  assert.ok(names.has(CANCEL_ORCHESTRATION_RUN_TOOL_NAME));
  // DAG 子代理通过父 runtime 的实际工具表继承 allowedTools:["*"]，写工具必须在 registry 里。
  for (const name of ["Edit", "Write", "Bash", "Agent"]) {
    assert.equal(names.has(name), true, `${name} must stay registered for child inheritance`);
  }

  const classic = createToolRegistry();
  registerBuiltInTools(classic, {
    includeOrchestration: false,
    allowedTools: [CREATE_ORCHESTRATION_PLAN_TOOL_NAME],
  });
  assert.equal(classic.list().includes(CREATE_ORCHESTRATION_PLAN_TOOL_NAME), false);
});

test("executor 硬拒绝：即使工具已注册，编排会话调用 Write 也在 handler 之前被拒", async () => {
  const registry = createToolRegistry();
  registry.register(writeToolEntry);
  const executor = createToolExecutor({
    registry,
    permissionService: new PermissionService(defaultPermissionConfig),
    emitEvent: async () => undefined,
    sessionId: createSessionId("orchestration-denied-session"),
    hardAllowedToolNames: ORCHESTRATOR_ALLOWED_TOOL_NAMES,
    getWorkingDirectory: () => "/workspace",
    getWorkspaceRoot: () => "/workspace",
    getMode: () => "build",
  });
  const result = await executor.execute({
    id: "tool-denied",
    name: "Write",
    input: { file_path: "/workspace/a.txt", content: "should not be written" },
  });
  assert.equal(result.success, false);
  assert.equal(result.error?.type, "permission_denied");
  assert.match(result.error?.message ?? "", /disabled in orchestration mode/);
});

test("团队校验：通用角色隐式保留，未知角色与重复角色仍被拒", () => {
  assert.deepEqual(resolveOrchestrationTeam(undefined), [...DEFAULT_ORCHESTRATION_TEAM]);
  assert.deepEqual(resolveOrchestrationTeam([]), [...DEFAULT_ORCHESTRATION_TEAM]);
  assert.deepEqual(DEFAULT_ORCHESTRATION_TEAM, ["general-purpose", "Explore", "reviewer"]);
  assert.deepEqual(resolveOrchestrationTeam(["Explore"]), ["general-purpose", "Explore"]);
  assert.deepEqual(resolveOrchestrationTeam(["tester", "reviewer"]), [
    "general-purpose",
    "Explore",
    "tester",
    "reviewer",
  ]);
  assert.deepEqual(resolveOrchestrationTeam(["general-purpose", "tester"]), [
    "general-purpose",
    "Explore",
    "tester",
  ]);
  assert.throws(() => resolveOrchestrationTeam(["general-purpose", "nope"]), /not a built-in/);
  assert.throws(
    () => resolveOrchestrationTeam(["general-purpose", "general-purpose"]),
    /more than once/,
  );
  assert.throws(
    () =>
      resolveOrchestrationTeam([
        "architect",
        "frontend",
        "backend",
        "ui-designer",
        "tester",
        "reviewer",
        "extra",
      ]),
    /not a built-in/,
  );
  assert.throws(() => resolveOrchestrationTeam(["tester", ""]), /empty role/);
  assert.deepEqual(resolveOrchestrationWritableRoles(["general-purpose", "Explore", "tester"]), [
    "general-purpose",
    "tester",
  ]);
});

test("硬拒绝判定与 Plan 只读隔离", () => {
  for (const name of ["Edit", "Write", "Bash", "Agent", "Task", "js"]) {
    assert.equal(isOrchestrationHardDeniedTool(name), true, name);
  }
  assert.equal(isOrchestrationHardDeniedTool("Read"), false);
  assert.equal(
    shouldForceOrchestrationReadOnly({
      orchestrationEnabled: true,
      planEnabled: false,
      parentMode: "plan",
    }),
    true,
  );
  assert.equal(
    shouldForceOrchestrationReadOnly({
      orchestrationEnabled: true,
      planEnabled: true,
      parentMode: "build",
    }),
    true,
  );
  assert.equal(
    shouldForceOrchestrationReadOnly({
      orchestrationEnabled: false,
      planEnabled: true,
      parentMode: "plan",
    }),
    false,
  );
});
