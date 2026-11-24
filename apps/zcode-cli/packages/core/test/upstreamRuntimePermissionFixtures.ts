import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createInMemorySessionEventStore,
  createModelId,
  createModelProviderId,
  createSessionId,
  createTraceId,
  type CreateSessionInput,
  type ExecutionPort,
  type MessageInfo,
  type MessagePart,
  type Model,
  type ModelRequest,
  type ModelResult,
  type PermissionBrokerRequest,
  type PermissionRuleset,
  type SessionEntryInfo,
  type SessionId,
  type SessionInfo,
  type SessionStorePort,
  type UpdateSessionInput,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";

/** 只实现被测路径的存储端口；真正运行 runtime 的持久化和 resume，不模拟它们的结果。 */
export function permissionTestStore() {
  const sessions = new Map<SessionId, SessionInfo>();
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, MessagePart>();
  const entries = new Map<string, SessionEntryInfo>();
  let projectPermission: PermissionRuleset | null = null;
  const store = {
    async createSession(input: CreateSessionInput): Promise<SessionInfo> {
      const session: SessionInfo = {
        ...input,
        taskType: input.taskType ?? "interactive",
        time: { created: 1, updated: 1 },
      };
      sessions.set(input.id, session);
      return session;
    },
    async getSession(id: SessionId) {
      return sessions.get(id) ?? null;
    },
    async updateSession(input: UpdateSessionInput) {
      const previous = sessions.get(input.id);
      if (!previous) throw new Error("Unknown fixture session");
      const session = {
        ...previous,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.titleSource === undefined ? {} : { titleSource: input.titleSource }),
        ...(input.permission ? { permission: input.permission } : {}),
      };
      sessions.set(input.id, session);
      return session;
    },
    async saveMessage(info: MessageInfo) {
      messages.set(String(info.id), info);
    },
    async savePart(part: MessagePart) {
      parts.set(String(part.id), part);
    },
    async removeMessage(input: { messageID: string }) {
      messages.delete(input.messageID);
    },
    async removePart(input: { partID: string }) {
      parts.delete(input.partID);
    },
    async messages(input: { sessionID: SessionId }) {
      return [...messages.values()]
        .filter((info) => info.sessionID === input.sessionID)
        .map((info) => ({
          info,
          parts: [...parts.values()].filter((part) => part.messageID === info.id),
        }));
    },
    async saveSessionEntry(entry: SessionEntryInfo) {
      entries.set(String(entry.id), entry);
    },
    async sessionEntries(input: { sessionID: SessionId; type?: string }) {
      return [...entries.values()].filter(
        (entry) =>
          entry.sessionID === input.sessionID && (!input.type || entry.type === input.type),
      );
    },
    async readTodos() {
      return [];
    },
    async readTarget() {
      return null;
    },
    async listSessionInputs() {
      return [];
    },
    async getProjectPermission() {
      return projectPermission;
    },
    async saveProjectPermission(input: { permission: PermissionRuleset }) {
      projectPermission = input.permission;
      return projectPermission;
    },
  };
  return { store: store as unknown as SessionStorePort, sessions, entries };
}

export function permissionTestModel(respond: (request: ModelRequest) => ModelResult): Model {
  const model: Model = {
    providerId: createModelProviderId("fixture-provider"),
    modelId: createModelId("fixture-model"),
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
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
      reasoningLevel: { values: ["high"], map: "reasoningLevel" },
      maxOutputTokens: { max: 4096, map: "maxOutputTokens" },
    },
    options: { reasoningLevel: "high", maxOutputTokens: 4096 },
    bind: (options) => ({ ...model, options: { ...model.options, ...options } }),
    generateText: async (request) => respond(request),
    async *streamText(request) {
      const result = respond(request);
      if (result.text) yield { type: "text_delta", text: result.text };
      for (const toolCall of result.toolCalls ?? []) yield { type: "tool_call", toolCall };
      yield { type: "finish", finishReason: result.finishReason, usage: result.usage };
    },
  };
  return model;
}

export function completedModelResponse(text = "fixture done"): ModelResult {
  return { text, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
}

export function fixtureRuntime(input: {
  directory: string;
  config?: Partial<AgentRuntimeConfig>;
  model?: Model;
  permissionService?: PermissionService;
  store?: ReturnType<typeof permissionTestStore>;
}) {
  const store = input.store ?? permissionTestStore();
  const requests: PermissionBrokerRequest[] = [];
  const commands: string[] = [];
  const executionPort = {
    async run(request: Parameters<ExecutionPort["run"]>[0]) {
      commands.push(JSON.stringify(request.command));
      return {
        status: "completed",
        exitCode: 0,
        stdout: { text: "fixture output", bytes: 14, truncated: false },
        stderr: { text: "", bytes: 0, truncated: false },
        durationMs: 1,
        timedOut: false,
        cancelled: false,
        startedAt: new Date(),
        completedAt: new Date(),
      };
    },
  } as ExecutionPort;
  const model = input.model ?? permissionTestModel(() => completedModelResponse());
  const runtime = new AgentRuntime(
    createSessionId(),
    {
      mode: "build",
      workingDirectory: input.directory,
      currentDate: "2026-11-24",
      modelSelection: {
        providerId: "fixture-provider",
        modelId: "fixture-model",
        options: { reasoningLevel: "high" },
      },
      bashShellSelection: {
        dialect: "posix",
        source: "auto-detected",
        display: { name: "bash" },
      },
      memory: { enabled: false },
      titleGeneration: { enabled: false },
      dynamicWorkflowEnabled: false,
      subagents: { outputRootDir: input.directory },
      ...input.config,
    },
    {
      eventStore: createInMemorySessionEventStore(),
      sessionStore: store.store,
      modelFactory: () => model,
      executionPort,
      permissionService: input.permissionService ?? new PermissionService(defaultPermissionConfig),
      permissionBroker: {
        async requestPermission(request) {
          requests.push(request);
          return { decision: "deny", reason: "fixture denied" };
        },
      },
    },
  );
  const internal = runtime as unknown as AgentRuntimeInternal;
  return { runtime, internal, requests, commands, store, model };
}

export async function withPermissionTestDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-upstream-permission-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function childRequest(parent: AgentRuntime, directory: string, agentType = "Explore") {
  return {
    agentType,
    sessionId: (parent as unknown as AgentRuntimeInternal).sessionId,
    parentToolCallId: "fixture-parent-call",
    description: "Permission regression fixture",
    prompt: "Complete the delegated fixture query",
    workingDirectory: directory,
    workspaceRoot: directory,
    trace: {
      traceId: createTraceId(),
      sessionId: (parent as unknown as AgentRuntimeInternal).sessionId,
    },
  };
}
