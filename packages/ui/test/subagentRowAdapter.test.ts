import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentRow } from "@zcode/shared/zcode-protocol-v4";
import {
  getAgentKindLabel,
  getAgentPrimaryText,
} from "../src/ToolCallBlocks/renderers/agentHelpers.js";
import { subagentRowToAgentToolCallNode } from "../src/v4/subagentRowAdapter.js";

function subagentRow(overrides: Partial<SubagentRow> = {}): SubagentRow {
  return {
    kind: "subagent",
    rowId: 7,
    turnId: "turn-1",
    createdAt: 1_767_225_600_000,
    createdAtSeq: 1,
    subagentType: "frontend",
    status: "running",
    summaryText: "实现入口",
    ...overrides,
  };
}

test("四种投影状态映射到旧工具状态词表", () => {
  const cases: Array<[SubagentRow["status"], string]> = [
    ["running", "in_progress"],
    ["success", "completed"],
    ["failed", "failed"],
    ["cancelled", "stopped"],
  ];

  for (const [status, legacyStatus] of cases) {
    const node = subagentRowToAgentToolCallNode(subagentRow({ status }));
    assert.equal(node.toolCall.status, legacyStatus, status);
    // 合成节点不改写投影事实：raw.v4Status 仍是 subagent 行原值。
    assert.deepEqual(node.toolCall.raw, { inputPreviewComplete: true, v4Status: status });
  }
});

test("toolId 优先使用 childSessionId，缺失时回落到 rowId", () => {
  assert.equal(
    subagentRowToAgentToolCallNode(subagentRow({ childSessionId: "child-1" })).toolCall.toolId,
    "subagent:child-1",
  );
  assert.equal(
    subagentRowToAgentToolCallNode(subagentRow({ rowId: 42, childSessionId: undefined })).toolCall
      .toolId,
    "subagent:42",
  );
});

test("Agent 标题读取 input.description，subagent_type 同步投影类型", () => {
  const node = subagentRowToAgentToolCallNode(
    subagentRow({ summaryText: "实现入口", subagentType: "reviewer" }),
  );

  assert.deepEqual(node.toolCall.input, {
    description: "实现入口",
    subagent_type: "reviewer",
  });
  assert.equal(node.toolCall.toolName, "Agent");
  assert.equal(node.toolCall.kind, "Agent");
  assert.equal(getAgentPrimaryText(node.toolCall, ""), "实现入口");
  // 角色名与手动 Agent 行同一解析器：authoritativeAgentType 优先于 input.subagent_type。
  assert.equal(getAgentKindLabel(node.toolCall, "", "reviewer"), "reviewer");
  assert.equal(getAgentKindLabel(node.toolCall, ""), "reviewer");
});

test("summaryText 为空时标题回落到 subagent_type", () => {
  const node = subagentRowToAgentToolCallNode(subagentRow({ summaryText: "   " }));

  assert.equal(getAgentPrimaryText(node.toolCall, ""), "frontend");
});

test("startedAt 只在投影给出时透传", () => {
  const started = subagentRowToAgentToolCallNode(subagentRow({ startedAt: 1_767_225_610_000 }));
  assert.equal(started.toolCall.startedAt, 1_767_225_610_000);

  const missing = subagentRowToAgentToolCallNode(subagentRow());
  assert.equal("startedAt" in missing.toolCall, false);
});

test("childToolCalls 为空，且不伪造 output/content/error/display", () => {
  const node = subagentRowToAgentToolCallNode(
    subagentRow({ status: "failed", summaryText: "失败步骤", endedAt: 1_767_225_660_000 }),
  );

  assert.deepEqual(node.childToolCalls, []);
  assert.equal("output" in node.toolCall, false);
  assert.equal("content" in node.toolCall, false);
  assert.equal("error" in node.toolCall, false);
  assert.equal("display" in node.toolCall, false);
  assert.equal("snapshotRefs" in node.toolCall, false);
});
