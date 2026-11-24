import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { collectTerminalTaskNotificationPayloads } from "./taskNotificationOrchestrator.js";

const formatMessage = ((descriptor: { id: string }) => descriptor.id) as unknown as Parameters<
  typeof collectTerminalTaskNotificationPayloads
>[0]["formatMessage"];

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "session-1",
    workspaceId: "workspace-1",
    title: "编排任务",
    phase: "completedSuccess",
    sessionEnded: true,
    hasBackgroundWork: false,
    lastActivityAt: 1,
    createdAt: 0,
    ...overrides,
  };
}

function collect(previous: SessionSummary, next: SessionSummary) {
  return collectTerminalTaskNotificationPayloads({
    previousBySessionId: new Map([[previous.sessionId, previous]]),
    sessions: [next],
    formatMessage,
  });
}

const ORCHESTRATION_ACTIVE = {
  activeRunCount: 1,
  runningStepCount: 1,
  completedStepCount: 0,
  totalStepCount: 3,
  startedAt: 100,
};

test("编排 run 仍在跑时，主轮收口不弹完成通知", () => {
  const payloads = collect(
    summary({ phase: "running" }),
    summary({ phase: "completedSuccess", orchestrationActivity: ORCHESTRATION_ACTIVE }),
  );
  assert.equal(payloads.length, 0);
});

test("失败通知不受编排活动影响，仍立即发出", () => {
  const payloads = collect(
    summary({ phase: "running" }),
    summary({ phase: "error", sessionEnded: false, orchestrationActivity: ORCHESTRATION_ACTIVE }),
  );
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "failed");
});

test("编排 run 收尾轮再次收口时只弹一次完成通知", () => {
  const withRun = summary({
    phase: "completedSuccess",
    orchestrationActivity: ORCHESTRATION_ACTIVE,
  });
  // run 结束后 activity 离位，但 phase 没有新的终态边沿：不能在这里补弹。
  const settled = summary({ phase: "completedSuccess" });
  assert.deepEqual(collect(summary({ phase: "running" }), withRun), []);
  assert.deepEqual(collect(withRun, settled), []);

  // 唤醒的收尾轮：running → completedSuccess，activity 已离位 → 唯一一次完成通知。
  assert.deepEqual(collect(settled, summary({ phase: "running" })), []);
  const payloads = collect(summary({ phase: "running" }), settled);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "completed");
});

test("旧 CLI 缺省 orchestrationActivity 时保持原有完成判定", () => {
  const payloads = collect(summary({ phase: "running" }), summary({ phase: "completedSuccess" }));
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0]?.status, "completed");
});
