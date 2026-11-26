import assert from "node:assert/strict";
import test from "node:test";
import { createSessionId, createTraceId, type SubagentTaskSnapshot } from "@zcode/contracts";
import { stopBackgroundTask } from "../src/runtime/methods/background.js";
import type { RuntimeBackgroundStopResult } from "../src/runtime/methods/background-stop-types.js";
import {
  InMemoryRuntimeTaskRegistry,
  type RuntimeTaskSnapshot,
} from "../src/runtime-task/registry.js";

/**
 * 恢复后的子智能体必须真的停得掉（specs/status-panel-subagent-stop.md）。
 *
 * SendMessage 恢复复用同一个 agentId/taskId，只发 SubagentSpawned(resumed) 而不发新的
 * BackgroundTaskStarted；投影里上一轮的终态条目仍然留着。terminal 判定若把投影终态也算进来，
 * 正在运行的 registry 任务会被判成 alreadyTerminal，Stop 被拒绝且 child 继续跑。
 */

const TASK_ID = "agent-resumed";
const SESSION_ID = createSessionId("stop-resumed-parent");

function runningTask(): RuntimeTaskSnapshot {
  return {
    taskId: TASK_ID,
    agentId: TASK_ID,
    agentType: "general-purpose",
    description: "恢复后的子智能体",
    isBackgrounded: true,
    parentSessionId: SESSION_ID,
    parentToolCallId: "tool-1",
    prompt: "resume work",
    startedAt: new Date(1_000),
    status: "running",
    taskType: "local_agent",
    traceContext: { traceId: createTraceId() },
    type: "local_agent",
  };
}

function staleProjection() {
  return {
    backgroundTasks: [
      {
        cancellable: false,
        command: "恢复后的子智能体",
        completedAt: new Date(2_000),
        description: "恢复后的子智能体",
        startedAt: new Date(1_000),
        status: "completed" as const,
        taskId: TASK_ID,
        toolCallId: "tool-1",
        toolName: "Agent",
      },
    ],
  };
}

function fakeRuntime(input: {
  registryTask?: RuntimeTaskSnapshot;
  projection: ReturnType<typeof staleProjection>;
  stopResult: SubagentTaskSnapshot;
}) {
  const calls: string[] = [];
  const runtime = {
    logger: undefined,
    rebuildProjection: async () => input.projection,
    rootTraceContext: { traceId: createTraceId() },
    runtimeTaskRegistry: new InMemoryRuntimeTaskRegistry(),
    subagentPort: {
      stopTask: async (taskId: string) => {
        calls.push(taskId);
        return input.stopResult;
      },
    },
  };
  if (input.registryTask) runtime.runtimeTaskRegistry.register(input.registryTask);
  return { calls, runtime };
}

function stop(runtime: object): Promise<RuntimeBackgroundStopResult> {
  return stopBackgroundTask.call(runtime as never, TASK_ID, { initiator: "user" });
}

test("registry 仍在跑、投影只剩上一轮终态时仍执行停止，不被 alreadyTerminal 拦下", async () => {
  const { calls, runtime } = fakeRuntime({
    projection: staleProjection(),
    registryTask: runningTask(),
    stopResult: {
      agentId: TASK_ID,
      agentType: "general-purpose",
      description: "恢复后的子智能体",
      startedAt: new Date(1_000),
      status: "killed",
      taskId: TASK_ID,
    },
  });

  const result = await stop(runtime);

  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.alreadyTerminal, undefined);
  assert.equal(result.status, "killed");
  assert.deepEqual(calls, [TASK_ID]);
});

test("registry 没有该任务时回落到投影终态，不调用 subagent 停止", async () => {
  const { calls, runtime } = fakeRuntime({
    projection: staleProjection(),
    stopResult: {
      agentId: TASK_ID,
      agentType: "general-purpose",
      description: "恢复后的子智能体",
      startedAt: new Date(1_000),
      status: "killed",
      taskId: TASK_ID,
    },
  });

  const result = await stop(runtime);

  assert.equal(result.ok, true);
  assert.ok(result.ok);
  assert.equal(result.alreadyTerminal, true);
  assert.deepEqual(calls, []);
});
