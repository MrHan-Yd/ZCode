import assert from "node:assert/strict";
import test from "node:test";
import {
  createMessageId,
  createTraceId,
  type ModelToolContract,
} from "@zcode/contracts";
import {
  zcodeSessionContextUsageSchema,
  zcodeSessionRuntimeStateSchema,
} from "@zcode/shared";
import { sessionUsageStateSchema } from "@zcode/shared/zcode-protocol-v4";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type {
  ContextUsageCategory,
  ContextUsageToolDetail,
  RunModelTextRequestOptions,
} from "../src/runtime/types.js";
import type { ContextUsageCategoryBreakdown } from "../src/runtime/helpers/context-usage-breakdown.js";
import {
  buildContextUsageBreakdownFromSnapshot,
  buildContextUsageCategory,
  buildContextUsageSnapshot,
  buildMessageRoleBreakdown,
  buildSkillUsageDetails,
  buildToolUsageDetail,
  estimatedMetric,
  estimatedMetricFromKnown,
  sumMetrics,
} from "../src/runtime/methods/context-usage.js";
import { compactContextUsageSnapshot } from "../src/runtime/methods/context-usage-log-compact.js";
import { permissionTestModel, completedModelResponse } from "./upstreamRuntimePermissionFixtures.js";

function contextRuntime(): AgentRuntimeInternal {
  return {
    buildContextUsageCategory,
    buildMessageRoleBreakdown,
    buildSkillUsageDetails,
    buildToolUsageDetail,
    estimatedMetric,
    estimatedMetricFromKnown,
    sumMetrics,
  } as unknown as AgentRuntimeInternal;
}

function modelTool(name: string, description = `${name} fixture contract`): ModelToolContract {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
    sideEffectScope: "none",
  };
}

function request(tools: ModelToolContract[]): RunModelTextRequestOptions {
  return {
    assistantMessageId: createMessageId(),
    events: [],
    messages: [{ role: "user", content: "Synthetic parent request" }],
    model: permissionTestModel(() => completedModelResponse()),
    tools,
    traceContext: { traceId: createTraceId() },
  };
}

function readSnapshot(runtime: AgentRuntimeInternal, tools: ModelToolContract[]) {
  const value = buildContextUsageSnapshot.call(runtime, request(tools));
  return {
    raw: value,
    categories: value.categories as ContextUsageCategory[],
    categoryBreakdown: value.categoryBreakdown as ContextUsageCategoryBreakdown[],
    systemTools: value.systemTools as ContextUsageToolDetail[],
    subagentTools: value.subagentTools as ContextUsageToolDetail[],
    mcpTools: value.mcpTools as ContextUsageToolDetail[],
  };
}

for (const name of ["Agent", "Task"]) {
  test(`${name} 派发合同独立计入子代理，不重复增加上下文总量`, () => {
    const runtime = contextRuntime();
    const tools = [modelTool("Read"), modelTool(name, "Available agents: Explore, general-purpose")];
    const snapshot = readSnapshot(runtime, tools);
    const expected = buildToolUsageDetail.call(runtime, tools[1]!);
    const category = snapshot.categories.find(item => item.source === "subagents");
    assert.ok(category);
    assert.equal(category.chars, expected.chars);
    assert.equal(category.tokens, expected.tokens);
    assert.deepEqual(snapshot.subagentTools.map(tool => tool.name), [name]);
    assert.deepEqual(snapshot.systemTools.map(tool => tool.name), ["Read"]);
    const grouped = [...snapshot.systemTools, ...snapshot.subagentTools, ...snapshot.mcpTools];
    assert.equal(grouped.length, tools.length);
    assert.equal(grouped.reduce((sum, tool) => sum + tool.chars, 0), tools.map(tool => buildToolUsageDetail.call(runtime, tool)).reduce((sum, tool) => sum + tool.chars, 0));
    assert.equal(snapshot.raw.totalChars, snapshot.categories.reduce((sum, item) => sum + item.chars, 0));
    assert.equal(snapshot.raw.totalTokens, snapshot.categories.reduce((sum, item) => sum + item.tokens, 0));
    const contribution = snapshot.categoryBreakdown.find(item => item.source === "subagents");
    assert.ok(contribution);
    assert.deepEqual(contribution.contributors.map(item => [item.name, item.categorySource]), [[name, "subagents"]]);
    assert.equal(contribution.contributors[0]?.source, "system_tool");
    const compact = compactContextUsageSnapshot(snapshot.raw);
    assert.equal(compact.subagentToolCount, 1);
    assert.equal(compact.systemToolCount, 1);
    assert.ok((compact.categories as ContextUsageCategory[]).some(item => item.source === "subagents"));
  });
}

test("子代理只看当前请求实际工具，MCP 同名、控制工具及未注入 profile 不计入", () => {
  const runtime = contextRuntime();
  runtime.config = { subagents: { profiles: [{ name: "unexposed", source: "project", description: "Hidden profile", systemPrompt: "Hidden instructions" }] } };
  const snapshot = readSnapshot(runtime, [modelTool("Read"), modelTool("SendMessage"), modelTool("mcp__fixture__Agent")]);
  assert.equal(snapshot.categories.some(item => item.source === "subagents"), false);
  assert.deepEqual(snapshot.subagentTools, []);
  assert.deepEqual(snapshot.systemTools.map(tool => tool.name), ["Read", "SendMessage"]);
  assert.deepEqual(snapshot.mcpTools.map(tool => tool.name), ["mcp__fixture__Agent"]);
});

test("紧凑 wire 保留子代理来源并维持未知来源和无效数字过滤", () => {
  assert.deepEqual(buildContextUsageBreakdownFromSnapshot({ categories: [
    { source: "subagents", chars: 125.9 },
    { source: "messages", chars: 500 },
    { source: "unknown", chars: 10 },
    { source: "subagents", chars: -1 },
    { source: "subagents", chars: 0 },
    { source: "subagents", chars: Number.NaN },
  ] }), [{ source: "subagents", chars: 125 }, { source: "messages", chars: 500 }]);
});

test("Desktop continuous 与手机 replayable 都接受同一子代理用量来源", () => {
  const breakdown = [{ source: "messages", chars: 800 }, { source: "subagents", chars: 200 }];
  const contextUsage = { used: 1000, size: 1050000, breakdown };
  assert.deepEqual(zcodeSessionContextUsageSchema.parse(contextUsage).breakdown, breakdown);
  for (const deliveryKind of ["desktop-continuous", "web-remote-replayable"]) {
    const legacy = zcodeSessionRuntimeStateSchema.parse({ eventSeq: 1, stateRevision: 1, pendingRequestIds: [], deliveryKind, contextUsage });
    assert.deepEqual(legacy.contextUsage?.breakdown, breakdown);
  }
  const v4 = sessionUsageStateSchema.parse({
    contextWindow: { usedTokens: 1000, maxTokens: 1050000, autoCompactThresholdTokens: null, breakdown },
    cumulative: { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  assert.deepEqual(v4.contextWindow?.breakdown, breakdown);
  assert.equal(zcodeSessionContextUsageSchema.parse({ used: 1000, size: 1050000 }).breakdown, undefined);
  assert.throws(() => zcodeSessionContextUsageSchema.parse({ ...contextUsage, breakdown: [{ source: "untrusted", chars: 10 }] }));
});
