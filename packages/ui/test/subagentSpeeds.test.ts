import assert from "node:assert/strict";
import test from "node:test";
import type { SessionPerformanceSnapshot } from "@zcode/shared";
import { SESSION_PERFORMANCE_MAX_SESSIONS } from "@zcode/shared";
import {
  resolveLongestRunningSubagent,
  resolveSubagentSpeedPollIds,
  resolveSubagentSpeedReadings,
} from "../src/v4/subagentSpeeds.js";

function entry(sessionId: string, tokensPerSecond: number | null): SessionPerformanceSnapshot {
  return {
    sessionId,
    summary: {
      modelMs: 1_000,
      toolMs: 0,
      averageTtftMs: null,
      tokensPerSecond,
      modelRequestCount: tokensPerSecond === null ? 0 : 1,
      toolCallCount: 0,
    },
  };
}

test("速度只按 childSessionId 归位：null 不产出读数，0 是合法读数", () => {
  const readings = resolveSubagentSpeedReadings(
    [entry("child-a", 201.4), entry("child-b", null), entry("child-c", 0)],
    ["child-a", "child-b", "child-c"],
  );

  assert.equal(readings.get("child-a"), 201.4);
  // null = 还没有已完成请求 / 计量缺失 / 超出保留期 → 行上不显示数字（0 会被读成"卡住了"）。
  assert.equal(readings.has("child-b"), false);
  // 0 是真实读数：请求完成了、但没产出 token。显示 0 而不是 --。
  assert.equal(readings.get("child-c"), 0);
});

test("不在本次请求集合里的会话不产出读数：晚到的上一次响应不能落到新面板上", () => {
  const readings = resolveSubagentSpeedReadings(
    [entry("child-a", 120), entry("child-finished", 999)],
    ["child-a"],
  );

  assert.equal(readings.size, 1);
  assert.equal(readings.has("child-finished"), false);
});

test("没有读数时返回空表而不是抛错", () => {
  assert.equal(resolveSubagentSpeedReadings(null, ["child-a"]).size, 0);
  assert.equal(resolveSubagentSpeedReadings([], ["child-a"]).size, 0);
});

test("收起态取运行最久的那个：与同一处显示的时长指向同一个子智能体", () => {
  const subagents = [
    { childSessionId: "newer", startedAt: 2_000 },
    { childSessionId: "oldest", startedAt: 1_000 },
    { childSessionId: "middle", startedAt: 1_500 },
  ];

  assert.equal(resolveLongestRunningSubagent(subagents, 10_000)?.childSessionId, "oldest");
});

test("全部缺 startedAt 时回落成第一个：时长是 1 秒兜底，读数仍指向同一行", () => {
  const subagents = [{ childSessionId: "a" }, { childSessionId: "b" }];

  assert.equal(resolveLongestRunningSubagent(subagents, 10_000)?.childSessionId, "a");
  assert.equal(resolveLongestRunningSubagent([], 10_000), null);
});

test("轮询 id 去重、保持调用方顺序，并按 wire 上限截断", () => {
  const ids = Array.from({ length: SESSION_PERFORMANCE_MAX_SESSIONS + 5 }, (_, i) => `child-${i}`);

  const pollIds = resolveSubagentSpeedPollIds(["child-1", "child-0", "child-1", ...ids]);

  assert.equal(pollIds[0], "child-1");
  assert.equal(pollIds[1], "child-0");
  assert.equal(pollIds.length, SESSION_PERFORMANCE_MAX_SESSIONS);
  // 截断保留的是最前面（即运行最久）的那些，不会漏掉收起态读的那一个。
  assert.equal(new Set(pollIds).size, pollIds.length);
});
