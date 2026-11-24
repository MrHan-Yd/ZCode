import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { createLiveOutputTokenReader } from "../src/v4/composer/liveOutputTokens.js";
import {
  appendOutputSpeedSample,
  resolveLiveOutputSpeed,
} from "../src/v4/composer/liveOutputSpeed.js";
import {
  countTurnOutputTokens,
  createTurnOutputTokenEstimator,
} from "../src/v4/composer/streamingOutputTokens.js";

function streamingSnapshot(text: string): ConversationSnapshot {
  return {
    sessionId: "session-1",
    rows: {
      window: [
        { kind: "assistantText", state: "complete", turnId: "turn-1", rowId: 1, text: "已有内容" },
        { kind: "assistantText", state: "streaming", turnId: "turn-1", rowId: 2, text },
      ],
    },
  } as unknown as ConversationSnapshot;
}

const INITIAL_SCOPE_KEY = JSON.stringify(["session-1", "turn-1", 1]);

test("逐帧挂快照不做估算：估算只发生在读的那一刻", () => {
  const calls: Array<ConversationSnapshot | null> = [];
  const reader = createLiveOutputTokenReader((snapshot) => {
    calls.push(snapshot);
    return 42;
  });

  // 模拟一帧一次的快照更新：这是流式期间每 32ms 发生一次的热路径。
  for (let frame = 0; frame < 60; frame += 1) {
    reader.setSnapshot(streamingSnapshot("正文".repeat(frame)), true);
  }
  assert.equal(calls.length, 0);

  // 工具条在 1 秒时钟上采样：一秒一次读数 = 一秒一次估算。
  assert.deepEqual(reader.read(), { tokens: 42, scopeKey: INITIAL_SCOPE_KEY });
  assert.deepEqual(reader.read(), { tokens: 42, scopeKey: INITIAL_SCOPE_KEY });
  assert.equal(calls.length, 2);
});

test("读到的永远是最新挂上的那一帧快照", () => {
  const reader = createLiveOutputTokenReader();
  const first = streamingSnapshot("甲".repeat(90));
  const second = streamingSnapshot("乙".repeat(300));

  reader.setSnapshot(first, true);
  assert.deepEqual(reader.read(), {
    tokens: countTurnOutputTokens(first),
    scopeKey: INITIAL_SCOPE_KEY,
  });

  reader.setSnapshot(second, true);
  assert.deepEqual(reader.read(), {
    tokens: countTurnOutputTokens(second),
    scopeKey: INITIAL_SCOPE_KEY,
  });
  assert.ok(reader.read().tokens > 0);
});

test("非流式相位没有作用域，且只把 null 交给估算（草稿、已结束、被停止）", () => {
  const calls: Array<ConversationSnapshot | null> = [];
  const reader = createLiveOutputTokenReader((snapshot) => {
    calls.push(snapshot);
    return 999;
  });

  reader.setSnapshot(streamingSnapshot("还在流"), true);
  // 相位一变非流式就挂 null：即使测试估算器返回非零值，也不能沿用上一轮的速度。
  reader.setSnapshot(streamingSnapshot("还在流"), false);

  assert.deepEqual(reader.read(), { tokens: 999, scopeKey: null });
  assert.deepEqual(calls, [null]);
});

test("没有快照或窗口没有行时读 0，作用域为空（不抛错）", () => {
  const reader = createLiveOutputTokenReader();

  assert.deepEqual(reader.read(), { tokens: 0, scopeKey: null });
  reader.setSnapshot(null, true);
  assert.deepEqual(reader.read(), { tokens: 0, scopeKey: null });
  reader.setSnapshot(
    { ...streamingSnapshot(""), rows: { window: [], totalCount: 0, firstRowId: null } },
    true,
  );
  assert.deepEqual(reader.read(), { tokens: 0, scopeKey: null });
  reader.setSnapshot({ ...streamingSnapshot(""), sessionId: "" }, true);
  assert.equal(reader.read().scopeKey, null);
});

test("作用域只在读取时访问窗口首末行，不扫描正文或中间行", () => {
  let windowReads = 0;
  const snapshot = streamingSnapshot("不应扫描");
  const first = snapshot.rows.window[0]!;
  const last = snapshot.rows.window[1]!;
  const window = new Proxy([first, first, last], {
    get(target, property, receiver) {
      assert.notEqual(property, "1");
      assert.notEqual(property, Symbol.iterator);
      return Reflect.get(target, property, receiver);
    },
  });
  const scopedSnapshot = {
    ...snapshot,
    rows: {
      get window() {
        windowReads += 1;
        return window;
      },
    },
  } as ConversationSnapshot;
  const reader = createLiveOutputTokenReader(() => 42);

  for (let frame = 0; frame < 60; frame += 1) reader.setSnapshot(scopedSnapshot, true);
  assert.equal(windowReads, 0);
  assert.deepEqual(reader.read(), { tokens: 42, scopeKey: INITIAL_SCOPE_KEY });
  assert.ok(windowReads > 0 && windowReads <= 2);
});

test("作用域跟随会话与窗口末行的轮变化，JSON 编码不混淆身份", () => {
  const reader = createLiveOutputTokenReader();
  const initial = streamingSnapshot("a".repeat(300));
  reader.setSnapshot(initial, true);
  const first = reader.read();

  const nextTurn = {
    ...initial,
    rows: {
      ...initial.rows,
      window: [
        ...initial.rows.window,
        {
          kind: "assistantText",
          state: "streaming",
          turnId: "turn-2",
          rowId: 3,
          text: "a".repeat(2700),
        },
      ],
    },
  } as ConversationSnapshot;
  reader.setSnapshot(nextTurn, true);
  const second = reader.read();
  assert.equal(second.scopeKey, JSON.stringify(["session-1", "turn-2", 1]));
  assert.ok(second.tokens > first.tokens);
  assert.notEqual(second.scopeKey, first.scopeKey);

  reader.setSnapshot({ ...nextTurn, sessionId: 'session","other' }, true);
  assert.deepEqual(reader.read(), {
    tokens: second.tokens,
    scopeKey: JSON.stringify(['session","other', "turn-2", 1]),
  });
});

for (const boundary of ["补历史", "裁切"] as const) {
  test(`窗口${boundary}后即使读数增长，也只建立新的采样基线`, () => {
    const reader = createLiveOutputTokenReader();
    const initial = streamingSnapshot("a".repeat(300));
    reader.setSnapshot(initial, true);
    const first = appendOutputSpeedSample([], { at: 1_000, ...reader.read() });

    const grown = streamingSnapshot("a".repeat(2700));
    const window =
      boundary === "补历史"
        ? [
            {
              kind: "assistantText",
              state: "complete",
              turnId: "turn-old",
              rowId: 0,
              text: "历史",
            },
            ...grown.rows.window,
          ]
        : grown.rows.window.slice(1);
    const changed = {
      ...grown,
      rows: { ...grown.rows, window },
    } as ConversationSnapshot;
    reader.setSnapshot(changed, true);
    const reading = reader.read();
    assert.ok(reading.tokens > first[0]!.tokens);
    assert.equal(
      reading.scopeKey,
      JSON.stringify(["session-1", "turn-1", boundary === "补历史" ? 0 : 2]),
    );
    const samples = appendOutputSpeedSample(first, { at: 2_000, ...reading });
    assert.deepEqual(samples, [{ at: 2_000, ...reading }]);
    assert.equal(resolveLiveOutputSpeed(samples), null);
  });
}

test("默认估算按当前轮累计：CJK 双倍权重，已完成的正文继续计入", () => {
  const reader = createLiveOutputTokenReader();
  const snapshot = streamingSnapshot("你好世界");
  reader.setSnapshot(snapshot, true);

  // 「已有内容」与「你好世界」共 8 个汉字 = 16 权重 ÷ ESTIMATED_TOKEN_CHAR_DIVISOR(3) 向上取整 = 6。
  assert.deepEqual(reader.read(), { tokens: 6, scopeKey: INITIAL_SCOPE_KEY });
  assert.equal(countTurnOutputTokens(snapshot), 6);
});

test("默认估算把工具入参算作输出，换轮后不串上一轮的读数", () => {
  const reader = createLiveOutputTokenReader();
  const withToolInput = {
    sessionId: "session-1",
    rows: {
      window: [
        { kind: "assistantText", state: "complete", turnId: "turn-1", rowId: 1, text: "先说明" },
        {
          kind: "toolCall",
          status: "inputStreaming",
          turnId: "turn-1",
          rowId: 2,
          inputText: '{"file_path":"a.ts","content":"'.repeat(10),
        },
      ],
    },
  } as unknown as ConversationSnapshot;
  reader.setSnapshot(withToolInput, true);
  assert.deepEqual(reader.read(), {
    tokens: countTurnOutputTokens(withToolInput),
    scopeKey: INITIAL_SCOPE_KEY,
  });
  assert.ok(reader.read().tokens > 0);

  // 新一轮只有用户输入：上一轮的累计读数不能串过来。
  const nextTurn = {
    sessionId: "session-1",
    rows: {
      window: [...withToolInput.rows.window, { kind: "userInput", turnId: "turn-2", rowId: 3 }],
    },
  } as unknown as ConversationSnapshot;
  reader.setSnapshot(nextTurn, true);
  assert.deepEqual(reader.read(), {
    tokens: 0,
    scopeKey: JSON.stringify(["session-1", "turn-2", 1]),
  });
});

test("带缓存的估算器与纯函数逐字一致（行增长、换轮、清空）", () => {
  const estimate = createTurnOutputTokenEstimator();
  const first = streamingSnapshot("a".repeat(30));
  assert.equal(estimate(first), countTurnOutputTokens(first));

  const grown = streamingSnapshot("a".repeat(30) + "中".repeat(30));
  assert.equal(estimate(grown), countTurnOutputTokens(grown));

  const nextTurn = {
    sessionId: "session-1",
    rows: {
      window: [
        { kind: "assistantText", state: "streaming", turnId: "turn-2", rowId: 9, text: "新的一轮" },
      ],
    },
  } as unknown as ConversationSnapshot;
  assert.equal(estimate(nextTurn), countTurnOutputTokens(nextTurn));

  // 非流式相位传 null：缓存清空，下一次估算重新起算。
  assert.equal(estimate(null), 0);
  const restarted = streamingSnapshot("重新开始");
  assert.equal(estimate(restarted), countTurnOutputTokens(restarted));
});

test("切会话、补历史与裁切窗口都重置按 rowId 缓存，即使文本长度相同", () => {
  const estimate = createTurnOutputTokenEstimator();
  const snapshot = {
    ...streamingSnapshot(""),
    rows: {
      window: [
        {
          kind: "assistantText",
          state: "streaming",
          turnId: "turn-1",
          rowId: 2,
          text: "a".repeat(30),
        },
      ],
    },
  } as ConversationSnapshot;
  assert.equal(estimate(snapshot), 10);

  const switched = {
    ...snapshot,
    sessionId: "session-2",
    rows: { window: [{ ...snapshot.rows.window[0]!, text: "中".repeat(30) }] },
  } as ConversationSnapshot;
  assert.equal(estimate(switched), 20);

  const expanded = {
    ...switched,
    rows: {
      window: [
        { kind: "assistantText", state: "complete", turnId: "turn-old", rowId: 0, text: "历史" },
        { ...snapshot.rows.window[0]!, text: "a".repeat(30) },
      ],
    },
  } as ConversationSnapshot;
  assert.equal(estimate(expanded), 10);
  assert.equal(estimate(switched), 20);
});
