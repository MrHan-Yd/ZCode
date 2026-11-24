import assert from "node:assert/strict";
import test from "node:test";
import {
  createMessageId,
  createPartId,
  createSessionId,
  type MessageWithParts,
} from "@zcode/contracts";
import { hydrateReadFileStateFromSession } from "../src/agent/read-file-state-hydrator.js";
import { ensureContextInitialized } from "../src/runtime/methods/context.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type {
  ReadFileStateEntry,
  ReadFileStateMap,
  ToolExecutionContext,
} from "../src/tool/types.js";
import { writeToolEntry } from "../src/tool/handlers/write.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import type { PersistedReadFileStateMetadata } from "../src/tool/read-file-state-metadata.js";

const directory = "/fixture/workspace";
const memoryPath = "/fixture/memories/MEMORY.md";
const sessionId = createSessionId("upstream-rewind-session");

function readState(path: string, content = "context memory"): ReadFileStateEntry {
  return {
    path,
    content,
    isPartialView: false,
    readAt: new Date(1),
    revisionId: "fixture-revision",
    mtimeMs: 100,
    sizeBytes: Buffer.byteLength(content),
  };
}

function readStateMap(entry: ReadFileStateEntry): ReadFileStateMap {
  return new Map([[createReadFileStateKey(entry.path, undefined, undefined), entry]]);
}

async function hydrate(
  readFileState: ReadFileStateMap,
  options: {
    messages?: MessageWithParts[];
    retainContextSeeds?: boolean;
  } = {},
) {
  return hydrateReadFileStateFromSession({
    readFileState,
    messages: options.messages ?? [],
    workingDirectory: directory,
    workspaceRoot: directory,
    ...(options.retainContextSeeds ? { retainContextSeeds: true } : {}),
  });
}

function completedRead(path: string, content: string): MessageWithParts {
  const messageId = createMessageId("upstream-read-assistant");
  return {
    info: {
      id: messageId,
      sessionID: sessionId,
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: createMessageId("upstream-read-user"),
      mode: "build",
      agent: "fixture",
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: createPartId("upstream-read-part"),
        sessionID: sessionId,
        messageID: messageId,
        type: "tool",
        callID: "upstream-read-call",
        tool: "Read",
        state: {
          status: "completed",
          input: { file_path: path },
          output: content,
          title: "Read fixture",
          time: { start: 1, end: 2 },
          metadata: {
            readFileState: {
              schemaVersion: 1,
              tool: "Read",
              path,
              content,
              isPartialView: false,
              readAtMs: 2,
              revisionId: "retained-revision",
              mtimeMs: 200,
              sizeBytes: Buffer.byteLength(content),
            },
          },
        },
      },
    ],
  };
}

test("rewind 保留上下文种子及 freshness，不保留旧分支普通已读记录", async () => {
  const seed = { ...readState(memoryPath), seededFromContext: true };
  const map = readStateMap(seed);
  const oldTool = readState(`${directory}/old.ts`);
  map.set(createReadFileStateKey(oldTool.path, 1, undefined), oldTool);

  await hydrate(map, { retainContextSeeds: true });

  assert.equal(map.size, 1);
  assert.equal(map.get(createReadFileStateKey(memoryPath, 1, undefined)), seed);
  assert.equal(seed.revisionId, "fixture-revision");
  assert.equal(seed.mtimeMs, 100);
});

test("冷恢复默认清空种子，不复用别的 runtime 上下文", async () => {
  const map = readStateMap({ ...readState(memoryPath), seededFromContext: true });
  await hydrate(map);
  assert.equal(map.size, 0);
});

test("MEMORY.md 工具记录没有种子标记，rewind 不得保留被丢弃内容", async () => {
  const map = readStateMap(readState(memoryPath, "discarded tool content"));
  await hydrate(map, { retainContextSeeds: true });
  assert.equal(map.size, 0);
});

test("保留分支的完整工具快照覆盖上下文种子且不继承种子标记", async () => {
  const map = readStateMap({ ...readState(memoryPath), seededFromContext: true });
  const result = await hydrate(map, {
    retainContextSeeds: true,
    messages: [completedRead(memoryPath, "retained tool content")],
  });

  const restored = map.get(createReadFileStateKey(memoryPath, 1, undefined));
  assert.equal(result.restoredCount, 1);
  assert.equal(restored?.content, "retained tool content");
  assert.equal(restored?.revisionId, "retained-revision");
  assert.equal(restored?.seededFromContext, undefined);
});

test("rewind 保留部分视图约束，不能把截断种子提升为完整已读", async () => {
  const seed = { ...readState(memoryPath), seededFromContext: true, isPartialView: true };
  const map = readStateMap(seed);
  await hydrate(map, { retainContextSeeds: true });
  assert.equal(map.get(createReadFileStateKey(memoryPath, 1, undefined))?.isPartialView, true);
});

test("上下文初始化只标记实际读到并提供给模型的 MEMORY.md", async () => {
  const map: ReadFileStateMap = new Map();
  const trace = { traceId: "fixture-context-trace" } as Parameters<
    typeof ensureContextInitialized
  >[0];
  const runtime = {
    config: {},
    contextInitialized: false,
    workingDirectory: directory,
    readFileState: map,
    fileSystemPort: {
      readTextFile: async () => ({
        path: memoryPath,
        content: "# Memory\n\n- fixture memory\n",
        encoding: "utf8",
        bytesRead: 28,
        sizeBytes: 28,
        truncated: false,
        revision: { id: "context-revision", mtimeMs: 123 },
      }),
    },
    createConfigOnlyContextSnapshot: () => ({ workingDirectory: directory }),
    startMcpStartup: () => undefined,
    discoverSkillsForContext: async () => undefined,
    loadProjectMemoryRoot: async () => "/fixture/memories",
    createContextBuilderFromSnapshot: () => ({}),
    initializeMessageHistoryFromContext: () => undefined,
    now: () => new Date(3),
  } as unknown as AgentRuntimeInternal;

  await ensureContextInitialized.call(runtime, trace);

  const entry = map.get(createReadFileStateKey(memoryPath, undefined, undefined));
  assert.equal(entry?.seededFromContext, true);
  assert.equal(entry?.revisionId, "context-revision");
  assert.equal(runtime.contextInitialized, true);
});

function writeContext(map: ReadFileStateMap, current: ReadFileStateEntry) {
  const writes: string[] = [];
  const context = {
    toolCallId: "upstream-memory-write",
    traceId: "upstream-memory-trace",
    sessionId,
    abortSignal: new AbortController().signal,
    workingDirectory: "/fixture",
    workspaceRoot: "/fixture",
    readFileState: map,
    fileSystemPort: {
      readTextFile: async () => ({
        path: current.path,
        content: current.content,
        encoding: "utf8",
        bytesRead: current.sizeBytes,
        sizeBytes: current.sizeBytes,
        truncated: false,
        revision: { id: current.revisionId, mtimeMs: current.mtimeMs },
      }),
      writeTextFile: async (input: { path: string; content: string }) => {
        writes.push(input.content);
        return {
          path: input.path,
          revision: { id: "written-revision", mtimeMs: 300, sizeBytes: input.content.length },
        };
      },
    },
  } as unknown as ToolExecutionContext;
  return { context, writes };
}

test("回退未写记忆的轮次后，Write 可以更新已提供且未变化的索引", async () => {
  const seed = { ...readState(memoryPath), seededFromContext: true };
  const map = readStateMap(seed);
  await hydrate(map, { retainContextSeeds: true });
  const { context, writes } = writeContext(map, seed);

  await writeToolEntry.handler({ file_path: memoryPath, content: "updated memory" }, context);

  assert.deepEqual(writes, ["updated memory"]);
  assert.equal(
    map.get(createReadFileStateKey(memoryPath, 1, undefined))?.seededFromContext,
    undefined,
  );
});

test("回退保留种子仍不能覆盖用户改过的文件", async () => {
  const seed = { ...readState(memoryPath), seededFromContext: true };
  const map = readStateMap(seed);
  await hydrate(map, { retainContextSeeds: true });
  const { context, writes } = writeContext(map, {
    ...readState(memoryPath, "user modification"),
    revisionId: "user-revision",
    mtimeMs: 200,
  });

  await assert.rejects(
    writeToolEntry.handler({ file_path: memoryPath, content: "replacement" }, context),
    /File has been modified since read/,
  );
  assert.equal(writes.length, 0);
});

test("截断上下文种子回退后仍不能直接覆盖整个文件", async () => {
  const seed = { ...readState(memoryPath), seededFromContext: true, isPartialView: true };
  const map = readStateMap(seed);
  await hydrate(map, { retainContextSeeds: true });
  const { context, writes } = writeContext(map, seed);

  await assert.rejects(
    writeToolEntry.handler({ file_path: memoryPath, content: "replacement" }, context),
    /File has not been read yet/,
  );
  assert.equal(writes.length, 0);
});

async function cachedReadMessage(map: ReadFileStateMap, entry: ReadFileStateEntry) {
  let metadata: PersistedReadFileStateMetadata | undefined;
  const context = {
    ...writeContext(map, entry).context,
    fileSystemPort: {
      stat: async () => ({
        path: entry.path,
        kind: "file",
        sizeBytes: entry.sizeBytes,
        mtimeMs: entry.mtimeMs,
        revision: { id: entry.revisionId, mtimeMs: entry.mtimeMs },
      }),
      readTextFileRange: async () => {
        throw new Error("Cached Read must not fetch body");
      },
    },
    recordReadFileStateMetadata: (value: PersistedReadFileStateMetadata) => {
      metadata = value;
    },
  } as unknown as ToolExecutionContext;
  const output = await readToolEntry.handler({ file_path: entry.path }, context);
  assert.equal((output as { type: string }).type, "file_unchanged");
  assert.ok(metadata);
  const message = completedRead(entry.path, entry.content);
  const part = message.parts[0];
  assert.ok(part?.type === "tool" && part.state.status === "completed");
  const modelContent = readToolEntry.formatModelContent?.(output);
  assert.equal(typeof modelContent, "string");
  part.state.output = modelContent as string;
  part.state.metadata = { readFileState: metadata };
  return message;
}

test("缓存 Read 后连续回退仍保留上下文种子并允许安全 Write", async () => {
  const seed = { ...readState(memoryPath), seededFromContext: true };
  const map = readStateMap(seed);
  const cached = await cachedReadMessage(map, seed);
  assert.equal(map.get(createReadFileStateKey(memoryPath, 1, undefined)), seed);

  await hydrate(map, { retainContextSeeds: true, messages: [cached] });
  assert.equal(map.get(createReadFileStateKey(memoryPath, 1, undefined)), seed);
  await hydrate(map, { retainContextSeeds: true });
  assert.equal(map.get(createReadFileStateKey(memoryPath, 1, undefined)), seed);
  const { context, writes } = writeContext(map, seed);
  await writeToolEntry.handler({ file_path: memoryPath, content: "still safe" }, context);
  assert.deepEqual(writes, ["still safe"]);
});

test("仅有缓存 Read 的历史不能恢复为模型已读正文", async () => {
  const entry = readState(`${directory}/cached-only.ts`);
  const cached = await cachedReadMessage(readStateMap(entry), entry);
  const map: ReadFileStateMap = new Map();
  const result = await hydrate(map, { messages: [cached] });
  assert.equal(result.restoredCount, 0);
  assert.equal(map.size, 0);
});
