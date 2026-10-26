import assert from "node:assert/strict";
import test from "node:test";
import {
  countWideChars,
  estimateOutputTokensFromCharCounts,
} from "../../shared/src/session-performance.js";
import {
  appendOutputSpeedSample,
  resolveLiveOutputSpeed,
} from "../src/v4/composer/liveOutputSpeed.js";
import {
  canRenderSessionStatsEntry,
  resolveSessionStatsSpeeds,
} from "../src/v4/composer/sessionStatsSpeeds.js";
import { countTurnOutputTokens } from "../src/v4/composer/streamingOutputTokens.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

type StatsSnapshot = Parameters<typeof countTurnOutputTokens>[0];

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

test("实时 token 读数按当前轮累计：正文、思考与工具入参都算输出", () => {
  // 旧口径只数 state="streaming" 的行，换段（思考→正文→工具入参）读数会瞬间掉回 0；
  // 现在同一轮内已完成的行继续计入，跨轮（末行 turnId 变化）才归零。
  const tokens = countTurnOutputTokens(
    snapshotWithRows([
      { kind: "assistantText", state: "complete", turnId: "turn-1", text: "x".repeat(300) },
      { kind: "assistantText", state: "complete", turnId: "turn-2", text: "x".repeat(30) },
      { kind: "reasoning", state: "complete", turnId: "turn-2", text: "中".repeat(30) },
      { kind: "toolCall", status: "running", turnId: "turn-2", inputText: "y".repeat(30) },
      { kind: "toolCall", status: "inputStreaming", turnId: "turn-2", inputText: "z".repeat(30) },
      { kind: "toolCall", status: "success", turnId: "turn-2", inputText: "w".repeat(30) },
      { kind: "timelineMarker", turnId: "turn-2", marker: { type: "x" } },
    ]),
  );
  // 30 个汉字权重 60 + 120 个 ASCII，合计 180 ÷ 3 = 60。
  assert.equal(tokens, 60);
  assert.equal(countTurnOutputTokens(null), 0);
});

test("当前轮还没有输出时读数为 0，上一轮的输出不会串到新一轮", () => {
  assert.equal(
    countTurnOutputTokens(
      snapshotWithRows([
        { kind: "assistantText", state: "complete", turnId: "turn-1", text: "x".repeat(300) },
        { kind: "userInput", turnId: "turn-2", text: "继续" },
      ]),
    ),
    0,
  );
  // 空窗口同样没有可读的当前轮。
  assert.equal(countTurnOutputTokens(snapshotWithRows([])), 0);
});

test("只有工具调用、没有正文的轮也能读出工具入参的产出", () => {
  const tokens = countTurnOutputTokens(
    snapshotWithRows([
      { kind: "toolCall", status: "inputStreaming", turnId: "turn-1", inputText: "a".repeat(120) },
    ]),
  );
  assert.equal(tokens, 40);
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
  // 读数没有增长（工具执行/等待首 token，没有新输出）：不给当前速度，面板显示 --。
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

test("采样窗：读数没涨保留现有窗口，读数为 0 或回落时重开", () => {
  const first = appendOutputSpeedSample([], { at: 1_000, tokens: 100 });
  assert.deepEqual(first, [{ at: 1_000, tokens: 100 }]);
  // 同一 tick 只留一个样本。
  assert.deepEqual(appendOutputSpeedSample(first, { at: 1_000, tokens: 120 }), [
    { at: 1_000, tokens: 120 },
  ]);
  // 读数不涨只是暂停输出：窗口继续滚动，速度由 resolveLiveOutputSpeed 判空。
  assert.deepEqual(appendOutputSpeedSample(first, { at: 2_000, tokens: 100 }), [
    { at: 1_000, tokens: 100 },
    { at: 2_000, tokens: 100 },
  ]);
  // 超出 3 秒窗口的旧样本被挤掉。
  assert.deepEqual(appendOutputSpeedSample(first, { at: 4_100, tokens: 200 }), [
    { at: 4_100, tokens: 200 },
  ]);
  // 读数为 0（这一轮还没吐字/刚结束）：清空，入口回落到平均。
  assert.deepEqual(appendOutputSpeedSample(first, { at: 2_000, tokens: 0 }), []);
  // 读数回落（换轮或重连后基线归零）：旧样本不可比，整窗丢弃重开。
  assert.deepEqual(appendOutputSpeedSample(first, { at: 2_000, tokens: 40 }), [
    { at: 2_000, tokens: 40 },
  ]);
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
