import assert from "node:assert/strict";
import test from "node:test";
import {
  RewindScope,
  SessionEventType,
  type MessageWithParts,
  type SessionEvent,
} from "@zcode/contracts";
import {
  buildColdFileChangeSummaries,
  selectColdFileChangeMessageIds,
  workspaceCheckpointMessageIds,
} from "../src/zcode-protocol-v4/cold-file-change-summaries.js";

/**
 * 冷恢复只为首帧尾窗候选轮重建文件摘要。
 *
 * 全量 907 个 checkpoint 的 artifact 读取 + 逐文件 diff 是冷开最大的固定成本，
 * 而首帧只发 60 行。这里锁定：尾窗选择正确、缺口清单覆盖被跳过的轮、
 * 被跳过的轮不会触发 artifact 读取。
 */

const SESSION_ID = "session-cold-file-change-tail";

function message(index: number): MessageWithParts {
  return {
    info: { id: `msg-${index}`, role: "user" },
    parts: [],
  } as unknown as MessageWithParts;
}

function checkpointEvent(
  messageId: string,
  targetMessageId: string,
  snapshotRef: string,
): SessionEvent {
  return {
    id: `evt-${snapshotRef}`,
    sessionId: SESSION_ID,
    type: SessionEventType.CheckpointCreated,
    timestamp: new Date(1_767_225_600_000),
    traceId: "trace-1",
    sequenceNumber: 1,
    turnId: "turn-1",
    payload: {
      checkpointId: `checkpoint_${snapshotRef}`,
      messageId,
      targetMessageId,
      scope: RewindScope.Workspace,
      snapshotRef,
      diffRef: snapshotRef,
      fileCount: 1,
    },
  } as unknown as SessionEvent;
}

function checkpointArtifactJson(): string {
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

test("尾窗选择保留最后 N 条消息的 messageId 与顺序", () => {
  const messages = Array.from({ length: 250 }, (_, index) => message(index));

  const defaultTail = selectColdFileChangeMessageIds(messages);
  assert.equal(defaultTail.length, 200);
  assert.equal(defaultTail[0], "msg-50");
  assert.equal(defaultTail.at(-1), "msg-249");

  assert.deepEqual(selectColdFileChangeMessageIds(messages, 3), [
    "msg-247",
    "msg-248",
    "msg-249",
  ]);
  assert.deepEqual(selectColdFileChangeMessageIds(messages, 0), []);
  assert.equal(selectColdFileChangeMessageIds(messages, 10_000).length, 250);
});

test("checkpoint 目标 messageId 去重并优先 targetMessageId", () => {
  const events = [
    checkpointEvent("msg-a", "msg-a", "ref-a"),
    checkpointEvent("msg-a", "msg-a", "ref-a-dup"),
    checkpointEvent("msg-b-legacy", "msg-b", "ref-b"),
  ];
  assert.deepEqual(workspaceCheckpointMessageIds(events), ["msg-a", "msg-b"]);
});

test("只给尾窗候选时，非候选 checkpoint 不读 artifact、不产摘要", async () => {
  const events = [
    checkpointEvent("msg-a", "msg-a", "ref-a"),
    checkpointEvent("msg-b", "msg-b", "ref-b"),
  ];
  const reads: string[] = [];
  const summaries = await buildColdFileChangeSummaries({
    events,
    messageIds: ["msg-b"],
    readArtifact: async (ref) => {
      reads.push(ref);
      return checkpointArtifactJson();
    },
  });

  assert.deepEqual(reads, ["ref-b"], "只允许读尾窗候选轮的 artifact");
  assert.deepEqual([...summaries.keys()], ["msg-b"]);
  assert.equal(summaries.has("msg-a"), false);
});

test("候选为空时不读任何 artifact", async () => {
  const reads: string[] = [];
  const summaries = await buildColdFileChangeSummaries({
    events: [checkpointEvent("msg-a", "msg-a", "ref-a")],
    messageIds: [],
    readArtifact: async (ref) => {
      reads.push(ref);
      return checkpointArtifactJson();
    },
  });
  assert.deepEqual(reads, []);
  assert.equal(summaries.size, 0);
});
