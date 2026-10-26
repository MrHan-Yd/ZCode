import assert from "node:assert/strict";
import test from "node:test";
import type { MessagePart, MessageWithParts } from "@zcode/contracts";
import { readConversationTailPreview } from "../src/zcode-protocol/server-operations.js";

/**
 * 只读尾部预览的护栏：
 * - 只收 user/assistant 的正文，工具只计数，reasoning 不泄露；
 * - 正文截断、hasMore 正确；
 * - 有 revert 时不提供预览（避免展示已丢弃分支）；
 * - 旧 store 没有 tailMessages 时回退全量后切片。
 */

const SESSION_ID = "sess-tail-preview";

const session = { id: SESSION_ID, revert: null } as never;

function message(
  id: string,
  role: "user" | "assistant",
  parts: MessagePart[],
  info?: Record<string, unknown>,
): MessageWithParts {
  return {
    info: { id, role, time: { created: 1 }, ...info },
    parts,
  } as unknown as MessageWithParts;
}

function textPart(id: string, text: string): MessagePart {
  return { id, type: "text", text } as unknown as MessagePart;
}

function syntheticTextPart(id: string, text: string): MessagePart {
  return { id, type: "text", text, synthetic: true } as unknown as MessagePart;
}

function toolPart(id: string): MessagePart {
  return { id, type: "tool", tool: "bash", callID: id, state: { status: "pending", input: {} } } as unknown as MessagePart;
}

function reasoningPart(id: string, text: string): MessagePart {
  return { id, type: "reasoning", text } as unknown as MessagePart;
}

function createContext(options: {
  messages: MessageWithParts[];
  hasTail?: boolean;
  revert?: unknown;
}) {
  const calls: Array<{ kind: "tail" | "messages"; limit?: number }> = [];
  const store: Record<string, unknown> = {
    getSession: async () => ({ ...(session as object), revert: options.revert ?? null }),
    messages: async () => {
      calls.push({ kind: "messages" });
      return options.messages;
    },
  };
  if (options.hasTail !== false) {
    store.tailMessages = async ({ limit }: { limit: number }) => {
      calls.push({ kind: "tail", limit });
      return options.messages.slice(-limit);
    };
  }
  return { calls, context: { deps: { sessionStore: store } } as never };
}

function baseMessages(): MessageWithParts[] {
  return [
    message("msg-user", "user", [textPart("p1", "hello")]),
    message("msg-synthetic", "user", [syntheticTextPart("p1b", "system reminder")]),
    message("msg-answer", "assistant", [
      reasoningPart("p2", "hidden reasoning"),
      textPart("p3", "answer"),
      toolPart("p4"),
      toolPart("p5"),
    ]),
    message("msg-reasoning-only", "assistant", [reasoningPart("p6", "only reasoning")]),
    message("msg-tool-only", "assistant", [toolPart("p7")]),
    message("msg-shared", "user", [textPart("p8", "shared context")], {
      source: "shared_context",
    }),
    message("msg-long", "user", [textPart("p9", "x".repeat(2_500))]),
  ];
}

test("过滤角色/推理/合成消息、工具只计数、正文截断", async () => {
  const { context } = createContext({ messages: baseMessages() });
  const result = await readConversationTailPreview(context, { sessionId: SESSION_ID, limit: 10 });

  assert.equal(result.hasMore, false);
  assert.deepEqual(
    result.messages.map((entry) => [entry.id, entry.role, entry.toolCallCount]),
    [
      ["msg-user", "user", 0],
      ["msg-answer", "assistant", 2],
      ["msg-tool-only", "assistant", 1],
      ["msg-long", "user", 0],
    ],
  );
  assert.equal(result.messages[0]?.text, "hello");
  assert.equal(result.messages[1]?.text, "answer");
  assert.equal(result.messages[2]?.text, "");
  assert.equal(result.messages[3]?.text.length, 2_001);
  assert.ok(result.messages[3]?.text.endsWith("…"));
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("hidden"), false);
  assert.equal(serialized.includes("system reminder"), false);
  assert.equal(serialized.includes("shared context"), false);
});

test("hasMore 由多取一条判定", async () => {
  const { calls, context } = createContext({ messages: baseMessages() });
  const result = await readConversationTailPreview(context, { sessionId: SESSION_ID, limit: 3 });

  assert.equal(result.hasMore, true);
  assert.deepEqual(
    result.messages.map((entry) => entry.id),
    ["msg-tool-only", "msg-long"],
  );
  assert.deepEqual(calls, [{ kind: "tail", limit: 4 }]);
});

test("有 revert 时不提供预览，也不读 store", async () => {
  const { calls, context } = createContext({
    messages: baseMessages(),
    revert: { branchCutAfterMessageID: "msg-user" },
  });
  const result = await readConversationTailPreview(context, { sessionId: SESSION_ID });
  assert.deepEqual(result, { sessionId: SESSION_ID, hasMore: false, messages: [] });
  assert.deepEqual(calls, []);
});

test("旧 store 没有 tailMessages 时回退全量后切片", async () => {
  const { calls, context } = createContext({ messages: baseMessages(), hasTail: false });
  const result = await readConversationTailPreview(context, { sessionId: SESSION_ID, limit: 3 });
  assert.equal(result.hasMore, true);
  assert.deepEqual(
    result.messages.map((entry) => entry.id),
    ["msg-tool-only", "msg-long"],
  );
  assert.deepEqual(calls, [{ kind: "messages" }]);
});
