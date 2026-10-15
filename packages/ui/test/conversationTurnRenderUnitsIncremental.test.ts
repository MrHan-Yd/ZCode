import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import { conversationRowSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  buildConversationTurnRenderUnitsUncached,
  type ConversationTurnRenderUnit,
} from "../src/v4/conversationTurnRenderUnits.js";
import { createConversationTurnRenderUnitsBuilder } from "../src/v4/conversationTurnRenderUnitsCache.js";

/**
 * render units 增量构建的差分护栏（specs/conversation-render-units-incremental.md）。
 *
 * 增量实现按**调用点**各持一份缓存槽（createConversationTurnRenderUnitsBuilder），任何一步的
 * 输出都必须与 uncached 全量构建逐字段相等；引用稳定性是收益来源（未变 turn 的 unit 保持原
 * 对象），一并断言。行对象统一经 conversationRowSchema.parse 生成，保证字段与真实投影一致。
 */

function rowOf(input: Record<string, unknown>): ConversationRow {
  return conversationRowSchema.parse(input);
}

let rowIdSeq = 0;
function turnHeader(
  turnId: string,
  state: "running" | "completedSuccess" = "running",
): ConversationRow {
  return rowOf({
    kind: "turnHeader",
    rowId: (rowIdSeq += 1),
    turnId,
    createdAt: 1767225600000,
    createdAtSeq: rowIdSeq,
    state,
    origin: "userInput",
    startedAt: 1767225600000,
  });
}

function userInput(turnId: string, text: string): ConversationRow {
  return rowOf({
    kind: "userInput",
    rowId: (rowIdSeq += 1),
    turnId,
    createdAt: 1767225600000,
    createdAtSeq: rowIdSeq,
    text,
    origin: "realUser",
  });
}

function assistantText(turnId: string, text: string, state = "streaming"): ConversationRow {
  return rowOf({
    kind: "assistantText",
    rowId: (rowIdSeq += 1),
    turnId,
    createdAt: 1767225600000,
    createdAtSeq: rowIdSeq,
    text,
    state,
  });
}

function toolCall(turnId: string, toolCallId: string, status = "running"): ConversationRow {
  return rowOf({
    kind: "toolCall",
    rowId: (rowIdSeq += 1),
    turnId,
    createdAt: 1767225600000,
    createdAtSeq: rowIdSeq,
    toolCallId,
    toolName: "read_file",
    status,
    inputText: "{}",
  });
}

function replaceRowText(row: ConversationRow, text: string): ConversationRow {
  // 模拟 row.delta 的投影行为：只换目标行引用（结构共享语义），其余行引用不变。
  return { ...row, text } as ConversationRow;
}

/** 逐字段对比（忽略数组引用差异）；差异时输出首个不一致字段便于定位。 */
function assertUnitsEqual(
  actual: ConversationTurnRenderUnit[],
  expected: ConversationTurnRenderUnit[],
) {
  assert.equal(actual.length, expected.length, "units 数量不一致");
  for (let index = 0; index < actual.length; index += 1) {
    assert.deepEqual(
      actual[index],
      expected[index],
      `units[${index}]（turnId=${expected[index]?.turnId}）逐字段不一致`,
    );
  }
}

test("单 turn 流式追加：增量结果与全量逐字段一致，未变行引用稳定", () => {
  const turnId = "turn-1";
  const build = createConversationTurnRenderUnitsBuilder();
  const initial = [turnHeader(turnId), userInput(turnId, "hi"), assistantText(turnId, "a")];
  const baseline = buildConversationTurnRenderUnitsUncached(initial, {});
  const incremental = build(initial, {});
  assertUnitsEqual(incremental, baseline);
  const streamed = [
    initial[0]!,
    initial[1]!,
    replaceRowText(initial[2]!, "a more tokens"),
    assistantText(turnId, "tool starts", "streaming"),
  ];
  const nextBaseline = buildConversationTurnRenderUnitsUncached(streamed, {});
  const nextIncremental = build(streamed, {});
  assertUnitsEqual(nextIncremental, nextBaseline);
});

test("多 turn：尾部 turn 流式时前面 turn 的 unit 引用保持稳定", () => {
  const t1 = "turn-1";
  const t2 = "turn-2";
  const build = createConversationTurnRenderUnitsBuilder();
  const settled = [turnHeader(t1), userInput(t1, "q1"), assistantText(t1, "a1", "complete")];
  const rows = [...settled, turnHeader(t2), userInput(t2, "q2"), assistantText(t2, "x")];
  const first = build(rows, {});
  // 尾部 turn 流式推进：前缀行引用全部不变。
  const next = [...rows.slice(0, rows.length - 1), replaceRowText(rows[rows.length - 1]!, "xy")];
  const second = build(next, {});
  assert.equal(second.length, first.length);
  assert.equal(second[0], first[0], "未变 turn 的 unit 应保持引用稳定");
  assert.notEqual(second[1], first[1], "流式 turn 的 unit 应重建");
});

test("同一帧两个调用点（不同 options）各持缓存槽：增量路径不被互相覆写", () => {
  // 复现真实调用图：SessionPane 用空 options、ConversationTimeline 用实时 nowMs，在同一棵树上
  // 每帧各调一次同一份 rows。模块级单槽会因此让后渲染者覆写前者基线，增量路径永远落空。
  const buildShareSide = createConversationTurnRenderUnitsBuilder();
  const buildTimelineSide = createConversationTurnRenderUnitsBuilder();
  const t1 = "turn-1";
  const t2 = "turn-2";
  const settled = [turnHeader(t1), userInput(t1, "q1"), assistantText(t1, "a1", "complete")];
  const rows = [...settled, turnHeader(t2), userInput(t2, "q2"), assistantText(t2, "x")];

  const shareFirst = buildShareSide(rows, {});
  const timelineFirst = buildTimelineSide(rows, { nowMs: 1_000, sessionPhase: undefined });

  const next = [...rows.slice(0, rows.length - 1), replaceRowText(rows[rows.length - 1]!, "xy")];
  const shareSecond = buildShareSide(next, {});
  const timelineSecond = buildTimelineSide(next, { nowMs: 1_000, sessionPhase: undefined });

  assert.equal(shareSecond[0], shareFirst[0], "share 侧未变 turn 引用应稳定（增量路径命中）");
  assert.equal(
    timelineSecond[0],
    timelineFirst[0],
    "timeline 侧未变 turn 引用应稳定（增量路径命中）",
  );
  assert.notEqual(shareSecond[1], shareFirst[1]);
  assert.notEqual(timelineSecond[1], timelineFirst[1]);
  assertUnitsEqual(shareSecond, buildConversationTurnRenderUnitsUncached(next, {}));
  assertUnitsEqual(
    timelineSecond,
    buildConversationTurnRenderUnitsUncached(next, { nowMs: 1_000, sessionPhase: undefined }),
  );
});

test("toolCall 状态推进（upsert）：中间行变化只重建所属 turn", () => {
  const t1 = "turn-1";
  const t2 = "turn-2";
  const build = createConversationTurnRenderUnitsBuilder();
  const rows = [
    turnHeader(t1),
    userInput(t1, "q1"),
    toolCall(t1, "call-1", "running"),
    assistantText(t1, "a1", "complete"),
    turnHeader(t2),
    userInput(t2, "q2"),
    assistantText(t2, "a2", "complete"),
  ];
  const first = build(rows, {});
  const next = [...rows.slice(0, 2), toolCall(t1, "call-1", "success"), ...rows.slice(3)];
  const baseline = buildConversationTurnRenderUnitsUncached(next, {});
  const incremental = build(next, {});
  assertUnitsEqual(incremental, baseline);
  const firstT2 = first.find((unit) => unit.turnId === t2);
  const nextT2 = incremental.find((unit) => unit.turnId === t2);
  assert.equal(nextT2, firstT2, "未变 turn-2 的 unit 引用应稳定");
});

test("row.removed 裁掉整 turn 与头部裁剪：结果与全量一致", () => {
  const t0 = "turn-0";
  const t1 = "turn-1";
  const t2 = "turn-2";
  const build = createConversationTurnRenderUnitsBuilder();
  const rows = [
    turnHeader(t0),
    userInput(t0, "old"),
    assistantText(t0, "old answer", "complete"),
    turnHeader(t1),
    userInput(t1, "q1"),
    assistantText(t1, "a1", "complete"),
    turnHeader(t2),
    userInput(t2, "q2"),
    assistantText(t2, "a2", "complete"),
  ];
  void build(rows, {});
  // 头部裁剪（tail window 挤头）：移除 turn-0 的行。
  const trimmed = rows.slice(3);
  const baseline = buildConversationTurnRenderUnitsUncached(trimmed, {});
  const incremental = build(trimmed, {});
  assertUnitsEqual(incremental, baseline);

  // 裁掉尾部整个 turn。
  const shrunk = trimmed.slice(0, 6);
  const shrunkBaseline = buildConversationTurnRenderUnitsUncached(shrunk, {});
  const shrunkIncremental = build(shrunk, {});
  assertUnitsEqual(shrunkIncremental, shrunkBaseline);
});

test("sessionPhase 变化：退化为全量且结果一致", () => {
  const t1 = "turn-1";
  const build = createConversationTurnRenderUnitsBuilder();
  const rows = [turnHeader(t1), userInput(t1, "q"), assistantText(t1, "a", "streaming")];
  const streaming = build(rows, { sessionPhase: undefined });
  const completed: SessionPhase = "completedSuccess";
  const baseline = buildConversationTurnRenderUnitsUncached(rows, { sessionPhase: completed });
  const incremental = build(rows, { sessionPhase: completed });
  assertUnitsEqual(incremental, baseline);
  assert.equal(incremental[0]?.isRunning, streaming[0]?.isRunning);
});

test("nowMs 推进（UI 每秒 tick）且行未变：只重建运行中的 turn，完成态引用稳定", () => {
  // nowMs 是 ConversationTimeline 每秒 tick 的 UI 时钟，只喂「工作中 N 秒」的运行中工时。
  // 时钟推进不能把已加载的全部 turn 拖回全量重建，但运行中 turn 必须跟着重建。
  const settled = "turn-settled";
  const active = "turn-active";
  const build = createConversationTurnRenderUnitsBuilder();
  const rows = [
    turnHeader(settled, "completedSuccess"),
    userInput(settled, "q1"),
    assistantText(settled, "a1", "complete"),
    turnHeader(active, "running"),
    userInput(active, "q2"),
    assistantText(active, "streaming...", "streaming"),
  ];
  const first = build(rows, { nowMs: 1_767_225_600_000 + 1_000 });
  const second = build(rows, { nowMs: 1_767_225_600_000 + 2_000 });

  assertUnitsEqual(
    second,
    buildConversationTurnRenderUnitsUncached(rows, { nowMs: 1_767_225_600_000 + 2_000 }),
  );
  const settledFirst = first.find((unit) => unit.turnId === settled);
  const settledSecond = second.find((unit) => unit.turnId === settled);
  assert.equal(settledSecond, settledFirst, "完成态 turn 的 unit 应跨时钟 tick 保持引用稳定");
  const activeFirst = first.find((unit) => unit.turnId === active);
  const activeSecond = second.find((unit) => unit.turnId === active);
  assert.notEqual(activeSecond, activeFirst, "运行中 turn 的 unit 应随时钟重建");
});

test("行未变、也没有运行中的 turn 时推进 nowMs：全部 unit 引用稳定", () => {
  const t1 = "turn-1";
  const build = createConversationTurnRenderUnitsBuilder();
  const rows = [
    turnHeader(t1, "completedSuccess"),
    userInput(t1, "q"),
    assistantText(t1, "a", "complete"),
  ];
  const first = build(rows, { nowMs: 1_000 });
  const second = build(rows, { nowMs: 2_000 });
  assert.deepEqual(second, first);
  assert.equal(second[0], first[0], "无运行中 turn 时时钟推进不应重建任何 unit");
});

test("随机混合操作序列：增量与全量逐步一致（300 轮）", () => {
  // 确定性伪随机：固定种子，失败可复现。
  let seed = 0x51ed270b;
  const random = (max: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % max;
  };
  const build = createConversationTurnRenderUnitsBuilder();

  let rows: ConversationRow[] = [turnHeader("turn-0"), userInput("turn-0", "seed")];
  let turnCounter = 1;
  let callCounter = 0;
  const phases: (SessionPhase | undefined)[] = [undefined, "completedSuccess", "error"];

  for (let round = 0; round < 300; round += 1) {
    const op = random(6);
    if (op === 0 && rows.length > 0) {
      // 流式追加：替换最后一行文本。
      const last = rows[rows.length - 1]!;
      rows = [...rows.slice(0, -1), replaceRowText(last, `${last.kind}-text-${random(64)}`)];
    } else if (op === 1) {
      // 新 turn：header + userInput + 正文。
      const turnId = `turn-${turnCounter++}`;
      rows = [
        ...rows,
        turnHeader(turnId),
        userInput(turnId, `q-${turnId}`),
        assistantText(turnId, "working"),
      ];
    } else if (op === 2 && rows.length > 0) {
      // upsert toolCall 状态推进。
      const index = random(rows.length);
      const target = rows[index]!;
      if (target.kind === "toolCall") {
        rows = [
          ...rows.slice(0, index),
          toolCall(target.turnId, target.toolCallId, "success"),
          ...rows.slice(index + 1),
        ];
      } else {
        const turnId = `turn-${turnCounter++}`;
        rows = [...rows, turnHeader(turnId), toolCall(turnId, `call-${callCounter++}`)];
      }
    } else if (op === 3 && rows.length > 3) {
      // 头部裁剪。
      rows = rows.slice(1 + random(2));
    } else if (op === 4 && rows.length > 6) {
      // 裁掉尾部若干行（模拟 row.removed）。
      rows = rows.slice(0, rows.length - (1 + random(3)));
    } else if (rows.length > 0) {
      // 追加单行到现有随机 turn。
      const target = rows[random(rows.length)]!;
      rows = [...rows, assistantText(target.turnId, `extra-${round}`)];
    }

    const sessionPhase = phases[random(phases.length)];
    // nowMs 每轮推进 1s：等价于 ConversationTimeline 的每秒 tick，保证纯时钟路径
    // （行未变、只有 nowMs 变化）在随机序列里被反复覆盖。
    const options = { sessionPhase, nowMs: 1_767_225_600_000 + round * 1_000 };
    const baseline = buildConversationTurnRenderUnitsUncached(rows, options);
    const incremental = build(rows, options);
    assertUnitsEqual(incremental, baseline);
  }
});
