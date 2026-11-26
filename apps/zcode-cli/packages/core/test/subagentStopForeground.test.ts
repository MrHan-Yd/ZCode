import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createSessionId,
  createTraceId,
  SessionEventType,
  type SessionEvent,
  type SubagentStartRequest,
  type SubagentRunRequest,
} from "@zcode/contracts";
import {
  createExploreSubagentPort,
  type ExploreSubagentRuntimeRequest,
} from "../src/subagent/runner.js";

/**
 * 子智能体停止的运行时语义（specs/status-panel-subagent-stop.md）。
 *
 * 前台 child 由父轮 Agent 工具调用等待结果：停止只能中断它，不能走后台 stopped 收口，
 * 否则同一个 child 会同时得到 stopped 与 failed 两份终态、一份后台产物和一条后台完成通知。
 * 后台 child 必须保持原有的 finalizeBackgroundStopped 收口。
 */

const SESSION_ID = createSessionId("stop-parent");

const PROFILES = [
  {
    name: "general-purpose",
    description: "fixture",
    systemPrompt: "fixture",
    source: "built-in" as const,
  },
];

function runRequest(root: string): SubagentRunRequest {
  return {
    sessionId: SESSION_ID,
    parentToolCallId: "tool-1",
    agentType: "general-purpose",
    description: "等待停止",
    prompt: "wait for stop",
    workingDirectory: root,
    workspaceRoot: root,
    trace: { traceId: createTraceId() },
  };
}

function hangingRunner(handle: {
  onAgentId: (agentId: string, signal: AbortSignal | undefined) => void;
  ready: Promise<void>;
  resolveReady: () => void;
}) {
  return async (request: ExploreSubagentRuntimeRequest, options?: { signal?: AbortSignal }) => {
    handle.onAgentId(request.agentId, options?.signal);
    await request.onSessionReady?.();
    handle.resolveReady();
    await new Promise<void>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(options?.signal?.reason), {
        once: true,
      });
    });
    throw new Error("unreachable");
  };
}

function eventsOfType(events: readonly SessionEvent[], type: SessionEventType): SessionEvent[] {
  return events.filter((event) => event.type === type);
}

test("前台子智能体停止只中断 child：不发后台完成事件、不投递后台通知", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-stop-"));
  try {
    const events: SessionEvent[] = [];
    const notifications: string[] = [];
    let agentId = "";
    let childSignal: AbortSignal | undefined;
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const port = createExploreSubagentPort({
      runExploreAgent: hangingRunner({
        onAgentId: (id, signal) => {
          agentId = id;
          childSignal = signal;
        },
        ready,
        resolveReady,
      }),
      emitParentEvent: async (event) => {
        events.push(event);
      },
      enqueueParentTaskNotification: (notification) => {
        notifications.push(notification.taskId);
        return undefined;
      },
      outputRootDir,
      profiles: PROFILES,
    });

    const runPromise = port.run(runRequest(outputRootDir));
    runPromise.catch(() => {});
    await ready;

    const running = await port.getTask!(agentId);
    assert.equal(running?.status, "running");

    const stopped = await port.stopTask!(agentId);
    assert.equal(stopped?.status, "failed", "前台终态由前台执行路径写入");
    assert.equal(childSignal?.aborted, true, "停止必须打断 child 自己的 signal");
    await assert.rejects(runPromise);

    assert.deepEqual(notifications, [], "前台 child 没有后台完成通知");
    assert.equal(eventsOfType(events, SessionEventType.BackgroundTaskCompleted).length, 0);
    const stoppedEvents = eventsOfType(events, SessionEventType.SubagentStopped);
    assert.equal(stoppedEvents.length, 1, "不得出现第二份 SubagentStopped");
    assert.equal((stoppedEvents[0]?.payload as { status?: string }).status, "failed");

    // 幂等：已终结后再停一次不产生新事件与通知。
    const again = await port.stopTask!(agentId);
    assert.equal(again?.status, "failed");
    assert.deepEqual(notifications, []);
    assert.equal(eventsOfType(events, SessionEventType.SubagentStopped).length, 1);
  } finally {
    await rm(outputRootDir, { recursive: true, force: true });
  }
});

test("后台子智能体仍走原有收口：stopped 产物 + 完成事件 + 父通知", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-stop-bg-"));
  try {
    const events: SessionEvent[] = [];
    const notifications: string[] = [];
    let agentId = "";
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });

    const port = createExploreSubagentPort({
      runExploreAgent: hangingRunner({
        onAgentId: (id) => {
          agentId = id;
        },
        ready,
        resolveReady,
      }),
      emitParentEvent: async (event) => {
        events.push(event);
      },
      enqueueParentTaskNotification: (notification) => {
        notifications.push(notification.taskId);
        return undefined;
      },
      outputRootDir,
      profiles: PROFILES,
    });

    const request: SubagentStartRequest = runRequest(outputRootDir);
    await port.start!(request, {});
    await ready;

    const running = await port.getTask!(agentId);
    assert.equal(running?.status, "running");

    const stopped = await port.stopTask!(agentId);
    assert.equal(stopped?.status, "killed");
    assert.deepEqual(notifications, [agentId], "后台 child 的完成通知必须保留");
    assert.equal(eventsOfType(events, SessionEventType.BackgroundTaskCompleted).length, 1);
    const stoppedEvents = eventsOfType(events, SessionEventType.SubagentStopped);
    assert.equal(stoppedEvents.length, 1);
    assert.equal((stoppedEvents[0]?.payload as { status?: string }).status, "stopped");
  } finally {
    await rm(outputRootDir, { recursive: true, force: true });
  }
});
