import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_PERFORMANCE_MAX_SESSIONS,
  sessionPerformanceBatchResultSchema,
  type SessionPerformanceSnapshot,
} from "@zcode/shared";
import { querySessionPerformanceBatch } from "../src/zcode-protocol/session-performance-batch.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const PARENT_SESSION = "session-batch-parent";
const CHILD_SESSION = "session-batch-child";
const ORPHAN_SESSION = "session-batch-orphan";

/** 每次聚合调用记录口径：口径是按会话种类在 CLI 侧裁决的，断言它才算真的验到规则。 */
type RecordedCall = { sessionID: string; querySources: readonly string[] };

function createContext(options: {
  /** 本进程驻留的 record；`parentSessionId` 表达"子会话自己也有 record"。 */
  sessions?: Array<{ id: string; parentSessionId?: string }>;
  /** 持久化层的 parentID 关系：非驻留的子会话只能靠它找回归属。 */
  storedParents?: Record<string, string | null>;
  /** 缺省给一个真实聚合实现；传 null 表示旧 store 没有该方法。 */
  withAggregate?: boolean;
  calls?: RecordedCall[];
}): ZCodeProtocolAgentServerContext {
  const sessions = new Map(
    (options.sessions ?? [{ id: PARENT_SESSION }]).map((session) => [
      session.id,
      session.parentSessionId
        ? { app: { sessionId: session.id }, parentSessionId: session.parentSessionId }
        : { app: { sessionId: session.id } },
    ]),
  );
  const sessionStore =
    options.withAggregate === false
      ? { getSession: async (id: string) => storedSession(options, id) }
      : {
          getSession: async (id: string) => storedSession(options, id),
          querySessionPerformance: async (input: RecordedCall) => {
            options.calls?.push({
              sessionID: input.sessionID,
              querySources: [...input.querySources],
            });
            return {
              sessionID: input.sessionID,
              modelMs: 6_000,
              toolMs: 0,
              modelRequestCount: 1,
              toolCallCount: 0,
              ttftSumMs: 1_000,
              ttftCount: 1,
              tpsOutputTokens: 500,
              generationMs: 5_000,
            };
          },
        };
  return {
    sessions,
    deps: { sessionStore },
  } as unknown as ZCodeProtocolAgentServerContext;
}

function storedSession(
  options: { storedParents?: Record<string, string | null> },
  id: string,
): { id: string; parentID?: string } | null {
  const parents = options.storedParents ?? {};
  if (!(id in parents)) return null;
  const parentID = parents[id];
  return parentID ? { id, parentID } : { id };
}

function entryById(entries: readonly SessionPerformanceSnapshot[], sessionId: string) {
  return entries.find((entry) => entry.sessionId === sessionId) ?? null;
}

test("运行中的子会话（没有自己的 record）靠持久化 parentID 找回归属，并按 subagent 口径读", async () => {
  const calls: RecordedCall[] = [];
  const context = createContext({
    storedParents: { [CHILD_SESSION]: PARENT_SESSION },
    calls,
  });

  const result = await querySessionPerformanceBatch(context, { sessionIds: [CHILD_SESSION] });

  assert.deepEqual(calls, [{ sessionID: CHILD_SESSION, querySources: ["subagent"] }]);
  const entry = entryById(result.entries, CHILD_SESSION);
  assert.ok(entry);
  assert.equal(entry.summary.tokensPerSecond, 100);
  sessionPerformanceBatchResultSchema.parse(result);
});

test("子会话自己也有 record 时按 record 的 parentSessionId 判种类，而不是当成主会话", async () => {
  const calls: RecordedCall[] = [];
  const context = createContext({
    sessions: [{ id: PARENT_SESSION }, { id: CHILD_SESSION, parentSessionId: PARENT_SESSION }],
    calls,
  });

  await querySessionPerformanceBatch(context, { sessionIds: [CHILD_SESSION, PARENT_SESSION] });

  assert.deepEqual(calls, [
    { sessionID: CHILD_SESSION, querySources: ["subagent"] },
    { sessionID: PARENT_SESSION, querySources: ["main_turn"] },
  ]);
});

test("父会话与子会话混在一批里：顺序同请求，口径各自独立", async () => {
  const context = createContext({ storedParents: { [CHILD_SESSION]: PARENT_SESSION } });

  const result = await querySessionPerformanceBatch(context, {
    sessionIds: [PARENT_SESSION, CHILD_SESSION],
  });

  assert.deepEqual(
    result.entries.map((entry) => entry.sessionId),
    [PARENT_SESSION, CHILD_SESSION],
  );
});

test("查不到归属的会话整体缺席，同批里其他会话照常返回", async () => {
  const context = createContext({
    storedParents: { [CHILD_SESSION]: PARENT_SESSION, [ORPHAN_SESSION]: null },
  });

  const result = await querySessionPerformanceBatch(context, {
    sessionIds: [ORPHAN_SESSION, CHILD_SESSION],
  });

  // 孤儿（没有本进程祖先 record）不报错也不给 0 读数：一个刚结束/别的 workspace 的会话
  // 不该让整批轮询失败。
  assert.equal(entryById(result.entries, ORPHAN_SESSION), null);
  assert.deepEqual(
    result.entries.map((entry) => entry.sessionId),
    [CHILD_SESSION],
  );
  sessionPerformanceBatchResultSchema.parse(result);
});

test("重复 id 只读一次", async () => {
  const calls: RecordedCall[] = [];
  const context = createContext({ calls });

  const result = await querySessionPerformanceBatch(context, {
    sessionIds: [PARENT_SESSION, PARENT_SESSION],
  });

  assert.equal(calls.length, 1);
  assert.equal(result.entries.length, 1);
});

test("超过 32 个会话的批次被 wire schema 拒绝", async () => {
  const context = createContext({});
  const tooMany = Array.from(
    { length: SESSION_PERFORMANCE_MAX_SESSIONS + 1 },
    (_, index) => `s-${index}`,
  );

  await assert.rejects(() => querySessionPerformanceBatch(context, { sessionIds: tooMany }));
});

test("空批次被 schema 拒绝（调用方应自己先门控，而不是发一笔空请求）", async () => {
  await assert.rejects(() => querySessionPerformanceBatch(createContext({}), { sessionIds: [] }));
});

test("旧 store 没有聚合方法时返回空读数，不抛错", async () => {
  const context = createContext({
    withAggregate: false,
    storedParents: { [CHILD_SESSION]: PARENT_SESSION },
  });

  const result = await querySessionPerformanceBatch(context, { sessionIds: [CHILD_SESSION] });

  const entry = entryById(result.entries, CHILD_SESSION);
  assert.ok(entry);
  assert.deepEqual(entry.summary, {
    modelMs: 0,
    toolMs: 0,
    averageTtftMs: null,
    tokensPerSecond: null,
    modelRequestCount: 0,
    toolCallCount: 0,
  });
});
