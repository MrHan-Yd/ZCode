import assert from "node:assert/strict";
import test from "node:test";

import {
  createMessageId,
  createTraceId,
  type ModelAssistantContent,
  type ModelReasoningContentBlock,
  type ModelToolCall,
} from "@zcode/contracts";

import { resolveStreamedModelResultViews } from "../src/runtime/helpers/streamed-result-views.js";
import {
  completedModelResponse,
  fixtureRuntime,
  permissionTestModel,
  withPermissionTestDirectory,
} from "./upstreamRuntimePermissionFixtures.js";

const bashCall: ModelToolCall = {
  id: "call_00_stream_1",
  name: "Bash",
  input: { command: "node scripts/check-workspace-freshness.mjs" },
};

const reasoningBlock: ModelReasoningContentBlock = {
  type: "reasoning",
  text: "先看进程结构",
};

test("非 Gemini 流式结果保留聚合 toolCalls（回归：041b013d 之后工具不执行）", () => {
  const views = resolveStreamedModelResultViews({
    aggregatedText: "我先核对进程结构。",
    aggregatedReasoning: [reasoningBlock],
    aggregatedToolCalls: [bashCall],
  });

  assert.deepEqual(views.toolCalls, [bashCall]);
  assert.equal(views.text, "我先核对进程结构。");
  assert.deepEqual(views.reasoning, [reasoningBlock]);
});

test("非 Gemini 空聚合结果保持 undefined，不伪造空调用", () => {
  const views = resolveStreamedModelResultViews({
    aggregatedText: "纯文本回答",
    aggregatedReasoning: [],
    aggregatedToolCalls: [],
  });

  assert.equal(views.toolCalls, undefined);
  assert.equal(views.reasoning, undefined);
  assert.equal(views.text, "纯文本回答");
});

test("Gemini 有序视图优先，text 与 toolCalls 都按 part 顺序投影", () => {
  const orderedContent: ModelAssistantContent = [
    { type: "text", text: "先读文件。" },
    { type: "tool_call", id: "call_gemini", name: "Read", input: { file_path: "a.ts" } },
    { type: "text", text: "完成。" },
  ];

  const views = resolveStreamedModelResultViews({
    orderedAssistantContent: orderedContent,
    // 聚合视图必须被忽略，否则会与有序 part 出现两份调用。
    aggregatedText: "先读文件。完成。",
    aggregatedReasoning: [],
    aggregatedToolCalls: [bashCall],
  });

  assert.equal(views.text, "先读文件。完成。");
  assert.deepEqual(views.toolCalls, [
    { id: "call_gemini", name: "Read", input: { file_path: "a.ts" } },
  ]);
});

test("Gemini 有序视图只有 text 时不会回退到聚合调用", () => {
  const views = resolveStreamedModelResultViews({
    orderedAssistantContent: [{ type: "text", text: "只回答，不调用工具。" }],
    aggregatedText: "旧聚合文本",
    aggregatedReasoning: [],
    aggregatedToolCalls: [bashCall],
  });

  assert.equal(views.text, "只回答，不调用工具。");
  assert.equal(views.toolCalls, undefined);
});

test("非 Gemini 流式请求把工具调用交给 turn（调用点回归）", async () => {
  await withPermissionTestDirectory(async (directory) => {
    let modelCalls = 0;
    const model = permissionTestModel(() => {
      modelCalls += 1;
      if (modelCalls === 1) {
        return {
          text: "我先跑一下脚本。",
          finishReason: "tool-calls",
          toolCalls: [
            { id: "fixture-stream-call", name: "Bash", input: { command: "echo fixture" } },
          ],
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      }
      return completedModelResponse();
    });
    const fixture = fixtureRuntime({ directory, model, config: { modelStreaming: "on" } });
    try {
      await fixture.runtime.ensureSessionPersistedForExternalActivity("Stream fixture");
      const result = await fixture.internal.runModelTextRequest({
        assistantMessageId: createMessageId(),
        events: [],
        messages: [{ role: "user", content: "检查工作区" }],
        model,
        tools: [],
        traceContext: { traceId: createTraceId(), sessionId: fixture.internal.sessionId },
      });

      assert.deepEqual(
        result.toolCalls?.map((toolCall) => [toolCall.id, toolCall.name]),
        [["fixture-stream-call", "Bash"]],
      );
      assert.equal(result.assistantContent, undefined);
      assert.equal(result.finishReason, "tool-calls");
    } finally {
      fixture.runtime.beginShutdown();
    }
  });
});
