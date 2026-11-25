import assert from "node:assert/strict";
import test from "node:test";
import type { CommandAck, GoalState } from "@zcode/shared/zcode-protocol-v4";
import { buildConversationStatusPanelModel } from "../src/v4/conversationStatusPanelModel.js";
import {
  resolveAcceptedStatusPanelSend,
  resolveStatusPanelAutoOpenSections,
  StatusPanelSendAutoOpenGate,
  type StatusPanelAutoOpenScope,
} from "../src/v4/statusPanelSendAutoOpen.js";

const scope: StatusPanelAutoOpenScope = {
  workspaceKey: "/synthetic/status-panel",
  remoteSessionId: null,
  sessionId: "session-a",
};
const empty = resolveStatusPanelAutoOpenSections(buildConversationStatusPanelModel({}));
const unfinished = resolveStatusPanelAutoOpenSections(
  buildConversationStatusPanelModel({
    plan: { items: [{ id: "todo-a", content: "虚构待办", status: "pending" }], updatedAt: 1 },
  }),
);
const accepted = { sessionId: "session-a", commandId: "command-a" };
const ack: CommandAck = { status: "accepted", commandId: "command-a", revisionAtDecision: 1 };

function readyGate(initialScope = scope) {
  const gate = new StatusPanelSendAutoOpenGate(initialScope, true);
  const ticket = gate.beginSend(0);
  gate.acceptSend(ticket, { ...accepted, sessionId: initialScope.sessionId ?? "created-a" }, 0);
  return { gate, ticket };
}

test("未完成 Todo 才触发，不把可回看的历史内容当作活动", () => {
  assert.deepEqual(empty, {
    goal: false,
    plan: false,
    terminal: false,
    workflow: false,
    orchestration: false,
    agent: false,
  });
  assert.equal(unfinished.plan, true);
  for (const status of ["pending", "inProgress", "completed"] as const) {
    const model = buildConversationStatusPanelModel({
      plan: { items: [{ id: "todo", content: "虚构检查", status }], updatedAt: 1 },
    });
    assert.equal(model.hasStatusContent, true);
    assert.equal(resolveStatusPanelAutoOpenSections(model).plan, status !== "completed");
  }
});

test("智能体 running / waiting / blocked 都未结束，终端只收运行态", () => {
  for (const status of ["running", "waiting", "blocked"] as const) {
    const model = buildConversationStatusPanelModel({
      runningSubagents: [
        { childSessionId: "child-a", subagentType: "Explore", title: "虚构工作", status },
      ],
    });
    assert.equal(resolveStatusPanelAutoOpenSections(model).agent, true);
  }
  for (const status of ["running", "resultPending", "failed", "cancelled"] as const) {
    const model = buildConversationStatusPanelModel({
      backgroundWorks: [
        {
          workId: "bash-a",
          kind: "bash",
          title: "虚构终端",
          status,
          startedAt: 1,
          anchorRowId: null,
        },
      ],
    });
    assert.equal(resolveStatusPanelAutoOpenSections(model).terminal, status === "running");
  }
});

test("Goal 活动状态触发，暂停、失败和已验证本身不触发", () => {
  const goal: GoalState = {
    targetId: "goal-a",
    objective: "虚构目标",
    summaryTitle: null,
    timeUsedSeconds: 0,
    activeRunStartedAtMs: null,
    status: "active",
    iteration: 1,
    verifications: [],
    iterations: [],
  };
  for (const status of [
    "active",
    "verifying",
    "notSatisfied",
    "paused",
    "failed",
    "verified",
  ] as const) {
    const model = buildConversationStatusPanelModel({ goal: { ...goal, status } });
    assert.equal(
      resolveStatusPanelAutoOpenSections(model).goal,
      status === "active" || status === "verifying" || status === "notSatisfied",
    );
  }
});

test("一次 accepted 最多打开一次，延迟内容出现前不消耗", () => {
  const { gate } = readyGate();
  assert.equal(gate.takeAutoOpen("session-a", 0, empty), null);
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), "session-a");
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), null);
  assert.equal(gate.takeAutoOpen("session-a", 0, empty), null);
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), null);
});

test("相同 ticket 重复确认不重置已消费机会，新发送可以再打开", () => {
  const { gate, ticket } = readyGate();
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), "session-a");
  gate.acceptSend(ticket, accepted, 0);
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), null);
  const next = gate.beginSend(0);
  gate.acceptSend(next, { ...accepted, commandId: "command-b" }, 0);
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), "session-a");
});

test("显式面板操作早于 ACK 或晚于 ACK 都取消本次自动打开", () => {
  const gate = new StatusPanelSendAutoOpenGate(scope, true);
  const beforeAck = gate.beginSend(5);
  gate.acceptSend(beforeAck, accepted, 6);
  assert.equal(gate.takeAutoOpen("session-a", 6, unfinished), null);
  const afterAck = gate.beginSend(6);
  gate.acceptSend(afterAck, accepted, 6);
  assert.equal(gate.takeAutoOpen("session-a", 7, unfinished), null);
  gate.acceptSend(afterAck, accepted, 7);
  assert.equal(gate.takeAutoOpen("session-a", 7, unfinished), null);
});

test("必须匹配当前会话投影，不能拿旧 snapshot 内容打开新会话", () => {
  const { gate } = readyGate();
  assert.equal(gate.takeAutoOpen("session-b", 0, unfinished), null);
  assert.equal(gate.takeAutoOpen(null, 0, unfinished), null);
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), "session-a");
});

test("切走再返回使旧 ticket 永久失效，包括 ACK 尚未返回的情况", () => {
  const gate = new StatusPanelSendAutoOpenGate(scope, true);
  const ticket = gate.beginSend(0);
  gate.updateScope({ ...scope, sessionId: "session-b" }, true);
  gate.updateScope(scope, true);
  gate.acceptSend(ticket, accepted, 0);
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), null);
  const next = gate.beginSend(0);
  gate.acceptSend(next, accepted, 0);
  gate.updateScope({ ...scope, sessionId: "session-b" }, true);
  gate.updateScope(scope, true);
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), null);
});

test("同路径不同 identity、attachment 或不可见/focused 状态都废弃机会", () => {
  for (const next of [
    { ...scope, workspaceKey: "synthetic-remote-a" },
    { ...scope, remoteSessionId: "attachment-b" },
  ]) {
    const { gate } = readyGate();
    gate.updateScope(next, true);
    gate.updateScope(scope, true);
    assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), null);
  }
  const { gate } = readyGate();
  gate.updateScope(scope, false);
  gate.updateScope(scope, true);
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), null);
});

test("草稿首发只保留 accepted 目标的单向提升，绑定之后才自动打开", () => {
  const draft = { ...scope, sessionId: null };
  const { gate } = readyGate(draft);
  assert.equal(gate.takeAutoOpen("created-a", 0, unfinished), null);
  gate.updateScope({ ...scope, sessionId: "created-a" }, true);
  assert.equal(gate.takeAutoOpen("created-a", 0, unfinished), "created-a");
  const other = readyGate(draft).gate;
  other.updateScope({ ...scope, sessionId: "created-b" }, true);
  other.updateScope({ ...scope, sessionId: "created-a" }, true);
  assert.equal(other.takeAutoOpen("created-a", 0, unfinished), null);
});

test("草稿 Goal 先绑定空会话再接纳消息，空创建本身不能打开", () => {
  const gate = new StatusPanelSendAutoOpenGate({ ...scope, sessionId: null }, true);
  const ticket = gate.beginSend(0);
  gate.bindDraftTarget(ticket, "created-a");
  gate.updateScope({ ...scope, sessionId: "created-a" }, true);
  assert.equal(gate.takeAutoOpen("created-a", 0, unfinished), null);
  gate.acceptSend(ticket, { ...accepted, sessionId: "created-a" }, 0);
  assert.equal(gate.takeAutoOpen("created-a", 0, unfinished), "created-a");
});

test("草稿路由目标不能覆盖切换 scope 或误认另一会话的消息", () => {
  const gate = new StatusPanelSendAutoOpenGate({ ...scope, sessionId: null }, true);
  const ticket = gate.beginSend(0);
  gate.bindDraftTarget(ticket, "created-a");
  gate.updateScope({ ...scope, sessionId: "created-a" }, true);
  gate.acceptSend(ticket, { ...accepted, sessionId: "created-b" }, 0);
  assert.equal(gate.takeAutoOpen("created-a", 0, unfinished), null);
  gate.updateScope({ ...scope, sessionId: "created-b" }, true);
  gate.bindDraftTarget(ticket, "created-b");
  gate.acceptSend(ticket, { ...accepted, sessionId: "created-b" }, 0);
  assert.equal(gate.takeAutoOpen("created-b", 0, unfinished), null);
});

test("较新提交与卸载 reset 都使旧 ACK 无效", () => {
  const gate = new StatusPanelSendAutoOpenGate(scope, true);
  const old = gate.beginSend(0);
  const latest = gate.beginSend(0);
  gate.acceptSend(old, accepted, 0);
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), null);
  gate.acceptSend(latest, { ...accepted, commandId: "command-b" }, 0);
  gate.reset();
  gate.acceptSend(latest, accepted, 0);
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), null);
});

test("显式详情直达 reset 取消尚未消费的自动意图，旧 ACK 不能恢复", () => {
  const { gate, ticket } = readyGate();
  gate.reset();
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), null);
  gate.acceptSend(ticket, accepted, 0);
  assert.equal(gate.takeAutoOpen("session-a", 0, unfinished), null);
});

test("只认真实消息的 accepted，空会话、控制和非成功 ACK 不触发", () => {
  assert.deepEqual(
    resolveAcceptedStatusPanelSend("sendText", { text: "检查" }, "session-a", ack),
    accepted,
  );
  assert.deepEqual(
    resolveAcceptedStatusPanelSend("sendGoalCommand", { text: "目标" }, "session-a", ack),
    accepted,
  );
  const created = { ...ack, result: { type: "createSession" as const, sessionId: "created-a" } };
  assert.deepEqual(
    resolveAcceptedStatusPanelSend(
      "createSession",
      { firstInput: { text: "首发" } },
      null,
      created,
    ),
    { sessionId: "created-a", commandId: ack.commandId },
  );
  assert.equal(resolveAcceptedStatusPanelSend("createSession", {}, null, created), null);
  assert.equal(
    resolveAcceptedStatusPanelSend("createSession", { firstInput: {} }, null, ack),
    null,
  );
  for (const type of ["compact", "resumeGoal", "switchModelConfig", "setOrchestration"] as const) {
    assert.equal(resolveAcceptedStatusPanelSend(type, {}, "session-a", ack), null);
  }
  for (const status of ["rejected", "stale", "failed", "noop", "duplicate"] as const) {
    assert.equal(
      resolveAcceptedStatusPanelSend("sendText", {}, "session-a", { ...ack, status }),
      null,
    );
  }
  assert.equal(resolveAcceptedStatusPanelSend("sendText", {}, null, ack), null);
});
