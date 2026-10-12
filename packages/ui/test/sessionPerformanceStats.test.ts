import assert from "node:assert/strict";
import test from "node:test";
import {
  countWideChars,
  estimateOutputTokensFromCharCounts,
} from "../../shared/src/session-performance.js";
import { resolveLiveOutputSpeed } from "../src/v4/composer/liveOutputSpeed.js";
import {
  canRenderSessionStatsEntry,
  resolveSessionStatsSpeeds,
} from "../src/v4/composer/sessionStatsSpeeds.js";
import { countStreamingOutputTokens } from "../src/v4/composer/streamingOutputTokens.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

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

test("面板把平均速度与当前速度分成两个口径，入口取当前值优先", () => {
  // 运行中：平均是持久层累计、当前是流式估算，两者不同是预期（口径不同，不做换算）。
  assert.deepEqual(resolveSessionStatsSpeeds({ tokensPerSecond: 138 }, 158), {
    average: 138,
    current: 158,
    trigger: 158,
  });
  // 停下来的那一秒没有实时值：入口回落到累计平均，面板「当前输出速度」行留空显示 --。
  assert.deepEqual(resolveSessionStatsSpeeds({ tokensPerSecond: 138 }, null), {
    average: 138,
    current: null,
    trigger: 138,
  });
  // 缺计量的会话：两个口径都为空，入口因此不渲染。
  assert.deepEqual(resolveSessionStatsSpeeds({ tokensPerSecond: null }, null), {
    average: null,
    current: null,
    trigger: null,
  });
  assert.deepEqual(resolveSessionStatsSpeeds(null, null), {
    average: null,
    current: null,
    trigger: null,
  });
});

test("入口只在有会话且拿得到事实时渲染", () => {
  const noSummary = {
    sessionId: "s1",
    summary: null,
    speeds: resolveSessionStatsSpeeds(null, null),
  };
  // 草稿会话/保留期外会话：没有任何记录也没有实时值 → 不渲染。
  assert.equal(canRenderSessionStatsEntry(noSummary), false);
  assert.equal(
    canRenderSessionStatsEntry({
      sessionId: "s1",
      summary: { modelRequestCount: 0, toolCallCount: 0, tokensPerSecond: null },
      speeds: resolveSessionStatsSpeeds({ tokensPerSecond: null }, null),
    }),
    false,
  );
  // 没有 sessionId 一律不渲染，哪怕已有记录。
  assert.equal(
    canRenderSessionStatsEntry({
      sessionId: null,
      summary: { modelRequestCount: 3, toolCallCount: 0, tokensPerSecond: 120 },
      speeds: resolveSessionStatsSpeeds({ tokensPerSecond: 120 }, null),
    }),
    false,
  );
  // 只有工具没有主链请求：速度算不出来也要渲染，否则时长行没有入口可看（spec 场景 5）。
  assert.equal(
    canRenderSessionStatsEntry({
      sessionId: "s1",
      summary: { modelRequestCount: 0, toolCallCount: 4, tokensPerSecond: null },
      speeds: resolveSessionStatsSpeeds({ tokensPerSecond: null }, null),
    }),
    true,
  );
  // 有记录且速度可算：渲染。
  assert.equal(
    canRenderSessionStatsEntry({
      sessionId: "s1",
      summary: { modelRequestCount: 2, toolCallCount: 0, tokensPerSecond: 138 },
      speeds: resolveSessionStatsSpeeds({ tokensPerSecond: 138 }, 158),
    }),
    true,
  );
});

test("0 tok/s 是合法读数，不当成缺计量", () => {
  // 请求全都没产出 token 时累计 TPS 真的是 0：要显示 0，入口也因此渲染。
  const speeds = resolveSessionStatsSpeeds({ tokensPerSecond: 0 }, null);
  assert.deepEqual(speeds, { average: 0, current: null, trigger: 0 });
  assert.equal(
    canRenderSessionStatsEntry({
      sessionId: "s1",
      summary: { modelRequestCount: 2, toolCallCount: 0, tokensPerSecond: 0 },
      speeds,
    }),
    true,
  );
});

test("平均与当前两个速度文案在两种 locale 下都在，旧口径键不残留", () => {
  for (const locale of [zhCN, enUS]) {
    assert.equal(typeof locale["chat.sessionStats.averageSpeed"], "string");
    assert.equal(typeof locale["chat.sessionStats.currentSpeed"], "string");
    // 旧键留着会让人以为还存在第三个口径。
    assert.equal("chat.sessionStats.outputSpeed" in locale, false);
    // 入口按钮空闲时显示累计平均，aria-label 不能只说自己代表「当前」。
    assert.equal(locale["chat.sessionStats.triggerAriaLabel"].includes("当前"), false);
  }
});
