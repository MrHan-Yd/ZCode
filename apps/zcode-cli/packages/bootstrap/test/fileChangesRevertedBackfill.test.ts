import assert from "node:assert/strict";
import test from "node:test";
import {
  RewindScope,
  RewindStrategy,
  SessionEventType,
  type SessionEvent,
} from "@zcode/contracts";
import {
  readConversationFileChangesFromEvents,
  selectColdFileChangeMessageIds,
} from "../src/zcode-protocol-v4/cold-file-change-summaries.js";

/**
 * 尾窗裁剪把旧轮推迟到按需读取；按需结果必须带回持久化的「按文件撤销」状态。
 *
 * 否则投影补种会缺省成 active：已撤销轮重新出现撤销入口，再次撤销会覆盖用户在
 * 撤销后手改的文件。这里锁定 messageId 匹配与 runtime turnId 兜底两条路径。
 */

const SESSION_ID = "session-file-change-reverted";
const MESSAGE_ID = "msg-user-1";
const RUNTIME_TURN_ID = "turn-runtime-1";

function checkpointEvent(): SessionEvent {
  return {
    id: "evt-checkpoint",
    sessionId: SESSION_ID,
    type: SessionEventType.CheckpointCreated,
    timestamp: new Date(1_767_225_600_000),
    traceId: "trace-1",
    sequenceNumber: 1,
    turnId: RUNTIME_TURN_ID,
    payload: {
      checkpointId: "checkpoint_1",
      messageId: MESSAGE_ID,
      targetMessageId: MESSAGE_ID,
      scope: RewindScope.Workspace,
      snapshotRef: "artifact://checkpoint_1",
      diffRef: "artifact://checkpoint_1",
      fileCount: 1,
    },
  } as unknown as SessionEvent;
}

function rewindEvent(input: {
  turnId?: string;
  targetMessageId?: string;
  reason?: string;
  scope?: string;
}): SessionEvent {
  return {
    id: "evt-rewind",
    sessionId: SESSION_ID,
    type: SessionEventType.RewindTriggered,
    timestamp: new Date(1_767_225_600_100),
    traceId: "trace-1",
    sequenceNumber: 2,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    payload: {
      rewindId: "rewind-1",
      scope: input.scope ?? RewindScope.Workspace,
      strategy: RewindStrategy.FileOnly,
      ...(input.targetMessageId ? { targetMessageId: input.targetMessageId } : {}),
      reason: input.reason ?? "file_summary_rewind",
    },
  } as unknown as SessionEvent;
}

function artifactJson(): string {
  return JSON.stringify({
    version: 1,
    kind: "workspace_file_before_change",
    createdAt: "2026-01-01T00:00:00.000Z",
    toolCallId: "call-1",
    toolName: "write_file",
    files: [
      {
        path: "src/a.ts",
        existedBefore: true,
        beforeContent: "old\n",
        afterContent: "new\n",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-old", "+new"],
          },
        ],
      },
    ],
  });
}

async function read(
  events: SessionEvent[],
  messageIds: string[],
  targetTurnId?: string,
) {
  return readConversationFileChangesFromEvents({
    events,
    messageIds,
    readArtifact: async () => artifactJson(),
    ...(targetTurnId ? { targetTurnId: targetTurnId as never } : {}),
  });
}

test("targetMessageId 命中时返回 reverted", async () => {
  const result = await read(
    [checkpointEvent(), rewindEvent({ targetMessageId: MESSAGE_ID })],
    [MESSAGE_ID],
  );
  assert.equal(result.files, 1);
  assert.equal(result.state, "reverted");
});

test("撤销目标属于别的轮时不返回 reverted", async () => {
  const result = await read(
    [checkpointEvent(), rewindEvent({ targetMessageId: "msg-other" })],
    [MESSAGE_ID],
  );
  assert.equal(result.files, 1);
  assert.equal(result.state, undefined);
});

test("model-only 轮按 runtime turnId 兜底命中", async () => {
  const result = await read(
    [
      checkpointEvent(),
      rewindEvent({ turnId: RUNTIME_TURN_ID, targetMessageId: "msg-not-in-row" }),
    ],
    ["msg-other"],
    RUNTIME_TURN_ID,
  );
  assert.equal(result.state, "reverted");
});

test("非 file_summary_rewind 或非 workspace scope 不改写状态", async () => {
  const otherReason = await read(
    [checkpointEvent(), rewindEvent({ targetMessageId: MESSAGE_ID, reason: "conversation_rewind" })],
    [MESSAGE_ID],
  );
  assert.equal(otherReason.state, undefined);

  const otherScope = await read(
    [checkpointEvent(), rewindEvent({ targetMessageId: MESSAGE_ID, scope: RewindScope.Both })],
    [MESSAGE_ID],
  );
  assert.equal(otherScope.state, undefined);
});

test("尾窗候选选择不受新增状态字段影响", () => {
  const messages = Array.from({ length: 3 }, (_, index) => ({
    info: { id: `msg-${index}`, role: "user" },
    parts: [],
  })) as never;
  assert.deepEqual(selectColdFileChangeMessageIds(messages, 2), ["msg-1", "msg-2"]);
});
