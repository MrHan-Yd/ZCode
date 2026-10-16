import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  utf8JsonByteLength,
  type TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ConversationTopicPublisher,
  conversationRowDeltaGrowthUpperBound,
} from "../src/zcode-protocol-v4/conversation-topic-publisher.js";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

/**
 * 冷恢复「缺口轮」按需回填补种的护栏（specs/conversation-file-change-summary.md）。
 *
 * 症状：缺口轮在按需读取（`v4/conversation/fileChanges`）后能看到文件变更胶囊，
 * 但「回退」按钮恒禁用——服务端 `resolveRowActionTarget` 的
 * `applyFileRewind` / `fileRewindPreview` 共用 `row.fileChanges && canRewindFiles` 守卫，
 * 而缺口轮的投影 row 从来没有 fileChanges。
 *
 * 修复口径：按需读取成功且 `files > 0` 时把摘要补种回投影（唯一所有者），走 ingest 的
 * delta 记账 + 扇出，派生 actions.canRewindFiles。本测试锁定：
 * ① 补种后 canRewindFiles 派生且 fileRewindPreview target 可解析；
 * ② 补种走 delta 广播（订阅者 flush 出的帧能带到）；
 * ③ 幂等（二次补种 no-op，seq/revision 不再抬）；
 * ④ files === 0 不补种；⑤ 已有 fileChanges 的轮不被补种覆盖；
 * ⑥ 补种 delta 的增长上界覆盖真实快照增长（16MiB 闸门不被算松）。
 */

const SESSION_ID = "session-file-change-seed";
const LOG_EPOCH = "epoch-file-change-seed";
const RUNTIME_TURN_ID = "turn-runtime-1";
const USER_MESSAGE_ID = "msg-user-1";

let eventSerial = 0;

function nextEventId(kind: string): string {
  eventSerial += 1;
  return `evt-${kind}-${eventSerial}`;
}

function turnStarted(): SessionEvent {
  return {
    id: nextEventId("started"),
    sessionId: SESSION_ID,
    type: SessionEventType.TurnStarted,
    timestamp: new Date(1_767_225_600_000),
    sequenceNumber: 1,
    turnId: RUNTIME_TURN_ID,
    payload: {
      turnNumber: 1,
      input: "改一下文件",
      messageId: USER_MESSAGE_ID,
    },
  } as unknown as SessionEvent;
}

function turnComplete(): SessionEvent {
  return {
    id: nextEventId("complete"),
    sessionId: SESSION_ID,
    type: SessionEventType.TurnComplete,
    timestamp: new Date(1_767_225_600_100),
    sequenceNumber: 2,
    turnId: RUNTIME_TURN_ID,
    payload: {
      resultType: "success",
      duration: 1_000,
    },
  } as unknown as SessionEvent;
}

/** 第二个缺口轮：验证「同批多个缺口轮」不会被补种彼此作废。 */
function secondTurnStarted(): SessionEvent {
  return {
    id: nextEventId("started-2"),
    sessionId: SESSION_ID,
    type: SessionEventType.TurnStarted,
    timestamp: new Date(1_767_225_600_200),
    sequenceNumber: 3,
    turnId: "turn-runtime-2",
    payload: {
      turnNumber: 2,
      input: "再改一下",
      messageId: "msg-user-2",
    },
  } as unknown as SessionEvent;
}

function secondTurnComplete(): SessionEvent {
  return {
    id: nextEventId("complete-2"),
    sessionId: SESSION_ID,
    type: SessionEventType.TurnComplete,
    timestamp: new Date(1_767_225_600_300),
    sequenceNumber: 4,
    turnId: "turn-runtime-2",
    payload: {
      resultType: "success",
      duration: 500,
    },
  } as unknown as SessionEvent;
}

/** hydrate 路径写 fileChanges 的真实来源：ModelComplete 的 fileChanges（> 0 才写）。 */
function modelCompleteWithFileChanges(): SessionEvent {
  return {
    id: nextEventId("model-complete"),
    sessionId: SESSION_ID,
    type: SessionEventType.ModelComplete,
    timestamp: new Date(1_767_225_600_050),
    sequenceNumber: 2,
    turnId: RUNTIME_TURN_ID,
    payload: {
      content: "",
      querySource: "main_turn",
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
      fileChanges: {
        additions: 7,
        deletions: 1,
        files: 3,
        items: [
          { path: "src/a.ts", additions: 7, deletions: 1, writeCount: 1, toolNames: ["write_file"] },
        ],
      },
    },
  } as unknown as SessionEvent;
}

function findTurnHeader(  publisher: ConversationTopicPublisher,
  rowId?: number,
): TurnHeaderRow | undefined {
  return publisher
    .getSnapshot()
    .rows.window.find(
      (row): row is TurnHeaderRow =>
        row.kind === "turnHeader" && (rowId === undefined || row.rowId === rowId),
    );
}

/** 建一个「终态但无 fileChanges」的缺口轮，返回它的 turnHeader rowId / entityId。 */
function buildGapTurn(): {
  publisher: ConversationTopicPublisher;
  rowId: number;
  entityId: string;
} {
  eventSerial = 0;
  const publisher = new ConversationTopicPublisher(SESSION_ID, LOG_EPOCH);
  publisher.ingest(turnStarted());
  publisher.ingest(turnComplete());
  const header = findTurnHeader(publisher);
  assert.ok(header, "TurnStarted + TurnComplete 必须产出一条 turnHeader");
  assert.equal(
    findTurnHeader(publisher, header.rowId)?.fileChanges,
    undefined,
    "缺口轮的 header 刻意没有 fileChanges",
  );
  assert.ok(header.entityId, "turnHeader 必须带 canonical entityId（target 解析要求）");
  return { publisher, rowId: header.rowId, entityId: header.entityId };
}

test("补种后该轮派生 canRewindFiles，且 fileRewindPreview target 可解析", () => {
  const { publisher, rowId, entityId } = buildGapTurn();
  const target = { rowId, entityId };
  const before = publisher.resolveRowActionTarget(target, "fileRewindPreview");
  assert.equal(
    before.ok,
    false,
    "补种前守卫必须拒绝——这正是「回退按钮恒禁用」的服务端根因",
  );
  assert.equal(
    before.ok === false ? before.reasonCode : null,
    "guard.actionUnavailable",
    "拒绝原因必须是 guard.actionUnavailable（而非 stale target）",
  );

  const seededSeq = publisher.seedAuthoritativeFileChanges(rowId, {
    files: 2,
    additions: 5,
    deletions: 3,
  });
  assert.notEqual(seededSeq, null, "files > 0 必须补种");
  assert.equal(seededSeq, 3, "补种占用一格新的 transport seq（2 条事件之后）");

  const row = findTurnHeader(publisher, rowId);
  assert.ok(row);
  assert.deepEqual(row.fileChanges, {
    additions: 5,
    deletions: 3,
    files: 2,
    state: "active",
  });
  assert.equal(row.actions?.canRewindFiles, true, "actions 必须与 row 同一次 materialization 派生");

  for (const action of ["fileRewindPreview", "applyFileRewind"] as const) {
    const resolution = publisher.resolveRowActionTarget(target, action);
    assert.equal(resolution.ok, true, `${action} 必须可解析：${JSON.stringify(resolution)}`);
  }
});

test("补种走 delta 广播：订阅者 flush 出的帧能带到这里", () => {
  const { publisher, rowId } = buildGapTurn();
  const subscription = publisher.subscribe({
    connectionId: "conn-1",
    deliveryProfile: "continuous",
  });
  const subscriptionId = subscription.ack.subscriptionId;
  assert.equal(subscription.ack.mode, "snapshot");
  const snapshotSeq = publisher.getSnapshot().seq;

  publisher.seedAuthoritativeFileChanges(rowId, { files: 1, additions: 1, deletions: 0 });

  const frame = publisher.flush(subscriptionId);
  assert.ok(frame, "补种必须产出可 flush 的 delta 帧（只改快照不推 delta 的话客户端永远看不到）");
  assert.equal(frame.fromSeq, snapshotSeq, "帧区间必须与客户端水位衔接");
  assert.equal(
    frame.toSeq,
    snapshotSeq + 1,
    "帧右端点必须严格大于客户端水位，否则客户端按「迟到/重复帧」静默丢弃",
  );
  assert.equal(frame.payload.kind, "deltas");
  if (frame.payload.kind !== "deltas") throw new Error("unreachable");
  assert.ok(
    frame.payload.deltas.some(
      (delta) =>
        delta.op === "row.upserted" &&
        delta.row.rowId === rowId &&
        delta.row.kind === "turnHeader" &&
        delta.row.fileChanges?.state === "active",
    ),
    "帧里必须含带 fileChanges 的 row.upserted",
  );
});

test("幂等：二次补种同一轮是 no-op，seq/revision 不再抬", () => {
  const { publisher, rowId } = buildGapTurn();
  const firstSeq = publisher.seedAuthoritativeFileChanges(rowId, {
    files: 2,
    additions: 5,
    deletions: 3,
  });
  assert.notEqual(firstSeq, null);
  const afterFirst = publisher.getSnapshot();
  const summaryAfterFirst = findTurnHeader(publisher, rowId)?.fileChanges;

  const secondSeq = publisher.seedAuthoritativeFileChanges(rowId, {
    files: 9,
    additions: 99,
    deletions: 99,
  });
  assert.equal(secondSeq, null, "已有 fileChanges 时补种必须是 no-op");
  const afterSecond = publisher.getSnapshot();
  assert.equal(afterSecond.seq, afterFirst.seq, "no-op 不得推进 seq");
  assert.equal(afterSecond.revision, afterFirst.revision, "no-op 不得抬 revision");
  assert.deepEqual(
    findTurnHeader(publisher, rowId)?.fileChanges,
    summaryAfterFirst,
    "已有摘要不得被覆盖",
  );
});

test("补种是 revision-neutral：不抬 revision，同批兄弟读取的 baseRevision 不被作废", () => {
  eventSerial = 0;
  const publisher = new ConversationTopicPublisher(SESSION_ID, LOG_EPOCH);
  publisher.ingest(turnStarted());
  publisher.ingest(turnComplete());
  publisher.ingest(secondTurnStarted());
  publisher.ingest(secondTurnComplete());
  const headers = publisher
    .getSnapshot()
    .rows.window.filter((row): row is TurnHeaderRow => row.kind === "turnHeader");
  assert.equal(headers.length, 2, "需要两个缺口轮");

  const baseRevision = publisher.getSnapshot().revision;
  for (const header of headers) {
    assert.ok(header.entityId);
    // 模拟 gateway 的读 RPC CAS：baseRevision 必须仍等于服务端 revision。
    // 补种若抬 revision，第二条读（同批发出）就会被 proto.staleRevision 拒绝，
    // 客户端连胶囊都拿不到——这比修复前更差，所以补种必须 revision-neutral。
    assert.equal(publisher.getSnapshot().revision, baseRevision);
    const seq = publisher.seedAuthoritativeFileChanges(header.rowId, {
      files: 1,
      additions: 2,
      deletions: 1,
    });
    assert.notEqual(seq, null, "同一 baseRevision 下两个缺口轮都必须能补种");
  }

  assert.equal(publisher.getSnapshot().revision, baseRevision, "补种不得抬 revision");
  for (const header of headers) {
    const row = findTurnHeader(publisher, header.rowId);
    assert.ok(row);
    assert.equal(row.actions?.canRewindFiles, true);
    const entityId = header.entityId;
    assert.ok(entityId);
    assert.equal(
      publisher.resolveRowActionTarget({ rowId: header.rowId, entityId }, "fileRewindPreview").ok,
      true,
    );
  }
});

test("files === 0 不补种：canRewindFiles 保持缺席", () => {
  const { publisher, rowId, entityId } = buildGapTurn();
  const before = publisher.getSnapshot();
  const seq = publisher.seedAuthoritativeFileChanges(rowId, {
    files: 0,
    additions: 0,
    deletions: 0,
  });
  assert.equal(seq, null, "没改文件的轮不得被说成可回退");
  const after = publisher.getSnapshot();
  assert.equal(after.seq, before.seq);
  assert.equal(after.revision, before.revision);
  const row = findTurnHeader(publisher, rowId);
  assert.ok(row);
  assert.equal(row.fileChanges, undefined);
  assert.equal(row.actions?.canRewindFiles, undefined);
  const resolution = publisher.resolveRowActionTarget({ rowId, entityId }, "fileRewindPreview");
  assert.equal(resolution.ok, false);
  assert.equal(resolution.ok === false ? resolution.reasonCode : null, "guard.actionUnavailable");
});

test("已 hydrate 出 fileChanges 的轮不被补种覆盖", () => {
  eventSerial = 0;
  const publisher = new ConversationTopicPublisher(SESSION_ID, LOG_EPOCH);
  publisher.ingest(turnStarted());
  publisher.ingest(modelCompleteWithFileChanges());
  publisher.ingest(turnComplete());
  const header = findTurnHeader(publisher);
  assert.ok(header);
  assert.deepEqual(
    header.fileChanges,
    { additions: 7, deletions: 1, files: 3, state: "active" },
    "hydrate 路径（ModelComplete 归约）应已写出摘要",
  );

  const seq = publisher.seedAuthoritativeFileChanges(header.rowId, {
    files: 99,
    additions: 99,
    deletions: 99,
  });
  assert.equal(seq, null, "已有 fileChanges 的轮必须 no-op");
  assert.deepEqual(findTurnHeader(publisher, header.rowId)?.fileChanges, {
    additions: 7,
    deletions: 1,
    files: 3,
    state: "active",
  });
});

test("补种 delta 的增长上界覆盖真实快照增长（16MiB 闸门不被算松）", () => {
  eventSerial = 0;
  const projection = new ProductProjection(SESSION_ID, LOG_EPOCH);
  projection.applyEvent(turnStarted());
  projection.applyEvent(turnComplete());
  const before = projection.getSnapshot();
  const header = before.rows.window.find(
    (row): row is TurnHeaderRow => row.kind === "turnHeader",
  );
  assert.ok(header);

  const deltas = projection.seedAuthoritativeFileChanges(
    { rowId: header.rowId, seq: before.seq + 1, files: 12, additions: 345, deletions: 67 },
    () => true,
  );
  assert.ok(deltas, "补种必须产出 delta");

  // 与 ingest 快路径同一条判据：上界必须存在且 ≥ 真实快照字节增长。
  const bound = conversationRowDeltaGrowthUpperBound(deltas, before);
  const after = projection.getSnapshot();
  const realGrowth = utf8JsonByteLength(after) - utf8JsonByteLength(before);
  assert.notEqual(
    bound,
    null,
    "补种 delta 形状必须能给出上界（否则会绕过 wireSnapshotBytesUpperBound）",
  );
  assert.ok((bound as number) >= realGrowth, `上界 ${bound} 低于真实增长 ${realGrowth}`);
});
