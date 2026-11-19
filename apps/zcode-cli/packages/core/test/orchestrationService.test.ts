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
import {
  OrchestrationService,
  buildOrchestrationCompletionNotice,
} from "../src/orchestration/service.js";
import {
  orchestrationClock,
  orchestrationError,
  orchestrationOwner,
  orchestrationPlan,
  orchestrationStep,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

const TEAM = ["general-purpose", "Explore", "tester"] as const;

function phase3Plan(steps?: OrchestrationPlan["steps"]): OrchestrationPlan {
  return {
    planId: "phase3-plan",
    revision: 0,
    goal: "Verify orchestration",
    steps: steps ?? [
      orchestrationStep({ stepId: "design", role: "Explore" }),
      orchestrationStep({
        stepId: "build",
        role: "general-purpose",
        dependsOn: ["design"],
        writeScope: ["src"],
      }),
      orchestrationStep({
        stepId: "verify",
        role: "tester",
        dependsOn: ["build"],
        writeScope: ["tests"],
      }),
    ],
  };
}

class AutoSubagent {
  readonly started: string[] = [];
  readonly stopped: string[] = [];
  private sequence = 0;
  private readonly tasks = new Map<string, SubagentTaskSnapshot>();
  private readonly waiters = new Map<string, (snapshot: SubagentTaskSnapshot) => void>();

  constructor(private readonly autoComplete = true) {}

  readonly port: SubagentPort = {
    launch: async () => {
      throw new Error("Unexpected launch path");
    },
    run: async () => {
      throw new Error("Unexpected run path");
    },
    start: async (request) => {
      const taskId = `auto-task-${++this.sequence}`;
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
      if (this.autoComplete) this.finish(taskId);
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
}

function setup(directory: string, child: AutoSubagent, team?: readonly string[]) {
  const sessionId = createSessionId("phase3-parent");
  const owner = orchestrationOwner(directory, { sessionId: String(sessionId) });
  const notices: string[] = [];
  const service = new OrchestrationService({
    sessionId: String(sessionId),
    owner,
    journal: new NodeOrchestrationJournal({ rootDirectory: directory, owner }),
    artifactStorage: new NodeOrchestrationArtifactStorage({ rootDirectory: directory, owner }),
    subagents: child.port,
    ...(team ? { team } : {}),
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

test("Create：校验计划后异步启动 run，完成后通知主会话并保留产物引用", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const child = new AutoSubagent();
    const { service, context, notices } = setup(directory, child, TEAM);

    const created = await service.start({ plan: phase3Plan(), context });
    assert.equal(created.status, "pending");
    assert.equal(created.state.plan.planId, "phase3-plan");

    await waitFor(() => notices.length === 1, "completion notice");
    const final = await service.get(created.runId);
    assert.ok(final);
    assert.equal(final.status, "completed");
    assert.equal(final.state.steps.design?.status, "completed");
    assert.equal(final.state.steps.build?.status, "completed");
    assert.equal(final.state.steps.verify?.status, "completed");
    assert.equal(final.attempts.length, 3);
    assert.equal(child.started.length, 3);

    const notice = notices[0] ?? "";
    assert.match(notice, /finished with status: completed/);
    assert.match(notice, /artifact /);
    assert.match(notice, /build/);
  });
});

test("缺省精简团队由通用执行实现、审阅检查，未选测试角色在派发前被拒", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const child = new AutoSubagent();
    const { service, context, notices } = setup(directory, child);
    assert.deepEqual(service.currentTeam(), ["general-purpose", "Explore", "reviewer"]);
    await assert.rejects(service.start({ plan: phase3Plan(), context }), (error: unknown) => {
      assert.ok(orchestrationError("invalid_plan")(error));
      assert.ok(error instanceof Error);
      assert.match(error.message, /role tester, which is not in the current/u);
      return true;
    });
    assert.deepEqual(child.started, []);
    assert.deepEqual(service.listRuns(), []);

    const created = await service.start({
      plan: phase3Plan([
        orchestrationStep({ stepId: "build", role: "general-purpose", writeScope: ["src"] }),
        orchestrationStep({ stepId: "review", role: "reviewer", dependsOn: ["build"] }),
      ]),
      context,
    });
    await service.whenIdle();
    const final = await service.get(created.runId);
    assert.equal(final?.status, "completed");
    assert.deepEqual(final?.team, ["general-purpose", "Explore", "reviewer"]);
    assert.deepEqual(child.started, ["general-purpose", "reviewer"]);
    assert.equal(notices.length, 1);
  });
});

test("Create：非法计划在创建 run 之前被拒，并按业务失败暴露", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { service, context } = setup(directory, new AutoSubagent());
    await assert.rejects(
      service.start({
        plan: phase3Plan([
          orchestrationStep({ stepId: "a", role: "Explore", dependsOn: ["b"] }),
          orchestrationStep({ stepId: "b", role: "Explore", dependsOn: ["a"] }),
        ]),
        context,
      }),
      orchestrationError("invalid_plan"),
    );

    await assert.rejects(
      service.start({
        plan: phase3Plan([
          orchestrationStep({ stepId: "only", role: "frontend", writeScope: ["web"] }),
        ]),
        context,
      }),
      orchestrationError("invalid_plan"),
    );
  });
});

test("Cancel：显式取消停止在飞 child，并把 run 收口为 cancelled", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const child = new AutoSubagent(false);
    const { service, context, notices } = setup(directory, child);

    const created = await service.start({
      plan: orchestrationPlan([
        orchestrationStep({ stepId: "build", role: "general-purpose", writeScope: ["src"] }),
      ]),
      context,
    });
    await waitFor(() => child.started.length === 1, "child start");

    const cancelled = await service.cancel(created.runId);
    assert.equal(cancelled.status, "cancelled");
    assert.equal(child.stopped.length, 1);

    await waitFor(() => notices.length === 1, "cancel notice");
    assert.match(notices[0] ?? "", /finished with status: cancelled/);
    const final = await service.get(created.runId);
    assert.equal(final?.state.steps.build?.status, "cancelled");
  });
});

test("Amend：旧 run 被取消或保留终态，新 run 使用递增 revision 与新 runId", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const child = new AutoSubagent();
    const { service, context, notices } = setup(directory, child, TEAM);
    const plan = phase3Plan();

    const created = await service.start({ plan, context });
    await waitFor(() => notices.length === 1, "first completion");

    const amended = await service.amend({ runId: created.runId, plan: phase3Plan(), context });
    assert.notEqual(amended.runId, created.runId);
    assert.equal(amended.state.plan.revision, 1);
    assert.equal(amended.state.plan.planId, "phase3-plan");
    await waitFor(() => notices.length === 2, "amended completion");
  });
});

test("完成通知只暴露摘要与引用，不把完整 child 输出灌回主会话", () => {
  const long = "x".repeat(20_000);
  const notice = buildOrchestrationCompletionNotice({
    version: 1,
    runId: "run-1",
    owner: { workspacePath: "/ws", sessionId: "s" },
    team: [...TEAM],
    writableRoles: ["general-purpose", "tester"],
    maxConcurrency: 3,
    status: "completed",
    state: {
      plan: phase3Plan(),
      generation: 0,
      startedAt: 1,
      updatedAt: 2,
      cancelled: false,
      steps: {
        design: { stepId: "design", status: "completed", attempts: 1 },
        build: { stepId: "build", status: "completed", attempts: 1 },
        verify: { stepId: "verify", status: "completed", attempts: 1 },
      },
    },
    attempts: [
      {
        key: "attempt-1",
        revision: 0,
        generation: 0,
        stepId: "design",
        attempt: 0,
        status: "completed",
        startedAt: 1,
        artifact: {
          artifactId: "a1",
          attemptKey: "attempt-1",
          uri: "orchestration://a1",
          summary: long,
          originalBytes: 20_000,
          savedBytes: 20_000,
          sha256: "0".repeat(64),
          truncated: false,
          summaryTruncated: false,
        },
      },
    ],
    events: [],
  });
  assert.match(notice, /artifact orchestration:\/\/a1/);
  assert.equal(notice.includes(long), false);
});
