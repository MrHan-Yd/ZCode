import assert from "node:assert/strict";
import test from "node:test";
import { createSessionId, createTraceId } from "@zcode/contracts";
import type { OrchestrationPlan } from "@zcode/shared";
import type {
  OrchestrationRunRecord,
  OrchestrationToolPort,
} from "../src/orchestration/contract.js";
import type { OrchestrationDispatchContext } from "../src/orchestration/dispatch-port.js";
import {
  amendOrchestrationPlanToolEntry,
  cancelOrchestrationRunToolEntry,
  createOrchestrationPlanToolEntry,
} from "../src/orchestration/tools.js";
import type { ToolExecutionContext } from "../src/tool/types.js";
import { orchestrationPlan, orchestrationStep } from "./orchestrationFixtures.js";

const TEAM = ["general-purpose", "Explore", "tester"];

function plan(): OrchestrationPlan {
  return orchestrationPlan([
    orchestrationStep({ stepId: "build", role: "general-purpose", writeScope: ["src"] }),
  ]);
}

function record(runId: string, value: OrchestrationPlan, revision = value.revision) {
  return {
    version: 1,
    runId,
    owner: { workspacePath: "/ws", sessionId: "session-1" },
    team: TEAM,
    writableRoles: ["general-purpose", "tester"],
    maxConcurrency: 3,
    status: "pending",
    state: {
      plan: { ...value, revision },
      generation: 0,
      startedAt: 1,
      updatedAt: 1,
      cancelled: false,
      steps: Object.fromEntries(
        value.steps.map((step) => [
          step.stepId,
          { stepId: step.stepId, status: "pending", attempts: 0 },
        ]),
      ),
    },
    attempts: [],
    events: [],
  } as OrchestrationRunRecord;
}

function contextWith(service: OrchestrationToolPort | undefined): ToolExecutionContext {
  return {
    toolCallId: "tool-1",
    traceId: createTraceId(),
    abortSignal: new AbortController().signal,
    sessionId: createSessionId("session-1"),
    workingDirectory: "/ws",
    workspaceRoot: "/ws",
    ...(service ? { orchestrationService: service } : {}),
  } as unknown as ToolExecutionContext;
}

function fakeService(overrides: Partial<OrchestrationToolPort> = {}): OrchestrationToolPort & {
  calls: { start: OrchestrationPlan[]; amend: string[]; cancel: string[] };
} {
  const calls = { start: [] as OrchestrationPlan[], amend: [] as string[], cancel: [] as string[] };
  const service: OrchestrationToolPort = {
    start: async (input: { plan: unknown; context: OrchestrationDispatchContext }) => {
      const value = input.plan as OrchestrationPlan;
      calls.start.push(value);
      return record("run-created", value);
    },
    amend: async (input: { runId: string; plan: unknown }) => {
      calls.amend.push(input.runId);
      return record("run-amended", input.plan as OrchestrationPlan, 1);
    },
    cancel: async (runId: string) => {
      calls.cancel.push(runId);
      return { ...record(runId, plan()), status: "cancelled" } as OrchestrationRunRecord;
    },
    get: async (runId: string) => record(runId, plan()),
    ...overrides,
  };
  return Object.assign(service, { calls });
}

test("Create 工具返回 async_launched 并把模型计划原样交给用例层", async () => {
  const service = fakeService();
  const output = (await createOrchestrationPlanToolEntry.handler(
    { plan: plan() },
    contextWith(service),
  )) as Record<string, unknown>;
  assert.equal(output.status, "async_launched");
  assert.equal(output.runId, "run-created");
  assert.equal(output.planId, "fixture-plan");
  assert.equal(output.stepCount, 1);
  assert.equal(service.calls.start.length, 1);
});

test("Amend 工具要求 runId，并保持同一 run 身份", async () => {
  const service = fakeService();
  const output = (await amendOrchestrationPlanToolEntry.handler(
    { runId: "run-previous", plan: plan() },
    contextWith(service),
  )) as Record<string, unknown>;
  assert.equal(output.runId, "run-amended");
  assert.equal("previousRunId" in output, false);
  assert.deepEqual(service.calls.amend, ["run-previous"]);
});

test("Cancel 工具输出实际 run 状态与步骤汇总", async () => {
  const service = fakeService();
  const output = (await cancelOrchestrationRunToolEntry.handler(
    { runId: "run-cancelled" },
    contextWith(service),
  )) as Record<string, unknown>;
  assert.equal(output.status, "cancelled");
  assert.deepEqual(service.calls.cancel, ["run-cancelled"]);
  assert.ok(output.summary);
});

test("缺少 runId 时返回 invalid_input；缺少编排运行时返回 configuration_error", async () => {
  await assert.rejects(
    cancelOrchestrationRunToolEntry.handler({ runId: "  " }, contextWith(fakeService())),
    (error: unknown) => (error as { type?: string }).type === "invalid_input",
  );
  await assert.rejects(
    createOrchestrationPlanToolEntry.handler({ plan: plan() }, contextWith(undefined)),
    (error: unknown) => (error as { type?: string }).type === "configuration_error",
  );
});

test("工具 schema 是可校验的计划结构，输出声明 async_launched", () => {
  const input = createOrchestrationPlanToolEntry.inputSchema as {
    required?: string[];
    properties?: Record<string, unknown>;
  };
  assert.deepEqual(input.required, ["plan"]);
  const output = createOrchestrationPlanToolEntry.outputSchema as {
    properties?: { status?: { const?: string } };
  };
  assert.equal(output.properties?.status?.const, "async_launched");
});
