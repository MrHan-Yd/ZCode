import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionId,
  createTraceId,
  type AgentBackgroundedOutput,
  type AgentCompletedOutput,
  type SessionId,
  type SubagentPort,
  type SubagentTaskSnapshot,
} from "@zcode/contracts";
import type { OrchestrationPlan } from "@zcode/shared";
import { NodeOrchestrationArtifactStorage } from "../../adapters/src/orchestration/artifacts.js";
import { NodeOrchestrationJournal } from "../../adapters/src/orchestration/journal.js";
import type { OrchestrationDispatchContext } from "../src/orchestration/dispatch-port.js";
import { OrchestrationService } from "../src/orchestration/service.js";
import {
  orchestrationClock,
  orchestrationOwner,
  orchestrationPlan,
  orchestrationStep,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

/** 只让第 N 个启动的 child 自动完成，其余保持 running 供取消测试使用。 */
class ControlledSubagent {
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  private sequence = 0;
  private readonly tasks = new Map<string, SubagentTaskSnapshot>();
  private readonly waiters = new Map<string, (snapshot: SubagentTaskSnapshot) => void>();

  constructor(private readonly autoCompleteUpTo = 0) {}

  readonly port: SubagentPort = {
    launch: async () => {
      throw new Error("Unexpected launch path");
    },
    run: async () => {
      throw new Error("Unexpected run path");
    },
    start: async (request) => {
      const taskId = `controlled-task-${++this.sequence}`;
      const childSessionId = createSessionId(taskId) as SessionId;
      this.started.push(request.agentType);
      this.tasks.set(taskId, {
        taskId,
        agentId: taskId,
        agentType: request.agentType,
        description: request.description,
        status: "running",
        startedAt: new Date(),
        childSessionId,
      });
      if (this.sequence <= this.autoCompleteUpTo) this.finish(taskId);
      const output: AgentBackgroundedOutput = {
        status: "async_launched",
        isAsync: true,
        agentId: taskId,
        agentType: request.agentType as AgentBackgroundedOutput["agentType"],
        description: request.description,
        prompt: request.prompt,
        childSessionId: String(childSessionId),
        backgroundTaskId: taskId,
        outputFile: `output-${taskId}.txt`,
        canReadOutputFile: true,
      };
      return output;
    },
    getTask: async (taskId) => this.tasks.get(taskId),
    waitForTask: async (taskId) => {
      const current = this.tasks.get(taskId);
      if (current && current.status !== "running") return current;
      return new Promise<SubagentTaskSnapshot>((resolve) => {
        this.waiters.set(taskId, resolve);
      });
    },
    stopTask: async (taskId) => {
      this.stopped.push(taskId);
      const task = this.tasks.get(taskId);
      if (!task) return undefined;
      const stopped: SubagentTaskSnapshot = { ...task, status: "killed" };
      this.tasks.set(taskId, stopped);
      this.waiters.get(taskId)?.(stopped);
      return stopped;
    },
  };

  finish(taskId: string, text = `Result ${taskId}`): void {
    const task = this.tasks.get(taskId);
    assert.ok(task);
    const output: AgentCompletedOutput = {
      status: "completed",
      agentId: task.agentId,
      agentType: task.agentType as AgentCompletedOutput["agentType"],
      description: task.description,
      prompt: "fixture",
      content: [{ type: "text", text }],
      totalToolUseCount: 0,
      totalDurationMs: 1,
    };
    const terminal: SubagentTaskSnapshot = { ...task, status: "completed", output };
    this.tasks.set(taskId, terminal);
    this.waiters.get(taskId)?.(terminal);
  }

  finishLatest(): void {
    const taskId = `controlled-task-${this.sequence}`;
    this.finish(taskId);
  }
}

function interruptPlan(): OrchestrationPlan {
  return orchestrationPlan([
    orchestrationStep({ stepId: "build", role: "general-purpose", writeScope: ["src"] }),
    orchestrationStep({ stepId: "verify", role: "tester", writeScope: ["tests"] }),
  ]);
}

function setup(directory: string, child: ControlledSubagent) {
  const sessionId = createSessionId("phase4-parent");
  const owner = orchestrationOwner(directory, { sessionId: String(sessionId) });
  const notices: string[] = [];
  const service = new OrchestrationService({
    sessionId: String(sessionId),
    owner,
    journal: new NodeOrchestrationJournal({ rootDirectory: directory, owner }),
    artifactStorage: new NodeOrchestrationArtifactStorage({ rootDirectory: directory, owner }),
    subagents: child.port,
    now: orchestrationClock(),
    notify: ({ text }) => notices.push(text),
  });
  const context: OrchestrationDispatchContext = {
    sessionId,
    trace: { traceId: createTraceId() } as OrchestrationDispatchContext["trace"],
    workingDirectory: owner.workspacePath,
    workspaceRoot: owner.workspacePath,
  };
  return { service, child, context, notices };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("停止并重排：取消在飞 run，保留已完成步骤产物，并递增 generation", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const child = new ControlledSubagent(1);
    const { service, context } = setup(directory, child);
    try {
      const created = await service.start({ plan: interruptPlan(), context });
      await waitFor(() => child.started.length === 2, "both children start");
      await waitFor(
        () =>
          service.activeRuns()[0]?.state.steps &&
          Object.values(service.activeRuns()[0]!.state.steps).filter(
            (step) => step.status === "completed",
          ).length === 1,
        "first step completes",
      );
      assert.equal(service.activeRunIds().length, 1);

      const before = service.activeRuns()[0];
      assert.ok(before);
      const completedStepId = Object.entries(before.state.steps).find(
        ([, step]) => step.status === "completed",
      )?.[0];
      assert.ok(completedStepId);
      const cancelledStepId = Object.keys(before.state.steps).find(
        (stepId) => stepId !== completedStepId,
      );
      assert.ok(cancelledStepId);

      const cancelled = await service.cancelActiveRuns();
      assert.equal(cancelled.length, 1);
      const record = cancelled[0];
      assert.ok(record);
      assert.equal(record.runId, created.runId);
      assert.equal(record.status, "cancelled");
      assert.equal(record.state.generation, 1, "取消必须递增 generation，旧结果才被 fencing 拒绝");
      assert.equal(record.state.steps[completedStepId]?.status, "completed");
      assert.equal(record.state.steps[cancelledStepId]?.status, "cancelled");
      const completedAttempt = record.attempts.find((attempt) => attempt.status === "completed");
      assert.ok(completedAttempt?.artifact, "已完成步骤的产物引用必须留在旧 journal");
      assert.equal(child.stopped.length, 1);

      await service.whenIdle();
      assert.equal(service.activeRunIds().length, 0);
      const state = service.promptState();
      assert.match(state ?? "", /Latest finished run:/);
      assert.match(state ?? "", /status cancelled/);
    } finally {
      await withTimeout(service.cancelActiveRuns(), 2_000).catch(() => undefined);
    }
  });
});

test("排队语义：whenIdle 只在 run 真正收口后返回", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const child = new ControlledSubagent(0);
    const { service, context, notices } = setup(directory, child);
    try {
      await service.start({ plan: interruptPlan(), context });
      await waitFor(() => child.started.length === 1, "first child starts");

      let idle = false;
      const waiting = service.whenIdle().then(() => {
        idle = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(idle, false, "在飞 child 未收口时不能提升排队输入");

      child.finishLatest();
      await waitFor(() => child.started.length === 2, "second child starts");
      child.finishLatest();
      await waiting;
      await waitFor(() => notices.length === 1, "completion notice");
      assert.equal(idle, true);
    } finally {
      await withTimeout(service.cancelActiveRuns(), 2_000).catch(() => undefined);
    }
  });
});

test("run 状态提示：活动中展示 Active runs，收口后展示 Latest finished run", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const child = new ControlledSubagent(0);
    const { service, context } = setup(directory, child);
    try {
      assert.equal(service.promptState(), undefined);
      const created = await service.start({ plan: interruptPlan(), context });
      await waitFor(() => child.started.length === 1, "child starts");

      const active = service.promptState() ?? "";
      assert.match(active, /Active runs:/);
      assert.match(active, new RegExp(created.runId));

      await service.cancelActiveRuns();
      await service.whenIdle();
      const finished = service.promptState() ?? "";
      assert.match(finished, /No orchestration run is currently active\./);
      assert.match(finished, /Latest finished run:/);
    } finally {
      await withTimeout(service.cancelActiveRuns(), 2_000).catch(() => undefined);
    }
  });
});

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
