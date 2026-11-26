import assert from "node:assert/strict";
import test from "node:test";
import type {
  BackgroundWorkSummary,
  RunningSubagentSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { buildConversationStatusPanelModel } from "../src/v4/conversationStatusPanelModel.js";

/**
 * 运行中子智能体的 Stop 句柄（specs/status-panel-subagent-stop.md）。
 *
 * 目录投影接管 Agent 展示后，行来自 `snapshot.subagents.running[]`；编排调度与其它
 * 直接进入 subagent port 的启动没有 BackgroundTaskStarted，backgroundWorks 里没有 work。
 * 模型必须回退到行自己的 `agentId`（≡ cancelBackgroundWork 的 workId），否则这些行在跑
 * 却没有停止入口。后台 work 精确匹配仍然优先；身份不全时不猜。
 */

function subagent(overrides: Partial<RunningSubagentSummary> = {}): RunningSubagentSummary {
  return {
    childSessionId: "child-1",
    agentId: "agent-1",
    subagentType: "general-purpose",
    title: "落地元数据契约",
    status: "running",
    startedAt: 1_767_225_600_000,
    ...overrides,
  };
}

function work(overrides: Partial<BackgroundWorkSummary> = {}): BackgroundWorkSummary {
  return {
    workId: "work-1",
    kind: "subagent",
    title: "落地元数据契约",
    status: "running",
    startedAt: 1_767_225_600_000,
    anchorRowId: null,
    childSessionId: "child-1",
    ...overrides,
  };
}

function modelWith(input: {
  backgroundWorks?: readonly BackgroundWorkSummary[];
  runningSubagents?: readonly RunningSubagentSummary[];
}) {
  return buildConversationStatusPanelModel({
    workspacePath: "/workspace",
    ...input,
  });
}

test("没有后台 work 时回退到行自己的 agentId 作为停止句柄", () => {
  const model = modelWith({ runningSubagents: [subagent()] });

  assert.deepEqual(
    model.runningSubagentWorks.map((item) => [item.controlWorkId, item.cancellable]),
    [["agent-1", true]],
  );
});

test("后台 work 按 childSessionId 精确匹配时优先后台 workId", () => {
  const model = modelWith({
    runningSubagents: [subagent({ agentId: "agent-1" })],
    backgroundWorks: [work({ workId: "work-1" })],
  });

  assert.equal(model.runningSubagentWorks[0]?.controlWorkId, "work-1");
});

test("work 明确不可停时不显示 Stop，但回退身份仍按缺省可停", () => {
  const blocked = modelWith({
    runningSubagents: [subagent()],
    backgroundWorks: [work({ cancellable: false })],
  });
  assert.equal(blocked.runningSubagentWorks[0]?.controlWorkId, "work-1");
  assert.equal(blocked.runningSubagentWorks[0]?.cancellable, false);

  const fallback = modelWith({ runningSubagents: [subagent()] });
  assert.equal(fallback.runningSubagentWorks[0]?.cancellable, true);
});

test("同一 childSessionId 的多条 work 仍拒绝猜测，行自身的 agentId 照常可停", () => {
  const model = modelWith({
    runningSubagents: [subagent({ agentId: "agent-1" })],
    backgroundWorks: [
      work({ workId: "work-a", childSessionId: "child-1" }),
      work({ workId: "work-b", childSessionId: "child-1" }),
    ],
  });

  assert.equal(model.runningSubagentWorks[0]?.controlWorkId, "agent-1");
  assert.equal(model.runningSubagentWorks[0]?.cancellable, true);
});

test("没有 agentId 也没有匹配 work 时不给按钮，按标题或时间猜身份更糟", () => {
  const model = modelWith({
    runningSubagents: [subagent({ agentId: undefined })],
    backgroundWorks: [work({ childSessionId: "other-child" })],
  });

  assert.equal(model.runningSubagentWorks[0]?.controlWorkId, undefined);
});

test("后台 work 有、目录投影暂时缺行时仍补出可停的控制行", () => {
  const model = modelWith({ backgroundWorks: [work({ workId: "work-1" })] });

  assert.equal(model.runningSubagentWorks.length, 1);
  assert.equal(model.runningSubagentWorks[0]?.controlWorkId, "work-1");
  assert.equal(model.runningSubagentWorks[0]?.agentId, "work-1");
});
