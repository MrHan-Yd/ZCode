import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  type MessageWithParts,
  type SessionEvent,
  type TurnStartedPayload,
} from "@zcode/contracts";
import type { UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { ConversationTopicPublisher } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";
import { synthesizeEventsFromMessages } from "../src/zcode-protocol-v4/transcript-hydration.js";

/**
 * 编排指令气泡标记（specs/orchestrator-mode.md 5.8）。
 *
 * 事实只来自 TurnStarted：本轮开跑时 runtime 编排配置为 enabled。
 * 活投影与冷恢复必须把同一个字段落到 userInput row，否则重启后气泡边框会消失；
 * 只有真实用户轮打标记，系统通知/工作流启动卡等 synthetic 行不标记。
 */

const SESSION_ID = "session-orchestration-marker";
const LOG_EPOCH = "epoch-orchestration-marker";
const RUNTIME_TURN_ID = "turn-runtime-1";
const USER_MESSAGE_ID = "msg-user-1";
const BASE_TIME = 1_767_225_600_000;

let eventSerial = 0;

function turnStarted(payload: Partial<TurnStartedPayload> = {}): SessionEvent {
  eventSerial += 1;
  return {
    id: `evt-started-${eventSerial}`,
    sessionId: SESSION_ID,
    type: SessionEventType.TurnStarted,
    timestamp: new Date(BASE_TIME),
    sequenceNumber: eventSerial,
    turnId: RUNTIME_TURN_ID,
    payload: {
      turnNumber: 1,
      input: "测试和审阅下未提交的代码有没有啥问题",
      messageId: USER_MESSAGE_ID,
      ...payload,
    },
  } as unknown as SessionEvent;
}

function turnComplete(): SessionEvent {
  eventSerial += 1;
  return {
    id: `evt-complete-${eventSerial}`,
    sessionId: SESSION_ID,
    type: SessionEventType.TurnComplete,
    timestamp: new Date(BASE_TIME + 1_000),
    sequenceNumber: eventSerial,
    turnId: RUNTIME_TURN_ID,
    payload: { resultType: "success", duration: 1_000 },
  } as unknown as SessionEvent;
}

function steerDrained(): SessionEvent {
  const messageId = "msg-steer-1";
  eventSerial += 1;
  return {
    id: `evt-steer-drained-${eventSerial}`,
    sessionId: SESSION_ID,
    type: SessionEventType.TurnSteerDrained,
    timestamp: new Date(BASE_TIME + 2_000),
    sequenceNumber: eventSerial,
    turnId: RUNTIME_TURN_ID,
    payload: {
      pendingInputIds: ["pending-1"],
      targetTurnId: RUNTIME_TURN_ID,
      injectedMessageIds: [messageId],
      drainedInputs: [
        {
          pendingInputId: "pending-1",
          messageId,
          text: "继续排队修改",
          delivery: "queue",
        },
      ],
    },
  } as unknown as SessionEvent;
}

function findUserInputRow(publisher: ConversationTopicPublisher): UserInputRow | undefined {
  return publisher
    .getSnapshot()
    .rows.window.find((row): row is UserInputRow => row.kind === "userInput");
}

function findUserInputRowByText(
  publisher: ConversationTopicPublisher,
  text: string,
): UserInputRow | undefined {
  return publisher
    .getSnapshot()
    .rows.window.find((row): row is UserInputRow => row.kind === "userInput" && row.text === text);
}

function projectSingleTurn(payload: Partial<TurnStartedPayload> = {}): UserInputRow {
  eventSerial = 0;
  const publisher = new ConversationTopicPublisher(SESSION_ID, LOG_EPOCH);
  publisher.ingest(turnStarted(payload));
  publisher.ingest(turnComplete());
  const row = findUserInputRow(publisher);
  assert.ok(row, "TurnStarted + TurnComplete 必须产出一条 userInput row");
  return row;
}

test("实时投影：编排轮的真实用户消息带 orchestrationEnabled", () => {
  const row = projectSingleTurn({ orchestrationEnabled: true });
  assert.equal(row.origin, "realUser");
  assert.equal(row.orchestrationEnabled, true);
});

test("经典轮不产生 orchestrationEnabled 字段", () => {
  const row = projectSingleTurn();
  assert.equal(Object.hasOwn(row, "orchestrationEnabled"), false);
});

test("synthetic 来源（编辑重跑/系统注入）不标记为编排指令", () => {
  const row = projectSingleTurn({ orchestrationEnabled: true, inputSource: "rewind" });
  assert.notEqual(row.origin, "realUser");
  assert.equal(Object.hasOwn(row, "orchestrationEnabled"), false);
});

test("运行中排队的后续指令沿用所属 runtime turn 的编排标记", () => {
  eventSerial = 0;
  const publisher = new ConversationTopicPublisher(SESSION_ID, LOG_EPOCH);
  publisher.ingest(turnStarted({ orchestrationEnabled: true }));
  publisher.ingest(steerDrained());
  const row = findUserInputRowByText(publisher, "继续排队修改");
  assert.ok(row, "TurnSteerDrained 必须产出排队输入 row");
  assert.equal(row.orchestrationEnabled, true);
});

test("经典轮运行中排队的后续指令不标记", () => {
  eventSerial = 0;
  const publisher = new ConversationTopicPublisher(SESSION_ID, LOG_EPOCH);
  publisher.ingest(turnStarted());
  publisher.ingest(steerDrained());
  const row = findUserInputRowByText(publisher, "继续排队修改");
  assert.ok(row, "TurnSteerDrained 必须产出排队输入 row");
  assert.equal(Object.hasOwn(row, "orchestrationEnabled"), false);
});

test("冷恢复：message metadata 回填同一个 TurnStarted 字段", () => {
  const message = {
    info: {
      id: USER_MESSAGE_ID,
      sessionID: SESSION_ID,
      role: "user",
      time: { created: BASE_TIME },
      agent: "zcode-agent",
      metadata: { orchestrationEnabled: true },
    },
    parts: [
      {
        id: "part-1",
        sessionID: SESSION_ID,
        messageID: USER_MESSAGE_ID,
        type: "text",
        text: "测试和审阅下未提交的代码有没有啥问题",
      },
    ],
  } as unknown as MessageWithParts;

  const events = synthesizeEventsFromMessages([message], { sessionId: SESSION_ID });
  const started = events.find((event) => event.type === SessionEventType.TurnStarted);
  assert.ok(started, "冷恢复必须合成 TurnStarted");
  assert.equal((started.payload as { orchestrationEnabled?: boolean }).orchestrationEnabled, true);
});

test("冷恢复：经典消息不补 orchestrationEnabled", () => {
  const message = {
    info: {
      id: USER_MESSAGE_ID,
      sessionID: SESSION_ID,
      role: "user",
      time: { created: BASE_TIME },
      agent: "zcode-agent",
    },
    parts: [
      {
        id: "part-1",
        sessionID: SESSION_ID,
        messageID: USER_MESSAGE_ID,
        type: "text",
        text: "普通消息",
      },
    ],
  } as unknown as MessageWithParts;

  const events = synthesizeEventsFromMessages([message], { sessionId: SESSION_ID });
  const started = events.find((event) => event.type === SessionEventType.TurnStarted);
  assert.ok(started, "冷恢复必须合成 TurnStarted");
  assert.equal(Object.hasOwn(started.payload as object, "orchestrationEnabled"), false);
});
