import assert from "node:assert/strict";
import test from "node:test";
import { RewindScope, SessionEventType, type SessionEvent } from "@zcode/contracts";
import { buildColdFileChangeSummaries } from "../src/zcode-protocol-v4/cold-file-change-summaries.js";

/**
 * 合并差分不可得时的口径护栏。
 *
 * `diff` 的 `structuredPatch` 在命中 `timeout` / `maxEditLength` 时返回 **undefined**
 * （见 diff 的 TimeoutOption 文档）。旧实现写成 `structuredPatch(...)?.hunks ?? []`，
 * 于是超时被吞成「空 hunks」，`countPatchLines` 得出 0/0——对一个确实被改过的文件宣称
 * 「没有改动」，而且 item 照常发出，消费方无法区分「没改」与「算不出」。
 * 这里锁定：不可得时必须退回逐次写入的 structuredPatch 与行数，绝不产出 0/0。
 */

const SESSION_ID = "session-cold-file-change-fallback";
const TURN_ID = "turn-1";
const MESSAGE_ID = "msg-user-1";
const FILE_PATH = "src/big.ts";

/** 逐次写入时落库的 stored patch：+2 −1。 */
const STORED_HUNKS = [
  {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 4,
    lines: [" context", "-removed", "+added", "+added too", " tail"],
  },
];

function checkpointArtifactJson(): string {
  return JSON.stringify({
    version: 1,
    kind: "workspace_file_before_change",
    createdAt: "2026-01-01T00:00:00.000Z",
    toolCallId: "call-1",
    toolName: "write_file",
    files: [
      {
        path: FILE_PATH,
        existedBefore: true,
        beforeContent: "old\n",
        afterContent: "brand new\n",
        structuredPatch: STORED_HUNKS,
      },
    ],
  });
}

function checkpointEvent(): SessionEvent {
  return {
    id: "evt-checkpoint-1",
    sessionId: SESSION_ID,
    type: SessionEventType.CheckpointCreated,
    timestamp: new Date(1_767_225_600_000),
    traceId: "trace-1",
    sequenceNumber: 1,
    turnId: TURN_ID,
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

async function summarize(createConsolidatedPatch: () => undefined | typeof STORED_HUNKS) {
  const unavailable: string[] = [];
  const summaries = await buildColdFileChangeSummaries({
    events: [checkpointEvent()],
    messageIds: [MESSAGE_ID],
    readArtifact: async () => checkpointArtifactJson(),
    createConsolidatedPatch,
    onConsolidatedPatchUnavailable: (messageId, path) => {
      unavailable.push(`${messageId}:${path}`);
    },
  });
  return { summaries, unavailable };
}

test("合并差分返回 undefined（超时）时退回逐次写入行数，不报 0/0", async () => {
  const { summaries, unavailable } = await summarize(() => undefined);
  const summary = summaries.get(MESSAGE_ID);
  assert.ok(summary, "回退不是丢弃：摘要必须仍然产出");
  const item = summary.items.find((candidate) => candidate.path === FILE_PATH);
  assert.ok(item, "该文件必须仍在 items 里");
  assert.equal(item.additions, 2, "必须退回 stored patch 的 +2，而不是超时后的 0");
  assert.equal(item.deletions, 1, "必须退回 stored patch 的 −1，而不是超时后的 0");
  assert.deepEqual(item.toolNames, ["write_file"]);
  assert.equal(item.writeCount, 1);
  assert.deepEqual(unavailable, [`${MESSAGE_ID}:${FILE_PATH}`], "回退必须留痕");
  assert.equal(summary.additions, 2, "汇总行数同样取回退口径");
  assert.equal(summary.deletions, 1);
  assert.equal(summary.files, 1);
});

test("合并差分可得时用合并结果，且不触发回退留痕", async () => {
  const { summaries, unavailable } = await summarize(() => [
    {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: ["-old", "+brand new"],
    },
  ]);
  const summary = summaries.get(MESSAGE_ID);
  assert.ok(summary);
  const item = summary.items.find((candidate) => candidate.path === FILE_PATH);
  assert.ok(item);
  assert.equal(item.additions, 1);
  assert.equal(item.deletions, 1);
  assert.deepEqual(unavailable, []);
});
