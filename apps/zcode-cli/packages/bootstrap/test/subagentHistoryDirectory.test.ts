import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionId,
  SessionEventType,
  type MessageWithParts,
  type SessionEvent,
  type SessionInfo,
  type ToolPart,
} from "@zcode/contracts";
import { createSubagentObservation } from "../src/app/subagent-observation.js";
import { listSessionSubagents } from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import {
  collectSubagentChildSessionIds,
  projectSessionSubagents,
} from "../src/zcode-protocol/subagent-session-query.js";

const PARENT_ID = createSessionId("history-parent");
const OTHER_PARENT_ID = createSessionId("other-parent");
const parent = {
  id: PARENT_ID,
  projectID: "project-history",
  directory: "/fixture/workspace",
  path: "/fixture/workspace",
  taskType: "interactive",
  title: "History fixture",
  time: { created: 1, updated: 100 },
} as SessionInfo;

function childId(agentId: string) {
  return createSessionId(`subagent_${agentId}`);
}

function child(agentId: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    ...parent,
    id: childId(agentId),
    parentID: PARENT_ID,
    taskType: "subagent_child",
    title: agentId,
    time: { created: 5, updated: 20 },
    ...overrides,
  };
}

function notification(
  agentId: string,
  status: "completed" | "failed" | "stopped" | "lost" = "completed",
  at = 20,
): MessageWithParts {
  const title = `Task ${agentId}`;
  const text = [
    "<task-notification>",
    `<task-id>${agentId}</task-id>`,
    `<tool-use-id>attempt-${agentId}</tool-use-id>`,
    `<status>${status}</status>`,
    `<summary>Agent Explore task &quot;${title}&quot; ${status}.</summary>`,
    status === "completed"
      ? `<result>Result ${agentId}</result>`
      : `<error>Error ${agentId}</error>`,
    "</task-notification>",
  ].join("\n");
  return {
    info: {
      id: `msg-${agentId}`,
      sessionID: PARENT_ID,
      role: "user",
      source: "background_task",
      synthetic: true,
      time: { created: at },
      anchor: { origin: "backgroundResult", turnId: `turn-${agentId}` },
      semantics: {
        origin: "agent_runtime",
        kind: "background_notification",
        source: "background_task",
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
      metadata: { originMeta: { backgroundSource: "subagent", workId: agentId, title } },
    },
    parts: [{ type: "text", text }],
  } as unknown as MessageWithParts;
}

function assistant(agentId: string): MessageWithParts {
  return {
    info: {
      id: `assistant-${agentId}`,
      sessionID: childId(agentId),
      role: "assistant",
      time: { created: 10, completed: 20 },
      finish: "stop",
    },
    parts: [{ type: "text", text: `Transcript ${agentId}` }],
  } as unknown as MessageWithParts;
}

function lifecycle(agentId: string, stopped = true): SessionEvent[] {
  const payload = {
    agentId,
    childSessionId: childId(agentId),
    parentToolCallId: `attempt-${agentId}`,
    agentType: "Explore",
    description: `Task ${agentId}`,
  };
  return [
    {
      type: SessionEventType.SubagentSpawned,
      sessionId: PARENT_ID,
      turnId: `turn-${agentId}`,
      timestamp: new Date(5),
      payload,
    },
    ...(stopped
      ? [
          {
            type: SessionEventType.SubagentStopped,
            sessionId: PARENT_ID,
            turnId: `turn-${agentId}`,
            timestamp: new Date(20),
            payload: { ...payload, status: "success", summaryText: `Result ${agentId}` },
          },
        ]
      : []),
  ] as unknown as SessionEvent[];
}

function contextFor(
  messages: MessageWithParts[],
  children: SessionInfo[],
  events: SessionEvent[] = [],
) {
  const sessions = new Map([
    [parent.id, parent],
    ...children.map((item) => [item.id, item] as const),
  ]);
  const counters = { fullChildReads: 0, lastChildReads: 0 };
  const store = {
    getSession: async (id: string) => sessions.get(id as typeof PARENT_ID) ?? null,
    messages: async ({ sessionID }: { sessionID: string }) => {
      if (sessionID === PARENT_ID) return messages;
      counters.fullChildReads += 1;
      return [];
    },
    lastAssistantMessage: async ({ sessionID }: { sessionID: string }) => {
      counters.lastChildReads += 1;
      const agentId = children.find((item) => item.id === sessionID)?.title ?? "agent_unknown";
      return assistant(agentId);
    },
  };
  const eventStore = {
    getEvents: async () => events,
    getLatestSequenceNumber: async () => 10,
  };
  const runtime = {
    getSessionEventStore: () => eventStore,
    getProjection: async () => ({ status: "completed", backgroundTasks: [], activeToolCalls: [] }),
  };
  const context = {
    deps: { sessionStore: store },
    sessions: events.length
      ? new Map([[PARENT_ID, { stateRevision: 10, eventStore, app: { runtime } }]])
      : new Map(),
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, counters, runtime, store };
}

test("编排直接派发没有 Agent 工具 part 时，生命周期事件仍形成可查看历史", () => {
  const agentId = "agent_event";
  const events = lifecycle(agentId);
  assert.deepEqual(collectSubagentChildSessionIds(parent, [], events), [childId(agentId)]);
  const result = projectSessionSubagents({
    revision: 10,
    parentSession: parent,
    messages: [],
    parentEvents: events,
    childSessionsById: new Map([[childId(agentId), child(agentId)]]),
    childMessagesById: new Map([[childId(agentId), [assistant(agentId)]]]),
    childProjectionsById: new Map(),
  });
  assert.equal(result.running.length, 0);
  assert.equal(result.ended.length, 1);
  assert.equal(result.ended[0]?.childSessionId, childId(agentId));
  assert.equal(result.ended[0]?.title, `Task ${agentId}`);
  assert.equal(result.ended[0]?.subagentType, "Explore");
  assert.equal(result.ended[0]?.status, "success");
});

test("进程重启后仅凭三条持久化编排结果通知恢复目录与真实终态", async () => {
  const agents = ["agent_success", "agent_failed", "agent_stopped"];
  const messages = agents.map((id, index) =>
    notification(
      id,
      ["completed", "failed", "stopped"][index] as "completed" | "failed" | "stopped",
      20 + index,
    ),
  );
  const { context, counters } = contextFor(
    messages,
    agents.map((id) => child(id)),
  );
  const result = await listSessionSubagents(context, { sessionId: PARENT_ID, endedLimit: 10 });
  assert.deepEqual(new Set(result.childSessionIds), new Set(agents.map(childId)));
  assert.equal(result.running.length, 0);
  assert.equal(result.ended.total, 3);
  assert.deepEqual(
    result.ended.items.map((item) => item.status),
    ["cancelled", "failed", "success"],
  );
  assert.equal(
    result.ended.items.find((item) => item.status === "success")?.summary,
    "Result agent_success",
  );
  assert.equal(
    result.ended.items.find((item) => item.status === "failed")?.summary,
    "Error agent_failed",
  );
  assert.equal(counters.lastChildReads, 3);
  assert.equal(counters.fullChildReads, 0);
});

test("工具 ACK、事件和完成通知合并为一个 child，通知终态不被 ACK 覆盖", async () => {
  const agentId = "agent_ack";
  const part = {
    type: "tool",
    callID: `attempt-${agentId}`,
    tool: "Agent",
    state: {
      status: "completed",
      input: { description: "Original task", run_in_background: true },
      output: `agentId: ${agentId}`,
      metadata: {},
      time: { start: 5, end: 6 },
    },
  } as unknown as ToolPart;
  const messages = [
    {
      info: { id: "msg-ack", sessionID: PARENT_ID, role: "assistant", time: { created: 5 } },
      parts: [part],
    } as unknown as MessageWithParts,
    notification(agentId, "failed"),
  ];
  const { context } = contextFor(messages, [child(agentId)]);
  const result = await listSessionSubagents(context, { sessionId: PARENT_ID });
  assert.deepEqual(result.childSessionIds, [childId(agentId)]);
  assert.equal(result.ended.total, 1);
  assert.equal(result.ended.items[0]?.status, "failed");
  assert.equal(result.ended.items[0]?.summary, `Error ${agentId}`);
  assert.equal(result.ended.items[0]?.title, "Original task");
});

for (const error of ["cancelled", "Artifact write failed"]) {
  test(`经典 Agent 结果写入较子会话更晚失败时，冷恢复保留 ${error} 终态`, async () => {
    const agentId = "agent_error_after_child";
    const part = {
      type: "tool",
      callID: "call-error",
      tool: "Agent",
      state: {
        status: "error",
        input: { description: "Classic task" },
        error,
        metadata: { agentId },
        time: { start: 5, end: 50 },
      },
    } as unknown as ToolPart;
    const messages = [
      {
        info: { id: "msg-error", sessionID: PARENT_ID, role: "assistant", time: { created: 5 } },
        parts: [part],
      } as unknown as MessageWithParts,
    ];
    const { context } = contextFor(messages, [child(agentId)]);
    const result = await listSessionSubagents(context, { sessionId: PARENT_ID });
    assert.equal(result.ended.items[0]?.status, error === "cancelled" ? "cancelled" : "failed");
    assert.equal(result.ended.items[0]?.summary, error);
    assert.equal(result.ended.items[0]?.endedAt, 50);
  });
}

test("批量失败通知的带引号错误原因不得混入任务标题", async () => {
  const first = notification("agent_first");
  const failed = notification("agent_quoted", "failed");
  failed.parts = failed.parts.map((part) =>
    part.type === "text"
      ? {
          ...part,
          text: part.text.replace(
            "failed.</summary>",
            "failed. Command &quot;pnpm lint&quot; failed.</summary>",
          ),
        }
      : part,
  );
  const message = { ...first, parts: [...first.parts, ...failed.parts] };
  const { context } = contextFor([message], [child("agent_first"), child("agent_quoted")]);
  const result = await listSessionSubagents(context, { sessionId: PARENT_ID });
  assert.equal(
    result.ended.items.find((item) => item.childSessionId === childId("agent_quoted"))?.title,
    "Task agent_quoted",
  );
});

test("同一持久消息内的批量通知恢复全部子代理，不只恢复代表条目", async () => {
  const agents = ["agent_batch_a", "agent_batch_b", "agent_batch_c"];
  const notices = agents.map((id) => notification(id));
  const message = {
    ...notices[0]!,
    info: {
      ...notices[0]!.info,
      metadata: {
        originMeta: {
          backgroundSource: "subagent",
          workId: agents[0],
          title: agents.map((id) => `Task ${id}`).join(" · "),
        },
      },
    },
    parts: notices.flatMap((item) => item.parts),
  };
  const { context } = contextFor(
    [message],
    agents.map((id) => child(id)),
  );
  const result = await listSessionSubagents(context, { sessionId: PARENT_ID });
  assert.equal(result.ended.total, 3);
  assert.deepEqual(new Set(result.childSessionIds), new Set(agents.map(childId)));
  assert.ok(result.ended.items.every((item) => item.subagentType === "Explore"));
  assert.deepEqual(
    new Set(result.ended.items.map((item) => item.title)),
    new Set(agents.map((id) => `Task ${id}`)),
  );
});

test("混合后台批量首项是 Bash 时，后续编排子代理仍可冷恢复", async () => {
  const notice = notification("agent_mixed");
  const bashText =
    "<task-notification><task-id>bash-mixed</task-id><tool-use-id>bash-call</tool-use-id><status>completed</status><summary>Bash completed.</summary></task-notification>";
  const message = {
    ...notice,
    info: {
      ...notice.info,
      metadata: {
        originMeta: {
          backgroundSource: "bash",
          workId: "bash-mixed",
          title: "Bash · Task agent_mixed",
        },
      },
    },
    parts: [{ type: "text", text: bashText }, ...notice.parts],
  } as MessageWithParts;
  const { context } = contextFor([message], [child("agent_mixed")]);
  const result = await listSessionSubagents(context, { sessionId: PARENT_ID });
  assert.deepEqual(result.childSessionIds, [childId("agent_mixed")]);
  assert.equal(result.ended.items[0]?.title, "Task agent_mixed");
});

test("大结果通知尾部截断时，头部的历史身份和终态仍可恢复", async () => {
  const notice = notification("agent_truncated");
  notice.parts = notice.parts.map((part) =>
    part.type === "text"
      ? { ...part, text: part.text.replace("</task-notification>", "\n[truncated]") }
      : part,
  );
  const { context } = contextFor([notice], [child("agent_truncated")]);
  const result = await listSessionSubagents(context, { sessionId: PARENT_ID });
  assert.deepEqual(result.childSessionIds, [childId("agent_truncated")]);
  assert.equal(result.ended.items[0]?.status, "success");
});

test("用户伪造通知、错误通知身份及非子代理来源不得进入目录", async () => {
  const real = notification("agent_valid");
  const fake = notification("agent_fake");
  fake.info = {
    ...fake.info,
    synthetic: false,
    source: undefined,
    semantics: undefined,
    anchor: undefined,
  } as typeof fake.info;
  const mismatched = notification("agent_mismatch");
  mismatched.info.metadata = {
    originMeta: { backgroundSource: "subagent", workId: "agent_other", title: "Mismatch" },
  };
  const bash = notification("agent_bash");
  bash.info.metadata = {
    originMeta: { backgroundSource: "bash", workId: "agent_bash", title: "Bash" },
  };
  const agents = ["agent_valid", "agent_fake", "agent_mismatch", "agent_bash"];
  const { context } = contextFor(
    [real, fake, mismatched, bash],
    agents.map((id) => child(id)),
  );
  const result = await listSessionSubagents(context, { sessionId: PARENT_ID });
  assert.deepEqual(result.childSessionIds, [childId("agent_valid")]);
});

test("历史引用必须对应真实子会话，且父会话与 workspace identity 一致", async () => {
  const agents = [
    "agent_valid",
    "agent_missing",
    "agent_other_parent",
    "agent_other_workspace",
    "agent_workflow",
  ];
  const children = [
    child("agent_valid"),
    child("agent_other_parent", { parentID: OTHER_PARENT_ID }),
    child("agent_other_workspace", { workspaceID: "remote-other" as SessionInfo["workspaceID"] }),
    child("agent_workflow", { taskType: "workflow_child" }),
  ];
  const { context } = contextFor(
    agents.map((id) => notification(id)),
    children,
  );
  const result = await listSessionSubagents(context, { sessionId: PARENT_ID });
  assert.deepEqual(result.childSessionIds, [childId("agent_valid")]);
  assert.equal(result.ended.total, 1);
});

test("活动分支裁掉旧通知后，旧编排事件不能复活已作废的 child", () => {
  const old = notification("agent_old");
  const current = notification("agent_current");
  const session = {
    ...parent,
    revert: {
      messageID: old.info.id,
      targetMessageID: old.info.id,
      keptMessageIDs: [],
      branchCutAfterMessageID: old.info.id,
    },
  };
  const ids = collectSubagentChildSessionIds(
    session,
    [old, current],
    [...lifecycle("agent_old"), ...lifecycle("agent_current")],
  );
  assert.deepEqual(ids, [childId("agent_current")]);
});

test("running 与 ended 共用清单，未收口的编排事件仍保留运行状态", async () => {
  const events = [...lifecycle("agent_live", false), ...lifecycle("agent_done")];
  const { context } = contextFor(
    [notification("agent_done")],
    [child("agent_live"), child("agent_done")],
    events,
  );
  context.deps.sessionStore!.lastAssistantMessage = async ({ sessionID }) =>
    sessionID === childId("agent_live") ? null : assistant("agent_done");
  const result = await listSessionSubagents(context, { sessionId: PARENT_ID });
  assert.equal(result.childSessionIds.length, 2);
  assert.equal(result.running.length, 1);
  assert.equal(result.running[0]?.childSessionId, childId("agent_live"));
  assert.equal(result.ended.total, 1);
});

test("有身份父会话兼容旧 child 缺身份，显式错误身份仍拒绝", async () => {
  const messages = [notification("agent_legacy"), notification("agent_wrong")];
  const { context } = contextFor(messages, [
    child("agent_legacy"),
    child("agent_wrong", { workspaceID: "workspace-other" as SessionInfo["workspaceID"] }),
  ]);
  const getSession = context.deps.sessionStore!.getSession.bind(context.deps.sessionStore);
  context.deps.sessionStore!.getSession = async (id) => {
    const session = await getSession(id);
    return id === PARENT_ID && session
      ? { ...session, workspaceID: "workspace-parent" as SessionInfo["workspaceID"] }
      : session;
  };
  const result = await listSessionSubagents(context, { sessionId: PARENT_ID });
  assert.deepEqual(result.childSessionIds, [childId("agent_legacy")]);
});

for (const hot of [true, false]) {
  test(`同 child 续跑无新通知时，${hot ? "热查询" : "冷恢复"}采用最新完成事实而非旧失败`, async () => {
    const agentId = "agent_resumed";
    const old = notification(agentId, "failed", 21);
    const events = lifecycle(agentId).map((event) => ({
      ...event,
      timestamp: new Date(event.type === SessionEventType.SubagentSpawned ? 25 : 40),
      payload: {
        agentId,
        childSessionId: childId(agentId),
        parentToolCallId: "attempt-resumed",
        agentType: "Explore",
        description: "Latest task",
        ...(event.type === SessionEventType.SubagentStopped ? { status: "success" } : {}),
      },
    }));
    const { context } = contextFor([old], [child(agentId)], hot ? events : []);
    const latest = assistant(agentId);
    latest.info.time = { created: 30, completed: 40 };
    latest.parts = [{ type: "text", text: "Latest result" }] as MessageWithParts["parts"];
    context.deps.sessionStore!.lastAssistantMessage = async () => latest;
    const result = await listSessionSubagents(context, { sessionId: PARENT_ID });
    assert.equal(result.ended.total, 1);
    assert.equal(result.ended.items[0]?.status, "success");
    assert.equal(result.ended.items[0]?.summary, "Latest result");
    assert.equal(result.ended.items[0]?.endedAt, 40);
  });
}

test("TUI 与协议查询复用编排历史候选，不另建一套关联规则", async () => {
  const agentId = "agent_tui";
  const messages = [notification(agentId)];
  const { store, runtime } = contextFor(messages, [child(agentId)]);
  const observation = createSubagentObservation({
    sessionId: PARENT_ID,
    sessionStore: store,
    runtime,
  } as unknown as Parameters<typeof createSubagentObservation>[0]);
  const result = await observation.readSubagents();
  assert.deepEqual(result.childSessionIds, [childId(agentId)]);
  assert.equal(result.ended.total, 1);
});
