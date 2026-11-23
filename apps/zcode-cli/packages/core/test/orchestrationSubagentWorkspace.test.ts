import assert from "node:assert/strict";
import { mock } from "node:test";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionId,
  createTraceId,
  createInMemorySessionEventStore,
  type CreateSessionInput,
  type Model,
  type SessionStorePort,
  type SubagentLaunchRequest,
} from "@zcode/contracts";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { createDefaultSubagentPort } from "../src/runtime/methods/subagent.js";
import type { AgentRuntimeConfig, AgentRuntimeDeps } from "../src/runtime/types.js";
import { ensureSessionPersisted } from "../src/runtime/methods/events.js";

for (const source of ["workspace", "memory"] as const) {
  test(`编排子运行时从父 ${source} 配置继承隔离身份与持久化路径`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "zcode-subagent-workspace-"));
    const parentId = createSessionId("workspace-parent");
    const workspaceIdentity = "fixture-workspace-identity";
    const workspacePath = `${directory}/workspace/`;
    const created: CreateSessionInput[] = [];
    const sessionStore = {
      createSession: async (input: CreateSessionInput) => {
        created.push(input);
        return { ...input, time: { created: 1, updated: 1 } };
      },
    } as unknown as SessionStorePort;
    const model = {
      providerId: "fixture",
      modelId: "fixture",
      options: { reasoningLevel: "high" },
    } as Model;
    const config: AgentRuntimeConfig = {
      mode: "build",
      workingDirectory: directory,
      workspacePath,
      ...(source === "workspace"
        ? { workspaceIdentity: workspaceIdentity as AgentRuntimeConfig["workspaceIdentity"] }
        : { memory: { enabled: false, workspaceIdentity } }),
      modelSelection: {
        providerId: "fixture",
        modelId: "fixture",
        options: { reasoningLevel: "high" },
      },
      orchestration: { enabled: true, team: ["general-purpose", "Explore", "reviewer"] },
      subagents: { outputRootDir: directory, enabled: true },
    };
    const deps: AgentRuntimeDeps = {
      modelFactory: () => model,
      sessionStore,
      eventStore: createInMemorySessionEventStore(),
    };
    const runtime = new AgentRuntime(parentId, config, deps);
    const restorers = [
      mock.method(
        AgentRuntime.prototype,
        "ensureSessionPersistedForExternalActivity",
        async function (this: AgentRuntime, input: string) {
          const child = this as unknown as AgentRuntimeInternal;
          child.sessionStore = sessionStore;
          child.appendEvent = async () => undefined;
          await ensureSessionPersisted.call(child, input, { traceId: createTraceId() });
        },
      ),
      mock.method(AgentRuntime.prototype, "recordPendingModelChange", () => undefined),
      mock.method(AgentRuntime.prototype, "emitModelSelected", async () => undefined),
      mock.method(AgentRuntime.prototype, "executeTurn", async () => ({
        response: "done",
        traceId: createTraceId(),
        events: [],
      })),
      mock.method(AgentRuntime.prototype, "sealBackgroundTaskNotifications", () => undefined),
    ];
    try {
      const port = createDefaultSubagentPort.call(runtime as unknown as AgentRuntimeInternal, deps);
      assert.ok(port);
      const request: SubagentLaunchRequest = {
        sessionId: parentId,
        parentToolCallId: "attempt-workspace",
        agentType: "Explore",
        description: "Workspace identity fixture",
        prompt: "Read-only fixture",
        workingDirectory: directory,
        workspaceRoot: directory,
        trace: { traceId: createTraceId() },
      };
      await port.launch(request);
      assert.equal(created.length, 1);
      assert.equal(created[0]?.parentID, parentId);
      assert.equal(created[0]?.workspaceID, workspaceIdentity);
      assert.equal(created[0]?.directory, workspacePath);
      assert.equal(created[0]?.path, workspacePath);
    } finally {
      for (const restorer of restorers) restorer.mock.restore();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
