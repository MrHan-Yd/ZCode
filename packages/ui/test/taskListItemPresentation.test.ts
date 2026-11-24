import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { deriveTaskLeadingIndicator } from "@/lib/taskListItemPresentation.js";
import type { TaskListRowActivity } from "@/v4/taskListRowActivity.js";

const TASK = {
  taskId: "session-1",
  traceId: "trace-1",
  title: "编排任务",
  workspacePath: "/workspace",
  createdAt: 0,
  updatedAt: 1,
  mode: "build",
} as ZCodeTaskMeta;

function activity(overrides: Partial<TaskListRowActivity> = {}): TaskListRowActivity {
  return {
    phase: "completedSuccess",
    lastActivityAt: 1,
    hasBackgroundWork: false,
    ...overrides,
  };
}

const ORCHESTRATION_ACTIVE = {
  activeRunCount: 1,
  runningStepCount: 2,
  completedStepCount: 1,
  totalStepCount: 3,
  startedAt: 1,
};

test("编排 run 活动期间侧栏显示运行中，且优先于未读蓝点", () => {
  assert.equal(
    deriveTaskLeadingIndicator(
      { ...TASK, unreadAt: 2 },
      activity({ orchestrationActivity: ORCHESTRATION_ACTIVE }),
    ),
    "loading",
  );
});

test("经典会话保持未读优先于运行中的既有次序", () => {
  assert.equal(
    deriveTaskLeadingIndicator({ ...TASK, unreadAt: 2 }, activity({ phase: "running" })),
    "unread",
  );
  assert.equal(deriveTaskLeadingIndicator(TASK, activity({ phase: "running" })), "loading");
});

test("错误状态仍高于编排活动", () => {
  assert.equal(
    deriveTaskLeadingIndicator(
      TASK,
      activity({ phase: "error", orchestrationActivity: ORCHESTRATION_ACTIVE }),
    ),
    "error",
  );
});

test("没有活动编排 run 时回到原判定", () => {
  assert.equal(deriveTaskLeadingIndicator(TASK, activity()), "none");
});
