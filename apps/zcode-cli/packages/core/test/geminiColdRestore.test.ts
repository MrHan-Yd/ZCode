import assert from "node:assert/strict";
import test from "node:test";

import type {
  AssistantMessageInfo,
  MessagePart,
  MessageWithParts,
  ModelToolCall,
  PartId,
  ToolPart,
  TraceContext,
} from "@zcode/contracts";

import { MessageHistoryImpl } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import {
  mergeProviderReplayMetadata,
  providerOptionsFromPartMetadata,
  providerOptionsFromReasoningMetadata,
} from "../src/agent/assistant-part-replay.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { persistCancelledStreamSnapshot } from "../src/runtime/methods/cancelled-stream-persistence.js";
import { persistPendingToolPart } from "../src/runtime/methods/tool-part-persistence.js";
import { commitAssistantToTurnRequest } from "../src/runtime/methods/turn-output-token-continuation.js";

const SIGNATURE = "sig-cold-签名";

function assistantInfo(overrides: Partial<AssistantMessageInfo> = {}): AssistantMessageInfo {
  return {
    id: "msg-1" as AssistantMessageInfo["id"],
    sessionID: "session-1" as AssistantMessageInfo["sessionID"],
    role: "assistant",
    time: { created: 1, completed: 2 },
    parentID: "user-1" as AssistantMessageInfo["parentID"],
    mode: "default",
    agent: "main",
    path: { cwd: "F:/repo", root: "F:/repo" },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

function partId(value: string): PartId {
  return value as PartId;
}

function textPart(id: string, text: string, metadata?: Record<string, unknown>) {
  return {
    id: partId(id),
    sessionID: "session-1" as never,
    messageID: "msg-1" as never,
    type: "text" as const,
    text,
    ...(metadata ? { metadata } : {}),
  };
}

function reasoningPart(id: string, text: string, metadata?: Record<string, unknown>) {
  return {
    id: partId(id),
    sessionID: "session-1" as never,
    messageID: "msg-1" as never,
    type: "reasoning" as const,
    text,
    ...(metadata ? { metadata } : {}),
    time: { start: 1, end: 2 },
  };
}

function toolPart(
  id: string,
  callID: string,
  state: ToolPart["state"],
  metadata?: Record<string, unknown>,
): ToolPart {
  return {
    id: partId(id),
    sessionID: "session-1" as ToolPart["sessionID"],
    messageID: "msg-1" as ToolPart["messageID"],
    type: "tool",
    callID,
    declarationIndex: 0,
    tool: "Read",
    state,
    ...(metadata ? { metadata } : {}),
  };
}

async function hydrate(parts: MessagePart[]) {
  const history = new MessageHistoryImpl();
  history.init();
  const messages: MessageWithParts[] = [
    { info: assistantInfo(), parts: parts as MessageWithParts["parts"] },
  ];
  await hydrateMessageHistoryFromSession({ history, messages });
  const [entry] = history.toRuntimeEntries();
  assert.ok(entry && entry.kind !== "attachment");
  return entry.message;
}

test("cold 恢复按 providerContentIndex 还原 text/reasoning/tool_call interleaving 与签名", async () => {
  const message = await hydrate([
    reasoningPart("p0", "先想", {
      google: { thoughtSignature: "r-sig" },
      providerContentIndex: 0,
    }),
    textPart("p1", "开始", {
      providerOptions: { google: { thoughtSignature: SIGNATURE } },
      providerContentIndex: 1,
    }),
    toolPart(
      "p2",
      "call-1",
      {
        status: "completed",
        input: { file_path: "a.ts" },
        output: "done",
        title: "Read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
      {
        providerOptions: { google: { thoughtSignature: "tool-sig" } },
        providerContentIndex: 2,
      },
    ),
    textPart("p3", "", {
      providerOptions: { google: { thoughtSignature: "tail-sig" } },
      providerContentIndex: 3,
    }),
  ]);

  assert.deepEqual(message.assistantContent, [
    { type: "reasoning", text: "先想", providerOptions: { google: { thoughtSignature: "r-sig" } } },
    { type: "text", text: "开始", providerOptions: { google: { thoughtSignature: SIGNATURE } } },
    {
      type: "tool_call",
      id: "call-1",
      name: "Read",
      input: { file_path: "a.ts" },
      providerOptions: { google: { thoughtSignature: "tool-sig" } },
    },
    { type: "text", text: "", providerOptions: { google: { thoughtSignature: "tail-sig" } } },
  ]);
  // 兼容视图从数组派生，空 signed text 不进入聚合正文。
  assert.equal(message.toolCalls?.length, 1);
});

test("cold 恢复在无 providerContentIndex 的旧记录保持原聚合行为", async () => {
  const message = await hydrate([
    reasoningPart("p0", "旧思考", { anthropic: { signature: "old" } }),
    textPart("p1", "旧正文"),
    toolPart(
      "p2",
      "call-old",
      {
        status: "completed",
        input: { file_path: "a.ts" },
        output: "done",
        title: "Read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
      {},
    ),
  ]);
  assert.equal(message.assistantContent, undefined);
  assert.deepEqual(message.content, [
    { type: "reasoning", text: "旧思考", providerOptions: { anthropic: { signature: "old" } } },
    { type: "text", text: "旧正文" },
  ]);
  assert.deepEqual(message.toolCalls, [
    { id: "call-old", name: "Read", input: { file_path: "a.ts" } },
  ]);
});

test("cold error/running tool parts 同样保留调用签名与声明顺序", async () => {
  const message = await hydrate([
    toolPart(
      "p0",
      "call-err",
      {
        status: "error",
        input: { file_path: "x" },
        error: "boom",
        metadata: { modelContent: "model-visible" },
        time: { start: 1, end: 2 },
      },
      { providerOptions: { google: { thoughtSignature: "err-sig" } }, providerContentIndex: 0 },
    ),
    toolPart(
      "p1",
      "call-run",
      {
        status: "running",
        input: { file_path: "y" },
        title: "Read",
        metadata: {},
        time: { start: 1 },
      },
      { providerOptions: { google: { thoughtSignature: "run-sig" } }, providerContentIndex: 1 },
    ),
  ]);
  assert.deepEqual(
    message.assistantContent?.map((part) =>
      part.type === "tool_call" ? [part.id, part.providerOptions] : part.type,
    ),
    [
      ["call-err", { google: { thoughtSignature: "err-sig" } }],
      ["call-run", { google: { thoughtSignature: "run-sig" } }],
    ],
  );
});

test("stop snapshot 按 part 持久化 text/reasoning 的顺序、签名与索引", async () => {
  const persisted: Array<Record<string, unknown>> = [];
  const runtime = {
    sessionId: "session-1",
    persistPart: async (part: Record<string, unknown>) => {
      persisted.push(part);
    },
  } as unknown as AgentRuntimeInternal;

  await persistCancelledStreamSnapshot(runtime, {
    assistantCreatedAt: 1,
    assistantMessageId: "msg-1" as never,
    snapshot: {
      assistantContent: [
        { type: "reasoning", text: "想", providerOptions: { google: { thoughtSignature: "r" } } },
        { type: "text", text: "", providerOptions: { google: { thoughtSignature: SIGNATURE } } },
        {
          type: "tool_call",
          id: "c1",
          name: "Read",
          input: {},
          providerOptions: { google: { thoughtSignature: "t" } },
        },
      ],
      reasoning: [],
      text: "",
    },
    traceContext: {} as TraceContext,
  });

  assert.equal(persisted.length, 2);
  assert.equal(persisted[0]!.type, "reasoning");
  assert.deepEqual(persisted[0]!.metadata, {
    google: { thoughtSignature: "r" },
    providerContentIndex: 0,
  });
  assert.equal(persisted[1]!.type, "text");
  assert.equal(persisted[1]!.text, "");
  assert.deepEqual(persisted[1]!.metadata, {
    providerOptions: { google: { thoughtSignature: SIGNATURE } },
    providerContentIndex: 1,
  });
});

test("output-token continuation 提交带签名 assistantContent，不退回聚合 text", () => {
  const history = new MessageHistoryImpl();
  history.init();
  const runtime = { messageHistory: history } as unknown as AgentRuntimeInternal;
  const state = {
    model: { providerId: "fixture-provider", modelId: "fixture-model" },
    modelResponse: "续写",
    turnRequestState: {
      entries: [],
      outputTokenContinuationCount: 0,
    },
  } as never;

  const assistantContent = [
    {
      type: "text" as const,
      text: "续写",
      providerOptions: { google: { thoughtSignature: SIGNATURE } },
    },
    {
      type: "tool_call" as const,
      id: "c1",
      name: "Read",
      input: { file_path: "a" },
      providerOptions: { google: { thoughtSignature: "t" } },
    },
  ];
  const committed = commitAssistantToTurnRequest(
    runtime,
    state,
    {
      assistantContent,
      finishReason: "length",
      text: "续写",
      usage: {},
    },
    undefined,
  );
  assert.equal(committed, true);
  const [entry] = history.toRuntimeEntries();
  assert.ok(entry && entry.kind !== "attachment");
  assert.deepEqual(entry.message.assistantContent, assistantContent);
});

test("tool pending upsert 写入签名与索引，running/completed/error 合并不覆盖", async () => {
  const persisted: Array<Record<string, unknown>> = [];
  const runtime = {
    logger: undefined,
    sessionId: "session-1",
    persistPart: async (part: Record<string, unknown>) => {
      persisted.push(part);
    },
  } as unknown as AgentRuntimeInternal;
  const toolCall: ModelToolCall = {
    id: "c1",
    name: "Read",
    input: { file_path: "a" },
    providerOptions: { google: { thoughtSignature: "sig" } },
  };
  const replay = {
    providerContentIndex: 3,
    providerOptions: toolCall.providerOptions,
  };

  await persistPendingToolPart(runtime, {
    assistantMessageId: "msg-1" as never,
    declarationIndex: 0,
    input: { file_path: "a" },
    model: {} as never,
    partID: "p1" as never,
    providerReplay: replay,
    toolCall,
    traceContext: {} as TraceContext,
  });
  assert.deepEqual(persisted[0]!.metadata, {
    providerOptions: { google: { thoughtSignature: "sig" } },
    providerContentIndex: 3,
  });

  for (const extra of [
    { display: { kind: "generic" } },
    { serialization: { truncated: false } },
    { modelContent: "error text" },
  ]) {
    const merged = mergeProviderReplayMetadata(extra, replay);
    assert.deepEqual(merged, {
      ...extra,
      providerOptions: { google: { thoughtSignature: "sig" } },
      providerContentIndex: 3,
    });
  }

  // reasoning 原 namespace 兼容，但回放时排除 owner 字段。
  assert.deepEqual(
    providerOptionsFromReasoningMetadata({
      anthropic: { signature: "a" },
      providerContentIndex: 1,
    }),
    {
      anthropic: { signature: "a" },
    },
  );
  assert.equal(providerOptionsFromPartMetadata({ providerContentIndex: 1 }), undefined);
});
