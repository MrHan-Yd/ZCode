import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { createLiveOutputTokenReader } from "../src/v4/composer/liveOutputTokens.js";
import { countStreamingOutputTokens } from "../src/v4/composer/streamingOutputTokens.js";

function streamingSnapshot(text: string): ConversationSnapshot {
  return {
    rows: {
      window: [
        { kind: "assistantText", state: "settled", rowId: 1, text: "已有内容" },
        { kind: "assistantText", state: "streaming", rowId: 2, text },
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
  assert.equal(reader.read(), countStreamingOutputTokens(first));

  reader.setSnapshot(second, true);
  assert.equal(reader.read(), countStreamingOutputTokens(second));
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

test("默认估算与流式口径同一份实现：CJK 按双倍权重的字符折算", () => {
  const reader = createLiveOutputTokenReader();
  const snapshot = streamingSnapshot("你好世界");
  reader.setSnapshot(snapshot, true);

  // 4 个汉字 = 8 权重 ÷ ESTIMATED_TOKEN_CHAR_DIVISOR(3) 向上取整 = 3。
  assert.equal(reader.read(), 3);
  assert.equal(countStreamingOutputTokens(snapshot), 3);
});
