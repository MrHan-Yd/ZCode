import assert from "node:assert/strict";
import test from "node:test";
import {
  countWideChars,
  estimateOutputTokensFromCharCounts,
} from "../../shared/src/session-performance.js";
import { resolveLiveOutputSpeed } from "../src/v4/composer/liveOutputSpeed.js";
import { countStreamingOutputTokens } from "../src/v4/composer/streamingOutputTokens.js";

type StatsSnapshot = Parameters<typeof countStreamingOutputTokens>[0];

/** 与生产用法同一对入参：字符总数 + 其中的 CJK 字符数。 */
function estimateTokens(text: string): number {
  return estimateOutputTokensFromCharCounts(text.length, countWideChars(text));
}

function snapshotWithRows(rows: unknown[]): StatsSnapshot {
  return {
    rows: { window: rows, totalCount: rows.length, firstRowId: 0 },
  } as StatsSnapshot;
}

test("流式 token 估算按 CJK 双倍权重折算，与 CLI 侧 estimateTokens 同口径", () => {
  assert.equal(estimateTokens(""), 0);
  // 纯 ASCII 走 1/3：4 字符 → ceil(4/3) = 2。
  assert.equal(estimateTokens("abcd"), 2);
  assert.equal(countWideChars("中文"), 2);
  // 30 个中文 → (30*2)/3 = 20；同样长度的 ASCII → 30/3 = 10。
  // 不算权重的话中文回答的实时速度会被低估一半。
  assert.equal(estimateTokens("中".repeat(30)), 20);
  assert.equal(estimateTokens("a".repeat(30)), 10);
});

test("实时 token 读数只统计流式态的输出行", () => {
  // 完成的正文、非输出行（工具调用）都不算输出；正文与思考都算。
  const tokens = countStreamingOutputTokens(
    snapshotWithRows([
      { kind: "assistantText", state: "complete", text: "x".repeat(300) },
      { kind: "toolCall", state: "running", text: "x".repeat(300) },
      { kind: "assistantText", state: "streaming", text: "x".repeat(30) },
      { kind: "reasoning", state: "streaming", text: "x".repeat(30) },
    ]),
  );
  assert.equal(tokens, 20);
  assert.equal(countStreamingOutputTokens(null), 0);
  assert.equal(
    countStreamingOutputTokens(
      snapshotWithRows([{ kind: "toolCall", state: "running", text: "ab" }]),
    ),
    0,
  );
});

test("观测窗口不足或读数没涨时不给实时速度", () => {
  assert.equal(resolveLiveOutputSpeed([]), null);
  assert.equal(resolveLiveOutputSpeed([{ at: 0, tokens: 100 }]), null);
  // 窗口短于最小跨度：首帧算出来的速度会高得离谱，宁可不出数值。
  assert.equal(
    resolveLiveOutputSpeed([
      { at: 1_000, tokens: 10 },
      { at: 1_200, tokens: 40 },
    ]),
    null,
  );
  // 读数没有增长（工具调用期间没有输出）：沿用上一个显示值。
  assert.equal(
    resolveLiveOutputSpeed([
      { at: 0, tokens: 100 },
      { at: 2_000, tokens: 100 },
    ]),
    null,
  );
});

test("实时速度取窗口两端读数差除以跨度", () => {
  assert.equal(
    resolveLiveOutputSpeed([
      { at: 0, tokens: 10 },
      { at: 1_000, tokens: 110 },
      { at: 2_000, tokens: 210 },
    ]),
    100,
  );
  // 中文权重会让同一段时长内的估算 token 数翻倍，速度读数同步变高。
  assert.equal(
    resolveLiveOutputSpeed([
      { at: 0, tokens: 0 },
      { at: 4_000, tokens: 800 },
    ]),
    200,
  );
});
