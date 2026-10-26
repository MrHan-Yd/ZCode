import assert from "node:assert/strict";
import test from "node:test";
import type { MessagePart, MessageWithParts, SessionInfo } from "@zcode/contracts";
import { listSessionSubagents } from "../src/zcode-protocol/server-operations.js";

/**
 * 子 agent manifest 只从最后一条 assistant 推导终态/摘要。
 *
 * 护栏：store 提供 `lastAssistantMessage` 时不得再读子会话全量 messages；
 * 旧 store 缺该能力时必须回退，且两种路径得到相同的 summary/status。
 */

const PARENT_ID = "sess-parent";
const CHILD_ID = "sess-child";

const parentSession = {
  id: PARENT_ID,
  directory: "D:/workspace",
  path: "D:/workspace",
  taskType: "interactive",
  time: { created: 1, updated: 10 },
} as unknown as SessionInfo;

const childSession = {
  id: CHILD_ID,
  parentID: PARENT_ID,
  directory: "D:/workspace",
  path: "D:/workspace",
  taskType: "subagent_child",
  time: { created: 1, updated: 5 },
} as unknown as SessionInfo;

const subagentToolPart = {
  id: "part-parent",
  sessionID: PARENT_ID,
  messageID: "msg-parent",
  type: "tool",
  callID: "call-1",
  tool: "Task",
  state: {
    status: "completed",
    input: { description: "child", run_in_background: false },
    output: JSON.stringify({ childSessionId: CHILD_ID, description: "child" }),
    title: "child",
    metadata: {},
    time: { start: 1, end: 2 },
  },
} as unknown as MessagePart;

const parentMessages = [
  {
    info: { id: "msg-parent", sessionID: PARENT_ID, role: "assistant", time: { created: 1 } },
    parts: [subagentToolPart],
  },
] as unknown as MessageWithParts[];

const childAssistant = {
  info: {
    id: "msg-child-last",
    sessionID: CHILD_ID,
    role: "assistant",
    time: { created: 2, completed: 5 },
    finish: "stop",
  },
  parts: [
    {
      id: "part-child",
      sessionID: CHILD_ID,
      messageID: "msg-child-last",
      type: "text",
      text: "done",
    },
  ],
} as unknown as MessageWithParts;

const childUser = {
  info: { id: "msg-child-user", sessionID: CHILD_ID, role: "user", time: { created: 1 } },
  parts: [],
} as unknown as MessageWithParts;

function createStore(withCapability: boolean): {
  counters: { childFullReads: number; childLastReads: number };
  store: Record<string, unknown>;
} {
  const counters = { childFullReads: 0, childLastReads: 0 };
  const store: Record<string, unknown> = {
    getSession: async (id: string) =>
      id === PARENT_ID ? parentSession : id === CHILD_ID ? childSession : null,
    messages: async ({ sessionID }: { sessionID: string }) => {
      if (sessionID === PARENT_ID) return parentMessages;
      counters.childFullReads += 1;
      return [childUser, childAssistant];
    },
  };
  if (withCapability) {
    store.lastAssistantMessage = async ({ sessionID }: { sessionID: string }) => {
      if (sessionID !== CHILD_ID) return null;
      counters.childLastReads += 1;
      return childAssistant;
    };
  }
  return { counters, store };
}

async function run(withCapability: boolean) {
  const { counters, store } = createStore(withCapability);
  const context = {
    sessions: new Map(),
    deps: { sessionStore: store },
    logger: undefined,
  } as never;
  const result = await listSessionSubagents(
    context,
    { sessionId: PARENT_ID, endedLimit: 10 },
    parentMessages,
  );
  return { counters, result };
}

test("store 支持 lastAssistantMessage 时不读子会话全量 messages", async () => {
  const { counters, result } = await run(true);
  assert.deepEqual(result.childSessionIds, [CHILD_ID]);
  assert.equal(result.ended.total, 1);
  assert.equal(result.ended.items[0]?.summary, "done");
  assert.equal(result.ended.items[0]?.status, "success");
  assert.equal(counters.childLastReads, 1);
  assert.equal(counters.childFullReads, 0);
});

test("旧 store 缺能力时回退全量读取，结果一致", async () => {
  const { counters, result } = await run(false);
  assert.deepEqual(result.childSessionIds, [CHILD_ID]);
  assert.equal(result.ended.total, 1);
  assert.equal(result.ended.items[0]?.summary, "done");
  assert.equal(result.ended.items[0]?.status, "success");
  assert.equal(counters.childFullReads, 1);
  assert.equal(counters.childLastReads, 0);
});
