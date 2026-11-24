import assert from "node:assert/strict";
import test from "node:test";
import {
  fixtureRuntime,
  withPermissionTestDirectory,
} from "./upstreamRuntimePermissionFixtures.js";
import { SessionEventType, type McpPort, type PermissionRuleset } from "@zcode/contracts";
import { registerMcpTools } from "../src/mcp/index.js";
import {
  PermissionService,
  defaultPermissionConfig,
  type PermissionContext,
  type PermissionToolCapability,
} from "../src/permission/service.js";
import { webFetchToolEntry } from "../src/tool/handlers/webfetch.js";
import { bashToolEntry } from "../src/tool/handlers/bash.js";
import { writeToolEntry } from "../src/tool/handlers/write.js";
import { jsToolEntry } from "../src/tool/handlers/node-repl.js";
import { resolveRuntimePermissionCapability } from "../src/tool/executor/permission-capability.js";
import { createToolRegistry } from "../src/tool/registry.js";
import type { ToolEntry } from "../src/tool/types.js";

const FETCH_INPUT = { url: "https://fixture.example/query", prompt: "Read the fixture" };
const RUNTIME_CONTEXT = { workingDirectory: "/fixture", workspaceRoot: "/fixture" };

function capability(entry: ToolEntry, input: unknown = {}): PermissionToolCapability {
  return resolveRuntimePermissionCapability(entry, input, RUNTIME_CONTEXT);
}

function permissionContext(
  mode: PermissionContext["mode"],
  toolName = "WebFetch",
  input: unknown = FETCH_INPUT,
): PermissionContext {
  return { mode, planEnabled: true, toolName, input, riskLevel: "medium" };
}

function mockMcpPort(callTool: McpPort["callTool"]): McpPort {
  return {
    connectConfiguredServers: async () => ({ statuses: {}, tools: [] }),
    connectServer: async () => {
      throw new Error("Unexpected connection in fixture");
    },
    disconnectServer: async () => undefined,
    status: async () => ({}),
    listTools: async () => [],
    callTool,
    close: async () => undefined,
  };
}

function mcpEntry(annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {}) {
  const registry = createToolRegistry();
  const port = mockMcpPort(async () => ({ content: [{ type: "text", text: "fixture" }] }));
  const [name] = registerMcpTools(registry, port, [
    {
      name: "mcp__fixture__operation",
      serverName: "fixture",
      toolName: "operation",
      description: "Fixture MCP capability",
      inputSchema: { type: "object", properties: {} },
      annotations,
    },
  ]);
  const entry = registry.get(name!);
  assert.ok(entry);
  return entry;
}

for (const mode of ["build", "edit"] as const) {
  test(`Plan 不绕过 ${mode} 下 WebFetch 的 needsApproval`, () => {
    const decision = new PermissionService().checkPermission(
      permissionContext(mode),
      capability(webFetchToolEntry, FETCH_INPUT),
    );
    assert.equal(decision.decision, "ask");
    assert.equal(decision.ruleId, "mode.build.sideEffect");
  });

  test(`Plan 不绕过 ${mode} 下 readOnlyHint MCP 的 needsApproval`, () => {
    const entry = mcpEntry({ readOnlyHint: true });
    const decision = new PermissionService().checkPermission(
      permissionContext(mode, entry.metadata.name, {}),
      capability(entry),
    );
    assert.equal(decision.decision, "ask");
    assert.equal(decision.ruleId, "mode.build.sideEffect");
  });

  test(`Plan 对 ${mode} 的非只读 MCP 强制审批，项目 allow 不能绕过`, () => {
    const entry = mcpEntry();
    const rules: PermissionRuleset = { version: 1, allow: [{ toolName: entry.metadata.name }] };
    const decision = new PermissionService().checkPermission(
      permissionContext(mode, entry.metadata.name, {}),
      capability(entry),
      rules,
    );
    assert.equal(decision.decision, "ask");
    assert.equal(decision.ruleId, "mode.plan.mcp");
    assert.equal((decision as { optionsPolicy?: string }).optionsPolicy, "no-always-allow");
  });
}

test("Plan 继续允许预批 URL 与显式授权的只读 WebFetch", () => {
  const service = new PermissionService();
  const input = { ...FETCH_INPUT, url: "https://nodejs.org/api/" };
  assert.equal(
    service.checkPermission(
      permissionContext("build", "WebFetch", input),
      capability(webFetchToolEntry),
    ).ruleId,
    "tool.webfetch.preapproved",
  );
  assert.equal(
    service.checkPermission(permissionContext("build"), capability(webFetchToolEntry), {
      version: 1,
      allow: [{ toolName: "WebFetch" }],
    }).ruleId,
    "rule.project.allow",
  );
});

test("Plan 不改变原 project deny/ask、disallowedTools 和 alwaysAsk 优先级", () => {
  const context = permissionContext("build");
  const cap = capability(webFetchToolEntry);
  const service = new PermissionService();
  assert.equal(
    service.checkPermission(context, cap, { version: 1, deny: [{ toolName: "WebFetch" }] })
      .decision,
    "deny",
  );
  assert.equal(
    service.checkPermission(context, cap, { version: 1, ask: [{ toolName: "WebFetch" }] }).ruleId,
    "rule.project.ask",
  );
  assert.equal(
    new PermissionService({
      ...defaultPermissionConfig,
      disallowedTools: new Set(["WebFetch"]),
    }).checkPermission(context, cap).decision,
    "deny",
  );
  assert.equal(
    service.checkPermission(
      { ...context, mode: "yolo", planEnabled: false },
      { ...cap, alwaysAsk: true },
    ).ruleId,
    "tool.alwaysAsk",
  );
});

test("Plan 的 yolo 兼容边界：只过闸工具沿用 yolo，native 非只读仍拒绝", () => {
  const service = new PermissionService();
  const entry = mcpEntry();
  assert.equal(
    service.checkPermission(permissionContext("yolo"), capability(webFetchToolEntry)).ruleId,
    "mode.yolo",
  );
  assert.equal(
    service.checkPermission(permissionContext("yolo", entry.metadata.name, {}), capability(entry))
      .ruleId,
    "mode.yolo",
  );
  for (const tool of [writeToolEntry, bashToolEntry, jsToolEntry]) {
    const decision = service.checkPermission(
      permissionContext("yolo", tool.metadata.name, {}),
      capability(tool),
    );
    assert.equal(decision.decision, "deny", tool.metadata.name);
  }
});

test("Plan 仍拒绝 destructive MCP，显式 session control 保持可调用", () => {
  const service = new PermissionService();
  const entry = mcpEntry({ destructiveHint: true });
  assert.equal(
    service.checkPermission(permissionContext("build", entry.metadata.name, {}), capability(entry))
      .decision,
    "deny",
  );
  assert.equal(
    service.checkPermission(permissionContext("build", "RespondToCoordinator", {}), {
      allowedInPlanMode: true,
      sideEffectScope: "session",
      readOnly: false,
      destructive: false,
      needsApproval: false,
    }).ruleId,
    "mode.plan.explicitSessionCapability",
  );
});

test("executor 向事件与 broker 一致传递 Plan MCP 单次审批，不执行未批准 handler", async () => {
  await withPermissionTestDirectory(async (directory) => {
    const fixture = fixtureRuntime({
      directory,
      config: { planEnabled: true, subagents: { enabled: false } },
    });
    let calls = 0;
    const port = mockMcpPort(async () => {
      calls++;
      return { content: [{ type: "text", text: "fixture" }] };
    });
    const [name] = registerMcpTools(fixture.internal.registry, port, [
      {
        name: "mcp__fixture__mutation",
        serverName: "fixture",
        toolName: "mutation",
        inputSchema: { type: "object", properties: {} },
      },
    ]);
    const entry = fixture.internal.registry.get(name!);
    assert.ok(entry);
    entry.permission = { ...entry.permission, askOptions: { allowAlways: "session" } };
    const result = await fixture.internal.executor.execute({
      id: "fixture-mcp",
      name: name!,
      input: {},
    });
    assert.equal(fixture.requests.length, 1);
    assert.equal(fixture.requests[0]?.optionsPolicy, "no-always-allow");
    const events = await fixture.internal.eventStore.getEvents(fixture.internal.sessionId);
    const requested = events.find((event) => event.type === SessionEventType.PermissionRequested);
    assert.equal(
      (requested?.payload as { optionsPolicy?: string })?.optionsPolicy,
      "no-always-allow",
    );
    assert.equal(result.success, false);
    assert.equal(calls, 0);
    fixture.runtime.beginShutdown();
  });
});
