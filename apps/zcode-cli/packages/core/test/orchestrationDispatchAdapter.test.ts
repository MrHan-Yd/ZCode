import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionId,
  createTraceId,
  type AgentBackgroundedOutput,
  type SubagentPort,
  type SubagentTaskSnapshot,
} from "@zcode/contracts";
import { NodeOrchestrationJournal } from "../../adapters/src/orchestration/journal.js";
import { OrchestrationRunStore } from "../src/orchestration/runStore.js";
import { SubagentOrchestrationDispatchAdapter } from "../src/orchestration/subagent-dispatch-adapter.js";
import {
  orchestrationInput,
  orchestrationOwner,
  orchestrationError,
  singleOrchestrationClaim,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

async function input(directory: string) {
  const sessionId = createSessionId("adapter-parent");
  const owner = orchestrationOwner(directory, { sessionId });
  const store = new OrchestrationRunStore({
    owner,
    journal: new NodeOrchestrationJournal({ rootDirectory: directory, owner }),
  });
  await store.create(orchestrationInput());
  const claim = singleOrchestrationClaim(await store.claim("fixture-run"));
  const record = await store.get("fixture-run");
  assert.ok(record);
  return {
    record,
    claim,
    prompt: "adapter test",
    context: {
      sessionId,
      trace: { traceId: createTraceId() },
      workingDirectory: owner.workspacePath,
      workspaceRoot: owner.workspacePath,
    },
    signal: new AbortController().signal,
  };
}

function childPort(snapshot: SubagentTaskSnapshot | undefined): SubagentPort {
  const background: AgentBackgroundedOutput = {
    status: "async_launched",
    isAsync: true,
    agentId: "child",
    agentType: "architect",
    description: "fixture",
    prompt: "fixture",
    childSessionId: createSessionId("child"),
    backgroundTaskId: "child",
    outputFile: "child-output.txt",
    canReadOutputFile: true,
  };
  return {
    launch: async () => background,
    run: async () => background,
    start: async () => background,
    getTask: async () => snapshot,
    waitForTask: async () => snapshot,
    stopTask: async () => snapshot,
  };
}

function snapshot(status: SubagentTaskSnapshot["status"]): SubagentTaskSnapshot {
  return {
    taskId: "child",
    agentId: "child",
    agentType: "architect",
    description: "fixture",
    status,
    startedAt: new Date(),
  };
}

test("只有状态及输出同时 completed 才接受，缺输出和 lost 均 interrupted", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const request = await input(directory);
    const backgroundOutput = await childPort(undefined).launch({
      sessionId: request.context.sessionId,
      parentToolCallId: "fixture",
      agentType: "architect",
      description: "fixture",
      prompt: "fixture",
      workingDirectory: request.context.workingDirectory,
      workspaceRoot: request.context.workspaceRoot,
      trace: request.context.trace,
    });
    for (const value of [
      undefined,
      snapshot("lost"),
      snapshot("completed"),
      { ...snapshot("completed"), output: backgroundOutput },
    ]) {
      const handle = await new SubagentOrchestrationDispatchAdapter(childPort(value)).start(
        request,
      );
      assert.equal((await handle.wait()).status, "interrupted");
    }
    const completed: SubagentTaskSnapshot = {
      ...snapshot("completed"),
      output: {
        status: "completed",
        agentId: "child",
        agentType: "architect",
        description: "fixture",
        prompt: "fixture",
        content: [{ type: "text", text: "confirmed" }],
        totalToolUseCount: 0,
        totalDurationMs: 1,
      },
    };
    const handle = await new SubagentOrchestrationDispatchAdapter(childPort(completed)).start(
      request,
    );
    assert.deepEqual(await handle.wait(), { status: "completed", content: "confirmed" });
    const wrongIdentity = { ...completed, agentId: "other" };
    assert.equal(
      (
        await (
          await new SubagentOrchestrationDispatchAdapter(childPort(wrongIdentity)).start(request)
        ).wait()
      ).status,
      "interrupted",
    );
  });
});

test("cancelled/killed/stopped 不能因存在完成正文而当作成功", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const request = await input(directory);
    for (const status of ["cancelled", "killed", "stopped"] as const) {
      const handle = await new SubagentOrchestrationDispatchAdapter(
        childPort(snapshot(status)),
      ).start(request);
      assert.equal((await handle.wait()).status, "cancelled");
    }
  });
});

test("同一 child 的重复停止 single-flight，停止失败保留错误且可再次尝试", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const request = await input(directory);
    const port = childPort(snapshot("running"));
    let calls = 0;
    let release!: () => void;
    const stopping = new Promise<void>((resolve) => {
      release = resolve;
    });
    port.stopTask = async () => {
      calls += 1;
      await stopping;
      return snapshot("killed");
    };
    const handle = await new SubagentOrchestrationDispatchAdapter(port).start(request);
    const first = handle.stop();
    const second = handle.stop();
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1);

    const failure = new Error("stop failed");
    const failedPort = childPort(snapshot("running"));
    let fail = true;
    failedPort.stopTask = async () => {
      if (fail) throw failure;
      return snapshot("killed");
    };
    const retry = await new SubagentOrchestrationDispatchAdapter(failedPort).start(request);
    await assert.rejects(retry.stop(), (error: unknown) => error === failure);
    fail = false;
    await retry.stop();
  });
});

test("团队外角色和错误父会话在调用 child 前拒绝", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const request = await input(directory);
    let calls = 0;
    const port = childPort(snapshot("running"));
    port.start = async () => {
      calls += 1;
      throw new Error("must not start");
    };
    const adapter = new SubagentOrchestrationDispatchAdapter(port);
    await assert.rejects(
      adapter.start({ ...request, record: { ...request.record, team: ["general-purpose"] } }),
      orchestrationError("invalid_plan"),
    );
    await assert.rejects(
      adapter.start({
        ...request,
        context: { ...request.context, sessionId: createSessionId("other") },
      }),
      orchestrationError("owner_mismatch"),
    );
    assert.equal(calls, 0);
  });
});
