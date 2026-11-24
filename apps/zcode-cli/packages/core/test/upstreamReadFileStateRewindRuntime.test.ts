import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ReadOutputSchema,
  RewindStrategy,
  createInMemorySessionEventStore,
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  createTraceId,
  createWorkspaceId,
  modelMessageContentToText,
  type FileSystemPort,
  type FileSystemRevision,
  type FileSystemWriteTextRequest,
  type MessageWithParts,
  type SessionInfo,
  type SessionStorePort,
  type TraceContext,
} from "@zcode/contracts";
import { resolveProjectMemoryRoot } from "../src/memory/project-root.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";
import { readToolEntry } from "../src/tool/handlers/read.js";
import { writeToolEntry } from "../src/tool/handlers/write.js";
import type { PersistedReadFileStateMetadata } from "../src/tool/read-file-state-metadata.js";
import { createReadFileStateKey } from "../src/tool/read-file-state.js";
import type { ToolExecutionContext } from "../src/tool/types.js";

function unexpectedOperation(operation: string): never {
  throw new Error(`Unexpected fixture operation: ${operation}`);
}

function createRuntimeFixture(options: { startupIdentity?: string } = {}) {
  // 路径只作为内存端口的隔离标识；不创建目录，不读取用户数据，不启动模型或网络。
  const directory = join(tmpdir(), "zcode-read-state-runtime-fixture", "workspace");
  const cliStorageRoot = join(tmpdir(), "zcode-read-state-runtime-fixture", "custom-data-root");
  const workspaceId = createWorkspaceId("read-state-runtime-fixture");
  const sessionId = createSessionId("read-state-runtime-fixture");
  const traceContext: TraceContext = { traceId: createTraceId(), sessionId };
  const memoryRoot = resolveProjectMemoryRoot({
    cliStorageRoot,
    workspaceIdentity: String(workspaceId),
    workspacePath: directory,
  });
  const memoryPath = join(memoryRoot, "MEMORY.md");
  // 不带末尾空白，确保上下文真正提供完整视图，而不是 trim 后被标为 partial 的视图。
  const content = "# Memory\n- retained context content";
  let currentContent = content;
  let currentRevision: FileSystemRevision = {
    id: "fixture-context-revision",
    mtimeMs: 100,
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };
  const originalRevision = currentRevision;
  const writes: FileSystemWriteTextRequest[] = [];
  const readStateSizesBeforeContextRead: number[] = [];
  const snapshots: PersistedReadFileStateMetadata[] = [];
  const messages: MessageWithParts[] = [];
  let runtime: AgentRuntimeInternal | undefined;
  let session: SessionInfo = {
    id: sessionId,
    projectID: createProjectId("read-state-runtime-fixture"),
    workspaceID: workspaceId,
    taskType: "interactive",
    slug: "read-state-runtime-fixture",
    directory,
    path: directory,
    title: "Read state runtime fixture",
    version: "fixture",
    time: { created: 1, updated: 1 },
  };
  const fileSystemPort: FileSystemPort = {
    async createDirectory(request) {
      assert.equal(request.path, memoryRoot);
      return { path: request.path };
    },
    async stat(request) {
      assert.equal(request.path, memoryPath);
      return {
        path: request.path,
        kind: "file",
        sizeBytes: Buffer.byteLength(currentContent, "utf8"),
        mtimeMs: currentRevision.mtimeMs,
        revision: currentRevision,
      };
    },
    async readTextFile(request) {
      assert.equal(request.path, memoryPath);
      assert.ok(runtime);
      readStateSizesBeforeContextRead.push(runtime.readFileState.size);
      const sizeBytes = Buffer.byteLength(currentContent, "utf8");
      return {
        path: request.path,
        content: currentContent,
        encoding: "utf8",
        bytesRead: sizeBytes,
        sizeBytes,
        truncated: false,
        revision: currentRevision,
      };
    },
    async writeTextFile(request) {
      assert.equal(request.path, memoryPath);
      assert.equal(request.expectedRevision, currentRevision);
      writes.push(request);
      currentContent = request.content;
      const bytesWritten = Buffer.byteLength(request.content, "utf8");
      currentRevision = { id: "fixture-written-revision", mtimeMs: 300, sizeBytes: bytesWritten };
      return { path: request.path, bytesWritten, revision: currentRevision };
    },
    async readTextFileRange() {
      return unexpectedOperation("cached Read must not read the body");
    },
    async readBinaryFile() {
      return unexpectedOperation("readBinaryFile");
    },
    async removeFile() {
      return unexpectedOperation("removeFile");
    },
    async listDirectory() {
      return unexpectedOperation("listDirectory");
    },
    async searchFiles() {
      return unexpectedOperation("searchFiles");
    },
    async searchText() {
      return unexpectedOperation("searchText");
    },
  };
  const sessionStore: SessionStorePort = {
    async createSession() {
      return unexpectedOperation("createSession");
    },
    async updateSession() {
      return unexpectedOperation("updateSession");
    },
    async listSessions() {
      return unexpectedOperation("listSessions");
    },
    async saveMessage() {
      return unexpectedOperation("saveMessage");
    },
    async removeMessage() {
      return unexpectedOperation("removeMessage");
    },
    async savePart() {
      return unexpectedOperation("savePart");
    },
    async removePart() {
      return unexpectedOperation("removePart");
    },
    async messageWithParts() {
      return unexpectedOperation("messageWithParts");
    },
    async updateTodos() {
      return unexpectedOperation("updateTodos");
    },
    async setTarget() {
      return unexpectedOperation("setTarget");
    },
    async createTarget() {
      return unexpectedOperation("createTarget");
    },
    async updateTargetStatus() {
      return unexpectedOperation("updateTargetStatus");
    },
    async accountTargetUsage() {
      return unexpectedOperation("accountTargetUsage");
    },
    async updateTargetSummaryTitle() {
      return unexpectedOperation("updateTargetSummaryTitle");
    },
    async clearTarget() {
      return unexpectedOperation("clearTarget");
    },
    async getProjectPermission() {
      return unexpectedOperation("getProjectPermission");
    },
    async saveProjectPermission() {
      return unexpectedOperation("saveProjectPermission");
    },
    async clearRevert() {
      return unexpectedOperation("clearRevert");
    },
    async getSession(id) {
      assert.equal(id, sessionId);
      return session;
    },
    async messages(input) {
      assert.equal(input.sessionID, sessionId);
      return [...messages];
    },
    async setRevert(input) {
      assert.equal(input.sessionID, sessionId);
      session = { ...session, revert: structuredClone(input.revert) };
    },
    async readTarget(input) {
      assert.equal(input.sessionID, sessionId);
      return null;
    },
    async readTodos(input) {
      assert.equal(input.sessionID, sessionId);
      return [];
    },
    async sessionEntries(input) {
      assert.equal(input.sessionID, sessionId);
      return [];
    },
  };
  const memory: NonNullable<AgentRuntimeConfig["memory"]> = {
    cliStorageRoot,
    workspaceIdentity: options.startupIdentity ?? String(workspaceId),
    enabled: true,
    extractionEnabled: false,
  };
  const eventStore = createInMemorySessionEventStore();
  const agent = new AgentRuntime(
    sessionId,
    {
      workingDirectory: directory,
      workspaceIdentity: workspaceId,
      memory,
      subagents: { enabled: false },
      dynamicWorkflowEnabled: false,
      mcp: { enabled: false },
    },
    {
      eventStore,
      fileSystemPort,
      sessionStore,
      modelFactory: () => unexpectedOperation("modelFactory"),
      traceContext,
      now: () => new Date(1),
    },
  );
  runtime = agent as unknown as AgentRuntimeInternal;
  const toolContext: ToolExecutionContext = {
    toolCallId: "cached-memory-read",
    traceId: traceContext.traceId,
    sessionId,
    workingDirectory: directory,
    workspaceRoot: directory,
    memoryRoot,
    abortSignal: new AbortController().signal,
    fileSystemPort,
    readFileState: runtime.readFileState,
    recordReadFileStateMetadata(metadata) {
      snapshots.push(metadata);
    },
  };
  return {
    agent,
    runtime,
    sessionId,
    traceContext,
    directory,
    cliStorageRoot,
    memoryRoot,
    memoryPath,
    content,
    originalRevision,
    toolContext,
    snapshots,
    messages,
    writes,
    readStateSizesBeforeContextRead,
    session: () => session,
    async dispose() {
      agent.beginShutdown();
      await eventStore.deleteSession(sessionId);
    },
  };
}

type RuntimeFixture = ReturnType<typeof createRuntimeFixture>;

function userMessage(fixture: RuntimeFixture, id: string, created: number): MessageWithParts {
  const messageId = createMessageId(id);
  return {
    info: {
      id: messageId,
      sessionID: fixture.sessionId,
      role: "user",
      agent: "fixture",
      time: { created },
    },
    parts: [
      {
        id: createPartId(`${id}-part`),
        sessionID: fixture.sessionId,
        messageID: messageId,
        type: "text",
        text: "Fixture user request",
      },
    ],
  };
}

function cachedReadMessage(
  fixture: RuntimeFixture,
  parentId: MessageWithParts["info"]["id"],
  output: string,
  metadata: PersistedReadFileStateMetadata,
): MessageWithParts {
  const messageId = createMessageId("cached-read-assistant");
  return {
    info: {
      id: messageId,
      sessionID: fixture.sessionId,
      role: "assistant",
      parentID: parentId,
      time: { created: 11, completed: 12 },
      mode: "build",
      agent: "fixture",
      path: { cwd: fixture.directory, root: fixture.directory },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: createPartId("cached-read-part"),
        sessionID: fixture.sessionId,
        messageID: messageId,
        type: "tool",
        callID: fixture.toolContext.toolCallId,
        tool: "Read",
        state: {
          status: "completed",
          input: { file_path: fixture.memoryPath },
          output,
          title: "Read fixture memory",
          time: { start: 11, end: 12 },
          metadata: { readFileState: metadata },
        },
      },
    ],
  };
}

function assertContextContainsMemory(fixture: RuntimeFixture): void {
  assert.ok(
    fixture.runtime.messageHistory
      .borrowReadOnlyRuntimeEntries()
      .some(
        (entry) =>
          entry.kind === "attachment" &&
          entry.metadata.source === "context_prefix" &&
          entry.content.includes(fixture.memoryPath) &&
          entry.content.includes(fixture.content),
      ),
  );
}

test("真实 runtime 缓存 Read 后连续回退仍保留自定义数据根的上下文种子并允许 Write", async () => {
  const fixture = createRuntimeFixture();
  try {
    await fixture.runtime.ensureContextInitialized(fixture.traceContext);
    const key = createReadFileStateKey(fixture.memoryPath, undefined, undefined);
    const seed = fixture.runtime.readFileState.get(key);
    assert.ok(seed);
    assert.equal(seed.seededFromContext, true);
    assert.equal(seed.isPartialView, false);
    assert.equal(seed.revisionId, fixture.originalRevision.id);
    assert.equal(fixture.runtime.memoryRoot, fixture.memoryRoot);
    assert.deepEqual(fixture.readStateSizesBeforeContextRead, [0]);
    assertContextContainsMemory(fixture);

    const output = await readToolEntry.handler(
      { file_path: fixture.memoryPath },
      fixture.toolContext,
    );
    assert.equal(ReadOutputSchema.parse(output).type, "file_unchanged");
    assert.equal(fixture.runtime.readFileState.get(key), seed);
    assert.ok(readToolEntry.formatModelContent);
    const snapshot = fixture.snapshots[0];
    assert.ok(snapshot);
    const firstUser = userMessage(fixture, "first-user", 10);
    const cachedRead = cachedReadMessage(
      fixture,
      firstUser.info.id,
      modelMessageContentToText(readToolEntry.formatModelContent(output)),
      snapshot,
    );
    const secondUser = userMessage(fixture, "second-user", 20);
    fixture.messages.push(firstUser, cachedRead, secondUser);

    // 根因：缓存 Read 没有重读正文；重放其 metadata 曾覆盖 seed 标记，下一次 rewind 又把它删除。
    const firstRewind = await fixture.agent.rewindConversationToMessage({
      targetMessageId: secondUser.info.id,
      traceContext: fixture.traceContext,
      events: [],
    });
    assert.equal(firstRewind.strategy, RewindStrategy.ActiveChain);
    assert.equal(firstRewind.keptMessageCount, 2);
    assert.equal(fixture.runtime.readFileState.get(key), seed);
    assert.equal(seed.seededFromContext, true);
    const secondRewind = await fixture.agent.rewindConversationToMessage({
      targetMessageId: firstUser.info.id,
      traceContext: fixture.traceContext,
      events: [],
    });
    assert.equal(secondRewind.strategy, RewindStrategy.ActiveChain);
    assert.equal(secondRewind.keptMessageCount, 0);
    assert.deepEqual(fixture.session().revert?.keptMessageIDs, []);
    assert.equal(fixture.session().revert?.branchGeneration, 2);
    assert.equal(fixture.runtime.readFileState.size, 1);
    assert.equal(fixture.runtime.readFileState.get(key), seed);
    assert.equal(seed.readAt.getTime(), 1);
    assert.equal(seed.mtimeMs, fixture.originalRevision.mtimeMs);
    assert.equal(seed.sizeBytes, fixture.originalRevision.sizeBytes);
    assertContextContainsMemory(fixture);
    assert.deepEqual(fixture.readStateSizesBeforeContextRead, [0]);

    await writeToolEntry.handler(
      { file_path: fixture.memoryPath, content: "Updated fixture memory" },
      fixture.toolContext,
    );
    assert.equal(fixture.writes.length, 1);
    assert.equal(fixture.writes[0]?.content, "Updated fixture memory");
    assert.equal(fixture.runtime.readFileState.get(key)?.seededFromContext, undefined);
    assert.equal(fixture.runtime.readFileState.get(key)?.revisionId, "fixture-written-revision");
  } finally {
    await fixture.dispose();
  }
});

test("真实 cold resume 先清旧 runtime 种子，再按持久身份从自定义数据根加载上下文", async () => {
  const fixture = createRuntimeFixture({ startupIdentity: "different-startup-identity" });
  try {
    const oldPath = join(fixture.cliStorageRoot, "old-runtime", "MEMORY.md");
    fixture.runtime.readFileState.set(createReadFileStateKey(oldPath, undefined, undefined), {
      path: oldPath,
      content: "Old runtime memory",
      isPartialView: false,
      readAt: new Date(0),
      revisionId: "old-runtime-revision",
      mtimeMs: 0,
      sizeBytes: Buffer.byteLength("Old runtime memory", "utf8"),
      seededFromContext: true,
    });
    const result = await fixture.agent.resumeFromStore({ traceContext: fixture.traceContext });
    assert.equal(result.readFileStateRestoredCount, 0);
    assert.deepEqual(fixture.readStateSizesBeforeContextRead, [0]);
    assert.equal(fixture.runtime.memoryRoot, fixture.memoryRoot);
    assert.equal(
      fixture.runtime.config.memory?.workspaceIdentity,
      String(fixture.session().workspaceID),
    );
    assert.equal(fixture.runtime.readFileState.size, 1);
    assert.equal(
      fixture.runtime.readFileState.has(createReadFileStateKey(oldPath, undefined, undefined)),
      false,
    );
    const seed = fixture.runtime.readFileState.get(
      createReadFileStateKey(fixture.memoryPath, undefined, undefined),
    );
    assert.ok(seed);
    assert.equal(seed.seededFromContext, true);
    assert.equal(seed.content, fixture.content);
    assert.equal(seed.revisionId, fixture.originalRevision.id);
    assertContextContainsMemory(fixture);
    assert.equal(fixture.writes.length, 0);
  } finally {
    await fixture.dispose();
  }
});
