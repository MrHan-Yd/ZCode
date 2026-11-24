import assert from "node:assert/strict";
import test from "node:test";
import { createTraceId, type ModelRequest, type SubagentPort } from "@zcode/contracts";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { isOrchestratorRuntimeConfig } from "../src/orchestration/tool-policy.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import {
  childRequest,
  completedModelResponse,
  fixtureRuntime,
  permissionTestModel,
  withPermissionTestDirectory,
} from "./upstreamRuntimePermissionFixtures.js";

async function runChild(input: {
  mode?: AgentRuntimeConfig["mode"];
  planEnabled?: boolean;
  orchestration?: boolean;
  profileMode?: "auto" | "plan";
  agentType?: string;
  command?: string;
  permissionService?: PermissionService;
}) {
  return withPermissionTestDirectory(async (directory) => {
    const providerRequests: ModelRequest[] = [];
    let count = 0;
    const model = permissionTestModel((request) => {
      providerRequests.push(request);
      if (input.command && count++ === 0) {
        return {
          ...completedModelResponse(""),
          finishReason: "tool-calls",
          toolCalls: [{ id: "fixture-command", name: "Bash", input: { command: input.command } }],
        };
      }
      return completedModelResponse();
    });
    const fixture = fixtureRuntime({
      directory,
      model,
      permissionService: input.permissionService,
      config: {
        mode: input.mode ?? "build",
        planEnabled: input.planEnabled ?? false,
        ...(input.orchestration ? { orchestration: { enabled: true } } : {}),
        subagents: {
          outputRootDir: directory,
          ...(input.profileMode
            ? {
                profiles: [
                  {
                    name: "fixture-profile",
                    source: "user",
                    description: "Fixture profile",
                    systemPrompt: "Return a fixture result",
                    tools: ["*"],
                    permissionMode: input.profileMode,
                  },
                ],
              }
            : {}),
        },
      },
    });
    try {
      const port = fixture.internal.subagentPort;
      assert.ok(port);
      const output = await port.run(
        childRequest(
          fixture.runtime,
          directory,
          input.agentType ?? (input.profileMode ? "fixture-profile" : "Explore"),
        ),
      );
      assert.equal(output.status, "completed");
      return { requests: fixture.requests, commands: fixture.commands, providerRequests };
    } finally {
      fixture.runtime.beginShutdown();
    }
  });
}

test("经典 Explore 在 build 下非只读 Bash 向父会话请求审批", async () => {
  const result = await runChild({ command: "rm fixture.txt" });
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0]?.mode, "build");
  assert.equal(result.requests[0]?.origin?.kind, "subagent");
  assert.deepEqual(result.commands, []);
});

test("经典 Explore 继承父 Plan，非只读 Bash 硬拒绝而不是 yolo 放行", async () => {
  const result = await runChild({ planEnabled: true, command: "rm fixture.txt" });
  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.commands, []);
  assert.match(JSON.stringify(result.providerRequests.at(-1)), /Plan mode only allows read-only/);
});

test("Explore 继承父权限服务的 disallowedTools，安全 Bash 也不能绕过硬禁用", async () => {
  const result = await runChild({
    command: "git status",
    permissionService: new PermissionService({
      ...defaultPermissionConfig,
      disallowedTools: new Set(["Bash"]),
    }),
  });
  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.commands, []);
});

test("Explore 只读 Bash 在 build 和 Plan 下仍可执行，yolo 无 Plan 保持原行为", async () => {
  for (const planEnabled of [false, true]) {
    const result = await runChild({ planEnabled, command: "git status" });
    assert.deepEqual(result.requests, []);
    assert.equal(result.commands.length, 1);
  }
  const yolo = await runChild({ mode: "yolo", command: "rm fixture.txt" });
  assert.deepEqual(yolo.requests, []);
  assert.equal(yolo.commands.length, 1);
});

for (const mode of ["build", "edit", "yolo"] as const) {
  for (const profileMode of ["auto", "plan"] as const) {
    test(`父 ${mode}+Plan 是 ${profileMode} profile 的只读上限`, async () => {
      const result = await runChild({
        mode,
        planEnabled: true,
        profileMode,
        command: "rm fixture.txt",
      });
      assert.deepEqual(result.requests, []);
      assert.deepEqual(result.commands, []);
      assert.match(
        JSON.stringify(result.providerRequests.at(-1)),
        /Plan mode only allows read-only/,
      );
      assert.doesNotMatch(JSON.stringify(result.providerRequests.at(-1)), /Auto mode is reserved/);
    });
  }
}

test("Plan+编排既有 force 分支保持只读，profile auto 不改变它", async () => {
  const result = await runChild({
    mode: "yolo",
    planEnabled: true,
    orchestration: true,
    profileMode: "auto",
    command: "rm fixture.txt",
  });
  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.commands, []);
  assert.match(JSON.stringify(result.providerRequests.at(-1)), /Plan mode only allows read-only/);
});

test("子 profile Plan 仍可收紧非 Plan 父会话；auto 的原 fail-closed 行为保留", async () => {
  const plan = await runChild({ mode: "yolo", profileMode: "plan", command: "rm fixture.txt" });
  assert.deepEqual(plan.commands, []);
  assert.match(JSON.stringify(plan.providerRequests.at(-1)), /Plan mode only allows read-only/);
  const auto = await runChild({ profileMode: "auto", command: "git status" });
  assert.deepEqual(auto.commands, []);
  assert.match(JSON.stringify(auto.providerRequests.at(-1)), /Auto mode is reserved/);
});

test("子 Plan provider 提醒不要求递归派发/根审批；只按实际可见工具建议澄清", async () => {
  const explore = await runChild({ planEnabled: true });
  const exploreReminder = JSON.stringify(explore.providerRequests[0]?.messages);
  assert.match(exploreReminder, /Plan mode is active/);
  assert.doesNotMatch(exploreReminder, /### Phase|ExitPlanMode|AskUserQuestion|Explore agents/);

  const general = await runChild({ planEnabled: true, agentType: "general-purpose" });
  const generalMessages = JSON.stringify(general.providerRequests[0]?.messages);
  assert.match(generalMessages, /AskUserQuestion/);
  assert.doesNotMatch(generalMessages, /### Phase|At the very end of your turn/);
  const tools = new Set(general.providerRequests[0]?.tools?.map((tool) => tool.name));
  for (const name of ["Bash", "Write", "Edit", "AskUserQuestion"]) assert.ok(tools.has(name), name);
  for (const name of [
    "Agent",
    "Task",
    "CreateOrchestrationPlan",
    "EnterPlanMode",
    "ExitPlanMode",
  ]) {
    assert.equal(tools.has(name), false, name);
  }
});

test("SendMessage 恢复 child 用父当前完整执行状态，旧 yolo/Plan entry 不能覆盖", async () => {
  await withPermissionTestDirectory(async (directory) => {
    let calls = 0;
    const providerRequests: ModelRequest[] = [];
    const model = permissionTestModel((request) => {
      providerRequests.push(request);
      if (++calls === 2)
        return {
          ...completedModelResponse(""),
          finishReason: "tool-calls",
          toolCalls: [
            { id: "fixture-resumed-command", name: "Bash", input: { command: "rm fixture.txt" } },
          ],
        };
      return completedModelResponse();
    });
    const fixture = fixtureRuntime({ directory, model, config: { mode: "yolo" } });
    const port = fixture.internal.subagentPort as SubagentPort;
    try {
      const output = await port.run(childRequest(fixture.runtime, directory, "general-purpose"));
      assert.equal(output.status, "completed");
      await fixture.runtime.setExecutionState({ mode: "build", planEnabled: true });
      const sent = await port.sendMessage!({
        ...childRequest(fixture.runtime, directory),
        to: output.agentId,
        summary: "Resume fixture",
        message: "Continue under the current parent permission",
        trace: { traceId: createTraceId(), sessionId: fixture.internal.sessionId },
      });
      assert.equal(sent.delivery, "resumed_background");
      const terminal = await port.waitForTask!(output.agentId);
      assert.equal(terminal?.status, "completed");
      assert.deepEqual(fixture.requests, []);
      assert.deepEqual(fixture.commands, []);
      assert.match(JSON.stringify(providerRequests.at(-1)), /Plan mode only allows read-only/);
    } finally {
      fixture.runtime.beginShutdown();
    }
  });
});

test("编排 child 保持 default 角色与工作区身份，父硬工具白名单不泄漏成子工具缩减", async () => {
  const result = await runChild({ orchestration: true, agentType: "general-purpose" });
  const names = new Set(result.providerRequests[0]?.tools?.map((tool) => tool.name));
  assert.ok(names.has("Write"));
  assert.ok(names.has("Bash"));
  assert.equal(names.has("CreateOrchestrationPlan"), false);
  assert.equal(
    isOrchestratorRuntimeConfig({ taskType: "subagent_child", orchestration: { enabled: true } }),
    false,
  );
  // 既有 workspace 持久化回归单独执行；本例只约束实际 provider 工具面，不模拟角色字段。
  const config: Partial<AgentRuntimeInternal["config"]> = {
    taskType: "subagent_child",
    orchestration: { enabled: false },
  };
  assert.equal(isOrchestratorRuntimeConfig(config), false);
});
