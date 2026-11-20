import assert from "node:assert/strict";
import test from "node:test";
import type { OrchestrationRunProjection } from "@zcode/shared/zcode-protocol-v4";
import { buildConversationStatusPanelModel } from "../src/v4/conversationStatusPanelModel.js";

function makeRun(overrides: Partial<OrchestrationRunProjection> = {}): OrchestrationRunProjection {
  return {
    runId: "run-1",
    planId: "plan-1",
    revision: 0,
    generation: 1,
    status: "running",
    team: ["general-purpose", "Explore", "reviewer"],
    maxConcurrency: 3,
    startedAt: 1_767_225_600_000,
    updatedAt: 1_767_225_660_000,
    active: true,
    steps: [
      {
        stepId: "spec",
        title: "更新 spec",
        role: "general-purpose",
        status: "completed",
        dependsOn: [],
        attempts: 1,
        startedAt: 1_767_225_600_000,
        endedAt: 1_767_225_630_000,
      },
      {
        stepId: "review",
        title: "审查实现",
        role: "reviewer",
        status: "running",
        dependsOn: ["spec"],
        attempts: 1,
        startedAt: 1_767_225_630_000,
      },
      {
        stepId: "verify",
        title: "回归验证",
        role: "tester",
        status: "pending",
        dependsOn: ["review", "spec"],
        attempts: 0,
      },
    ],
    ...overrides,
  };
}

test("计划分区只收活动 run，并给出完成 / 运行 / 总数", () => {
  const model = buildConversationStatusPanelModel({
    workspacePath: "/workspace",
    orchestrationRuns: [
      makeRun(),
      makeRun({ runId: "run-ended", status: "completed", active: false }),
    ],
  });

  assert.equal(model.activeOrchestrationRuns.length, 1);
  const [entry] = model.activeOrchestrationRuns;
  assert.equal(entry?.run.runId, "run-1");
  assert.equal(entry?.completedCount, 1);
  assert.equal(entry?.runningCount, 1);
  assert.equal(entry?.totalCount, 3);
  assert.equal(model.hasContent, true);
});

test("没有活动 run 时计划分区为空且不单独撑开面板", () => {
  const model = buildConversationStatusPanelModel({
    workspacePath: "/workspace",
    orchestrationRuns: [makeRun({ status: "cancelled", active: false })],
  });

  assert.deepEqual(model.activeOrchestrationRuns, []);
  assert.equal(model.hasContent, false);
});

test("步骤顺序保持投影原序，不按状态重排", () => {
  const model = buildConversationStatusPanelModel({
    workspacePath: "/workspace",
    orchestrationRuns: [makeRun()],
  });

  assert.deepEqual(
    model.activeOrchestrationRuns[0]?.run.steps.map((step) => step.stepId),
    ["spec", "review", "verify"],
  );
});

test("hasStatusContent 只表达会话状态内容，Git 可见只进入 hasContent", () => {
  // 右下状态卡片只看 hasStatusContent：只有 Git 内容时它必须缺席。
  const gitOnly = buildConversationStatusPanelModel({
    workspacePath: "/workspace",
    hasGitTools: true,
  });
  assert.equal(gitOnly.hasStatusContent, false);
  assert.equal(gitOnly.hasContent, true);

  const statusOnly = buildConversationStatusPanelModel({
    workspacePath: "/workspace",
    orchestrationRuns: [makeRun()],
  });
  assert.equal(statusOnly.hasStatusContent, true);
  assert.equal(statusOnly.hasContent, true);
});
