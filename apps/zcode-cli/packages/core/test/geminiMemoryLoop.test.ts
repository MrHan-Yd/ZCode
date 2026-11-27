import assert from "node:assert/strict";
import test from "node:test";

import {
  createModelId,
  createModelProviderId,
  type Model,
  type ModelRequest,
  type ModelStreamEvent,
} from "@zcode/contracts";

import { runMemoryAgentLoop } from "../src/memory/memory-agent-loop.js";
import type { ToolExecutionResult } from "../src/tool/types.js";

const SIGNATURE = "sig-memory-签名";

function memoryModel(scripts: readonly (readonly ModelStreamEvent[])[]): {
  model: Model;
  requests: ModelRequest[];
} {
  const requests: ModelRequest[] = [];
  const model: Model = {
    providerId: createModelProviderId("google-native"),
    // 有序 assistantContent 只在 Gemini providerKind 下启用；手写 Model 必须显式声明，
    // 否则会走旧格式聚合视图，无法覆盖 Memory 多轮签名回放。
    providerKind: "google",
    modelId: createModelId("gemini-3.5-flash"),
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 128_000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    },
    optionSpecs: {
      reasoningLevel: { values: ["low"], map: "{}" },
      maxOutputTokens: { max: 4096, map: "{}" },
    },
    options: { reasoningLevel: "low", maxOutputTokens: 4096 },
    bind: () => model,
    generateText: async () => {
      throw new Error("memory loop 只允许流式辅助生成");
    },
    async *streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      requests.push(request);
      const script = scripts[requests.length - 1];
      assert.ok(script, "unexpected additional memory model request");
      for (const event of script) yield event;
    },
  };
  return { model, requests };
}

function toolResult(toolCallId: string): ToolExecutionResult {
  const now = new Date(1_700_000_000_000);
  return {
    toolCallId,
    toolName: "Read",
    success: true,
    output: "file content",
    modelContent: "file content",
    durationMs: 1,
    startedAt: now,
    completedAt: now,
  };
}

test("Memory 多轮工具循环保留逐 part 签名与原始顺序", async () => {
  const { model, requests } = memoryModel([
    [
      {
        type: "reasoning_start",
        id: "r1",
        providerMetadata: { google: { thoughtSignature: "r-sig" } },
      },
      { type: "reasoning_delta", id: "r1", text: "先读" },
      { type: "reasoning_end", id: "r1" },
      {
        type: "text_delta",
        id: "t1",
        text: "读取文件",
        providerMetadata: { google: { thoughtSignature: SIGNATURE } },
      },
      {
        type: "tool_call",
        toolCall: {
          id: "c1",
          name: "Read",
          input: { file_path: "MEMORY.md" },
          providerOptions: { google: { thoughtSignature: "tool-sig" } },
        },
      },
      { type: "finish", finishReason: "tool-calls", usage: {} },
    ],
    [
      { type: "text_delta", text: "done" },
      { type: "finish", finishReason: "stop", usage: {} },
    ],
  ]);

  const result = await runMemoryAgentLoop({
    abortSignal: undefined,
    executeTool: async (toolCall) => toolResult(toolCall.id),
    maxTurns: 3,
    messages: [{ role: "user", content: "更新记忆" }],
    model,
    rootDir: "F:/repo/.zcode/memory",
    tools: [
      {
        name: "Read",
        inputSchema: { type: "object" },
        executionMode: "client",
        sideEffectScope: "none",
      },
    ],
    workingDirectory: "F:/repo",
    workspaceRoot: "F:/repo",
  });

  assert.equal(requests.length, 2);
  const secondTurnMessages = requests[1]!.messages;
  const assistant = secondTurnMessages.find((message) => message.role === "assistant");
  assert.ok(assistant);
  assert.deepEqual(assistant.assistantContent, [
    { type: "reasoning", text: "先读", providerOptions: { google: { thoughtSignature: "r-sig" } } },
    {
      type: "text",
      text: "读取文件",
      providerOptions: { google: { thoughtSignature: SIGNATURE } },
    },
    {
      type: "tool_call",
      id: "c1",
      name: "Read",
      input: { file_path: "MEMORY.md" },
      providerOptions: { google: { thoughtSignature: "tool-sig" } },
    },
  ]);
  // 返回的 Memory 消息快照同样保留 assistantContent，后续轮次不会退化成聚合视图。
  const assistantSnapshot = result.messages.find((message) => message.role === "assistant");
  assert.ok(assistantSnapshot);
  assert.equal(assistantSnapshot.assistantContent?.length, 3);
});
