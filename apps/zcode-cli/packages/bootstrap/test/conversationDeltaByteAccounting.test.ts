import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationDelta,
  ConversationRow,
  ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import { applyConversationDeltas, utf8JsonByteLength } from "@zcode/shared/zcode-protocol-v4";
import { conversationRowDeltaGrowthUpperBound } from "../src/zcode-protocol-v4/conversation-topic-publisher.js";

/**
 * 行级增量字节记账的差分护栏（specs/publisher-delta-byte-accounting.md）：
 *
 * 上界函数是 ingest judge 快路径的裁判——它若低估，16MiB 闸门会被算松。这里不逐条复刻
 * 论证，而是直接验证核心不变量：对任意不含 `state.updated` 的 delta 序列，
 * `conversationRowDeltaGrowthUpperBound(deltas, before)` 恒 ≥ 快照的全量字节增长
 * （wire snapshot ⊆ 全量投影，全量上界成立则 wire 上界成立）。
 * 测试用最小快照对象即可：函数只读 `rows.window`，全量差分只依赖 `applyConversationDeltas`。
 */

function makeRow(rowId: number, text: string): ConversationRow {
  return {
    kind: "assistantText",
    rowId,
    turnId: "turn-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    createdAtSeq: rowId,
    text,
    state: "streaming",
  } as unknown as ConversationRow;
}

function makeSnapshot(rows: ConversationRow[], seq = 1): ConversationSnapshot {
  return {
    rows: {
      window: rows,
      totalCount: rows.length,
      firstRowId: rows[0]?.rowId ?? null,
    },
    seq,
    revision: 1,
  } as unknown as ConversationSnapshot;
}

function assertUpperBoundHolds(deltas: readonly ConversationDelta[], before: ConversationSnapshot) {
  const bound = conversationRowDeltaGrowthUpperBound(deltas, before);
  const after = applyConversationDeltas(before, deltas);
  const realGrowth = utf8JsonByteLength(after) - utf8JsonByteLength(before);
  assert.notEqual(
    bound,
    null,
    `不含 state.updated 的批次必须给出上界：${JSON.stringify(deltas.map((d) => d.op))}`,
  );
  assert.ok(
    (bound as number) >= realGrowth,
    `上界 ${bound} 低于真实增长 ${realGrowth}（seq=${before.seq}）`,
  );
}

test("row.appended：上界覆盖新行全量字节", () => {
  const before = makeSnapshot([makeRow(1, "existing")]);
  const deltas: ConversationDelta[] = [
    { op: "row.appended", row: makeRow(2, "x".repeat(1024)) },
  ];
  assertUpperBoundHolds(deltas, before);
});

test("row.appended 挤头：wire 只会更小，全量增长仍被覆盖", () => {
  const rows = Array.from({ length: 80 }, (_, i) => makeRow(i + 1, `row-${i}`));
  const before = makeSnapshot(rows, 100);
  const deltas: ConversationDelta[] = [
    { op: "row.appended", row: makeRow(81, "tail-row") },
    { op: "row.removed", fromRowId: 2 },
  ];
  assertUpperBoundHolds(deltas, before);
});

test("row.upserted：增长按新旧行差量计入", () => {
  const before = makeSnapshot([makeRow(1, "short")]);
  const deltas: ConversationDelta[] = [
    { op: "row.upserted", row: makeRow(1, "short" + "y".repeat(4096)) },
  ];
  assertUpperBoundHolds(deltas, before);
});

test("row.upserted 未加载 rowId：no-op 增长为 0，上界仍成立", () => {
  const before = makeSnapshot([makeRow(1, "existing")]);
  const deltas: ConversationDelta[] = [
    { op: "row.upserted", row: makeRow(999, "ghost") },
  ];
  assertUpperBoundHolds(deltas, before);
});

test("row.delta：append 文本按载荷计入", () => {
  const before = makeSnapshot([makeRow(1, "streaming")]);
  const deltas: ConversationDelta[] = [
    { op: "row.delta", rowId: 1, path: "text", append: " more text ".repeat(128) },
  ];
  assertUpperBoundHolds(deltas, before);
});

test("row.removed：快照变小，上界为余量", () => {
  const before = makeSnapshot([makeRow(1, "keep"), makeRow(2, "z".repeat(2048))]);
  const deltas: ConversationDelta[] = [{ op: "row.removed", fromRowId: 2 }];
  assertUpperBoundHolds(deltas, before);
});

test("含其它键或空 patch 的 state.updated：整键替换，必须返回 null", () => {
  const before = makeSnapshot([makeRow(1, "existing")]);
  const emptyPatch = [
    { op: "row.appended", row: makeRow(2, "new") },
    { op: "state.updated", patch: {} },
  ] as unknown as ConversationDelta[];
  assert.equal(conversationRowDeltaGrowthUpperBound(emptyPatch, before), null);

  const otherKey = [
    { op: "row.appended", row: makeRow(2, "new") },
    { op: "state.updated", patch: { pendingInteractions: [] } },
  ] as unknown as ConversationDelta[];
  assert.equal(conversationRowDeltaGrowthUpperBound(otherKey, before), null);
});

test("仅含 revision 的 state.updated：attachRevision 注入的标量增量给上界，不落回精确测量", () => {
  // product-projection.attachRevision 在任何抬 revision 的结构性批次尾部注入的正是这种 op；
  // 它能给出上界，正是行创建/工具状态推进批次得以走快路径的前提。
  const before = makeSnapshot([makeRow(1, "existing")], 1);
  const deltas = [
    { op: "row.appended", row: makeRow(2, "x".repeat(1024)) },
    { op: "state.updated", patch: { revision: 2 } },
  ] as unknown as ConversationDelta[];
  assertUpperBoundHolds(deltas, before);
});

test("仅含 revision 且跨位数增长：上界仍覆盖真实增长", () => {
  const before = {
    ...makeSnapshot([makeRow(1, "existing")]),
    revision: 9,
  } as ConversationSnapshot;
  const deltas = [
    { op: "state.updated", patch: { revision: 10 } },
  ] as unknown as ConversationDelta[];
  assertUpperBoundHolds(deltas, before);
});

test("批内 append 后 upsert 同一行：上界覆盖终态增长（旧实现低估）", () => {
  const before = makeSnapshot([makeRow(1, "existing")]);
  const deltas: ConversationDelta[] = [
    { op: "row.appended", row: makeRow(9, "small") },
    { op: "row.upserted", row: makeRow(9, "b".repeat(4096)) },
  ];
  assertUpperBoundHolds(deltas, before);
});

test("批内 append 后 removed 覆盖同一行：上界仍成立", () => {
  const before = makeSnapshot([makeRow(1, "existing")]);
  const deltas: ConversationDelta[] = [
    { op: "row.appended", row: makeRow(7, "z".repeat(2048)) },
    { op: "row.removed", fromRowId: 7 },
  ];
  assertUpperBoundHolds(deltas, before);
});

test("随机混合批次差分：上界恒 ≥ 全量字节增长（200 轮）", () => {
  // 确定性伪随机：固定种子，失败可复现。
  let seed = 0x2f6e2b1;
  const random = (max: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % max;
  };

  let snapshot = makeSnapshot([makeRow(1, "seed-row")], 1);

  for (let round = 0; round < 200; round += 1) {
    const currentRows = snapshot.rows.window as ConversationRow[];
    const deltas: ConversationDelta[] = [];
    const opCount = 1 + random(4);
    let nextRowId =
      currentRows.length > 0 ? currentRows[currentRows.length - 1]!.rowId + 1 : 1;
    for (let i = 0; i < opCount; i += 1) {
      const pick = random(4);
      const randomText = (max: number) => "t".repeat(random(max));
      if (pick === 0) {
        deltas.push({ op: "row.appended", row: makeRow(nextRowId, randomText(2048)) });
        nextRowId += 1;
      } else if (pick === 1 && currentRows.length > 0) {
        const target = currentRows[random(currentRows.length)]!;
        deltas.push({ op: "row.upserted", row: makeRow(target.rowId, randomText(4096)) });
      } else if (pick === 2 && currentRows.length > 0) {
        const target = currentRows[random(currentRows.length)]!;
        deltas.push({
          op: "row.delta",
          rowId: target.rowId,
          path: "text",
          append: randomText(512),
        });
      } else if (currentRows.length > 0) {
        deltas.push({
          op: "row.removed",
          fromRowId: currentRows[random(currentRows.length)]!.rowId,
        });
      }
    }
    if (deltas.length === 0) continue;

    // 参照系：应用前快照 vs 应用后快照的整字节差。wire ⊆ 全量投影，
    // 全量上界成立即覆盖 wire 窗口语义（挤头/过滤只会让 wire 增长更小）。
    const before = snapshot;
    const bound = conversationRowDeltaGrowthUpperBound(deltas, before);
    const after = applyConversationDeltas(before, deltas);
    const realGrowth = utf8JsonByteLength(after) - utf8JsonByteLength(before);
    assert.notEqual(bound, null, `round ${round}：非 state.updated 批次必须给出上界`);
    assert.ok(
      (bound as number) >= realGrowth,
      `round ${round}：上界 ${bound} < 真实增长 ${realGrowth}`,
    );
    snapshot = after;
  }
});
