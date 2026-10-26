import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { createLiveOutputTokenReader } from "../src/v4/composer/liveOutputTokens.js";
import {
  countTurnOutputTokens,
  createTurnOutputTokenEstimator,
} from "../src/v4/composer/streamingOutputTokens.js";

function streamingSnapshot(text: string): ConversationSnapshot {
  return {
    rows: {
      window: [
        { kind: "assistantText", state: "complete", turnId: "turn-1", rowId: 1, text: "已有内容" },
        { kind: "assistantText", state: "streaming", turnId: "turn-1", rowId: 2, text },
      ],
    },
  } as unknown as ConversationSnapshot;
}

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
  assert.equal(reader.read(), 42);
  assert.equal(reader.read(), 42);
  assert.equal(calls.length, 2);
});

test("读到的永远是最新挂上的那一帧快照", () => {
  const reader = createLiveOutputTokenReader();
  const first = streamingSnapshot("甲".repeat(90));
  const second = streamingSnapshot("乙".repeat(300));

  reader.setSnapshot(first, true);
  assert.equal(reader.read(), countTurnOutputTokens(first));

  reader.setSnapshot(second, true);
  assert.equal(reader.read(), countTurnOutputTokens(second));
  assert.ok(reader.read() > 0);
});

test("非流式相位读 0，且不把快照交给估算（草稿、已结束、被停止）", () => {
  const calls: Array<ConversationSnapshot | null> = [];
  const reader = createLiveOutputTokenReader((snapshot) => {
    calls.push(snapshot);
    return 999;
  });

  reader.setSnapshot(streamingSnapshot("还在流"), true);
  // 相位一变非流式就整段归零：旧实现写的是 0，读数不能沿用上一轮的速度。
  reader.setSnapshot(streamingSnapshot("还在流"), false);

  assert.equal(reader.read(), 999);
  assert.deepEqual(calls, [null]);
});

test("没有挂过快照时读 0（不抛错）", () => {
  const reader = createLiveOutputTokenReader();

  assert.equal(reader.read(), 0);
});

test("默认估算按当前轮累计：CJK 双倍权重，已完成的正文继续计入", () => {
  const reader = createLiveOutputTokenReader();
  const snapshot = streamingSnapshot("你好世界");
  reader.setSnapshot(snapshot, true);

  // 「已有内容」与「你好世界」共 8 个汉字 = 16 权重 ÷ ESTIMATED_TOKEN_CHAR_DIVISOR(3) 向上取整 = 6。
  assert.equal(reader.read(), 6);
  assert.equal(countTurnOutputTokens(snapshot), 6);
});

test("默认估算把工具入参算作输出，换轮后不串上一轮的读数", () => {
  const reader = createLiveOutputTokenReader();
  const withToolInput = {
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
  assert.equal(reader.read(), countTurnOutputTokens(withToolInput));
  assert.ok(reader.read() > 0);

  // 新一轮只有用户输入：上一轮的累计读数不能串过来。
  const nextTurn = {
    rows: {
      window: [...withToolInput.rows.window, { kind: "userInput", turnId: "turn-2", rowId: 3 }],
    },
  } as unknown as ConversationSnapshot;
  reader.setSnapshot(nextTurn, true);
  assert.equal(reader.read(), 0);
});

test("带缓存的估算器与纯函数逐字一致（行增长、换轮、清空）", () => {
  const estimate = createTurnOutputTokenEstimator();
  const first = streamingSnapshot("a".repeat(30));
  assert.equal(estimate(first), countTurnOutputTokens(first));

  const grown = streamingSnapshot("a".repeat(30) + "中".repeat(30));
  assert.equal(estimate(grown), countTurnOutputTokens(grown));

  const nextTurn = {
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
