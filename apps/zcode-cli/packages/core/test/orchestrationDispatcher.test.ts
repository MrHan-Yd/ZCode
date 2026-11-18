import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionId,
  createTraceId,
  type AgentBackgroundedOutput,
  type AgentCompletedOutput,
  type SubagentPort,
  type SubagentTaskSnapshot,
} from "@zcode/contracts";
import { NodeOrchestrationJournal } from "../../adapters/src/orchestration/journal.js";
import { NodeOrchestrationArtifactStorage } from "../../adapters/src/orchestration/artifacts.js";
import { OrchestrationRunStore } from "../src/orchestration/runStore.js";
import { OrchestrationArtifacts } from "../src/orchestration/artifacts.js";
import { OrchestrationDispatcher } from "../src/orchestration/dispatcher.js";
import { SubagentOrchestrationDispatchAdapter } from "../src/orchestration/subagent-dispatch-adapter.js";
import type { OrchestrationDispatchContext } from "../src/orchestration/dispatch-port.js";
import {
  orchestrationClock,
  orchestrationError,
  orchestrationInput,
  orchestrationOwner,
  orchestrationPlan,
  orchestrationStep,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

class ControlledSubagent {
  readonly starts: string[] = [];
  readonly stopped: string[] = [];
  readonly tasks = new Map<string, SubagentTaskSnapshot>();
  readonly waiters = new Map<string, ReturnType<typeof deferred<SubagentTaskSnapshot>>>();
  readonly requests: Parameters<NonNullable<SubagentPort["start"]>>[0][] = [];
  readonly changed = new Map<string, ReturnType<typeof deferred<void>>>();
  delayedStart?: ReturnType<typeof deferred<void>>;

  readonly port: SubagentPort = {
    launch: async () => {
      throw new Error("Unexpected launch path");
    },
    run: async () => {
      throw new Error("Unexpected run path");
    },
    start: async (request) => {
      const taskId = `child-${this.starts.length + 1}`;
      this.starts.push(request.agentType);
      this.requests.push(request);
      this.tasks.set(taskId, {
        taskId,
        agentId: taskId,
        agentType: request.agentType,
        description: request.description,
        status: "running",
        startedAt: new Date(),
        childSessionId: createSessionId(taskId),
      });
      this.waiters.set(taskId, deferred<SubagentTaskSnapshot>());
      this.changed.get(request.agentType)?.resolve();
      if (this.delayedStart) await this.delayedStart.promise;
      const output: AgentBackgroundedOutput = {
        status: "async_launched",
        isAsync: true,
        agentId: taskId,
        agentType: request.agentType,
        description: request.description,
        prompt: request.prompt,
        childSessionId: createSessionId(taskId),
        backgroundTaskId: taskId,
        outputFile: `output-${taskId}.txt`,
        canReadOutputFile: true,
      };
      return output;
    },
    getTask: async (taskId) => this.tasks.get(taskId),
    waitForTask: async (taskId) => this.waiters.get(taskId)?.promise,
    stopTask: async (taskId) => {
      this.stopped.push(taskId);
      const task = this.tasks.get(taskId);
      if (!task) return undefined;
      const stopped: SubagentTaskSnapshot = { ...task, status: "killed" };
      this.tasks.set(taskId, stopped);
      this.waiters.get(taskId)?.resolve(stopped);
      return stopped;
    },
  };

  waitForRole(role: string): Promise<void> {
    if (this.starts.includes(role)) return Promise.resolve();
    const pending = deferred<void>();
    this.changed.set(role, pending);
    return pending.promise;
  }

  finish(
    taskId: string,
    text = `Result ${taskId}`,
    status: "completed" | "failed" | "lost" = "completed",
  ): void {
    const task = this.tasks.get(taskId);
    assert.ok(task);
    const output: AgentCompletedOutput = {
      status: "completed",
      agentId: taskId,
      agentType: task.agentType,
      description: task.description,
      prompt: "fixture",
      content: [{ type: "text", text }],
      totalToolUseCount: 0,
      totalDurationMs: 1,
    };
    const terminal: SubagentTaskSnapshot = {
      ...task,
      status,
      ...(status === "completed" ? { output } : { error: `${status} child` }),
    };
    this.tasks.set(taskId, terminal);
    this.waiters.get(taskId)?.resolve(terminal);
  }
}

function setup(directory: string, child = new ControlledSubagent()) {
  const sessionId = createSessionId("orchestration-parent");
  const owner = orchestrationOwner(directory, { sessionId });
  const store = new OrchestrationRunStore({
    owner,
    journal: new NodeOrchestrationJournal({ rootDirectory: directory, owner }),
    now: orchestrationClock(),
  });
  const artifacts = new OrchestrationArtifacts({
    storage: new NodeOrchestrationArtifactStorage({ rootDirectory: directory, owner }),
  });
  const dispatcher = new OrchestrationDispatcher({
    store,
    artifacts,
    dispatch: new SubagentOrchestrationDispatchAdapter(child.port),
  });
  const context: OrchestrationDispatchContext = {
    sessionId,
    trace: { traceId: createTraceId() },
    workingDirectory: owner.workspacePath,
    workspaceRoot: owner.workspacePath,
  };
  return { store, artifacts, dispatcher, child, context };
}

test("真实 SubagentPort 形状：契约完成后前后端并行，tester 等待 join，输入只拿产物摘要", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store, dispatcher, child, context } = setup(directory);
    await store.create(
      orchestrationInput(
        orchestrationPlan([
          orchestrationStep({ stepId: "contract", role: "architect" }),
          orchestrationStep({
            stepId: "frontend",
            role: "frontend",
            dependsOn: ["contract"],
            writeScope: ["web"],
          }),
          orchestrationStep({
            stepId: "backend",
            role: "backend",
            dependsOn: ["contract"],
            writeScope: ["api"],
          }),
          orchestrationStep({
            stepId: "test",
            role: "tester",
            dependsOn: ["frontend", "backend"],
            writeScope: ["tests"],
          }),
        ]),
      ),
    );
    const executing = dispatcher.execute("fixture-run", context);
    await child.waitForRole("architect");
    assert.deepEqual(child.starts, ["architect"]);
    child.finish("child-1", "CONTRACT-START\n" + "x".repeat(20_000) + "\nCONTRACT-END");
    await Promise.all([child.waitForRole("frontend"), child.waitForRole("backend")]);
    assert.equal(child.starts.includes("tester"), false);
    assert.ok(child.requests[1]?.prompt.includes("CONTRACT-START"));
    assert.ok(!child.requests[1]?.prompt.includes("x".repeat(10_000)));
    child.finish("child-2");
    assert.equal(child.starts.includes("tester"), false);
    child.finish("child-3");
    await child.waitForRole("tester");
    child.finish("child-4");
    const result = await executing;
    assert.equal(result.status, "completed");
    assert.equal(result.attempts.length, 4);
    for (const attempt of result.attempts) assert.ok(attempt.artifact);
    assert.equal(child.requests[0]?.trace.traceId, context.trace.traceId);
  });
});

test("并发 execute 同一 run 共用执行 Promise，不重复派发", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store, dispatcher, child, context } = setup(directory);
    await store.create(orchestrationInput());
    const first = dispatcher.execute("fixture-run", context);
    const second = dispatcher.execute("fixture-run", context);
    await child.waitForRole("architect");
    child.finish("child-1");
    await Promise.all([first, second]);
    assert.deepEqual(child.starts, ["architect"]);
  });
});

test("child failed 按计划重试，新的 attempt key 不复用旧派发", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store, dispatcher, child, context } = setup(directory);
    await store.create(orchestrationInput());
    const executing = dispatcher.execute("fixture-run", context);
    await child.waitForRole("architect");
    const firstWait = child.waiters.get("child-1");
    assert.ok(firstWait);
    const next = deferred<void>();
    child.changed.set("architect", next);
    child.finish("child-1", "", "failed");
    await next.promise;
    child.finish("child-2");
    const result = await executing;
    assert.equal(result.status, "completed");
    assert.equal(result.attempts.length, 2);
    assert.notEqual(child.requests[0]?.parentToolCallId, child.requests[1]?.parentToolCallId);
  });
});

test("取消先 fencing，再显式停止 child；迟到完成不能启动依赖", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store, dispatcher, child, context } = setup(directory);
    await store.create(
      orchestrationInput(
        orchestrationPlan([
          orchestrationStep({ stepId: "contract", role: "architect" }),
          orchestrationStep({ stepId: "review", role: "reviewer", dependsOn: ["contract"] }),
        ]),
      ),
    );
    const executing = dispatcher.execute("fixture-run", context);
    await child.waitForRole("architect");
    const cancelled = await dispatcher.cancel("fixture-run");
    assert.equal(cancelled.status, "cancelled");
    child.finish("child-1", "late result");
    const result = await executing;
    assert.equal(result.state.steps.contract?.status, "cancelled");
    assert.deepEqual(child.starts, ["architect"]);
    assert.deepEqual(child.stopped, ["child-1"]);
  });
});

test("启动 ACK 迟到于取消时，也停止刚启动的 child", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const child = new ControlledSubagent();
    child.delayedStart = deferred<void>();
    const { store, dispatcher, context } = setup(directory, child);
    await store.create(orchestrationInput());
    const executing = dispatcher.execute("fixture-run", context);
    await child.waitForRole("architect");
    await dispatcher.cancel("fixture-run");
    child.delayedStart.resolve();
    const result = await executing;
    assert.equal(result.status, "cancelled");
    assert.deepEqual(child.stopped, ["child-1"]);
  });
});

test("lost child 暂停 run，不自动重放可能已写入的 attempt", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { store, dispatcher, child, context } = setup(directory);
    await store.create(orchestrationInput());
    const executing = dispatcher.execute("fixture-run", context);
    await child.waitForRole("architect");
    child.finish("child-1", "", "lost");
    const result = await executing;
    assert.equal(result.status, "interrupted");
    assert.equal(result.state.steps.first?.status, "interrupted");
    assert.deepEqual(child.starts, ["architect"]);
    assert.deepEqual(await store.claim("fixture-run"), []);
  });
});

test("缺少后台等待或取消能力时派发前拒绝，不调用 child", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const child = new ControlledSubagent();
    const { store, context } = setup(directory, child);
    const record = await store.create(orchestrationInput());
    const [claim] = await store.claim(record.runId);
    assert.ok(claim);
    const port: SubagentPort = { launch: child.port.launch, run: child.port.run };
    const adapter = new SubagentOrchestrationDispatchAdapter(port);
    await assert.rejects(
      adapter.start({
        record,
        claim,
        context,
        prompt: "fixture",
        signal: new AbortController().signal,
      }),
      orchestrationError("capability_unavailable"),
    );
    assert.deepEqual(child.starts, []);
  });
});
