import assert from "node:assert/strict";
import test from "node:test";
import { injectMcpReferenceReminderFromTurn } from "../src/runtime/methods/mcp-reference.js";
import type { TraceContext } from "../src/runtime/deps.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

interface Attachment {
  source: string;
  content: string;
}

function createRuntime(input: {
  statuses: Record<string, { status: string; transport: string }>;
  tools?: Array<{ serverName: string; toolName: string }>;
  registeredToolNames?: string[];
  attachments: Attachment[];
}) {
  const startupSnapshot = Promise.resolve({
    statuses: input.statuses,
    tools: (input.tools ?? []).map((tool) => ({ ...tool })),
  });
  return {
    mcpPort: {
      status: async () => input.statuses,
    },
    initializeMcp: async () => undefined,
    mcpStartupPromise: startupSnapshot,
    getTools: () => (input.registeredToolNames ?? []).map((name) => ({ name })),
    messageHistory: {
      addAttachment: (source: string, content: string) => {
        input.attachments.push({ source, content });
      },
    },
    logger: { debug: () => undefined },
  };
}

async function runInjector(
  runtime: unknown,
  userInput: string,
  toolDisallowlist?: readonly string[],
): Promise<void> {
  await injectMcpReferenceReminderFromTurn.call(
    runtime as AgentRuntimeInternal,
    userInput,
    {} as TraceContext,
    toolDisallowlist,
  );
}

test("按 descriptor.serverName 归属工具，并写入 mcp_reference 附件", async () => {
  const attachments: Attachment[] = [];
  const runtime = createRuntime({
    statuses: {
      github: { status: "connected", transport: "http" },
      idle: { status: "disconnected", transport: "stdio" },
    },
    tools: [
      { serverName: "github", toolName: "create_issue" },
      { serverName: "github", toolName: "list_prs" },
      { serverName: "idle", toolName: "ping" },
    ],
    registeredToolNames: ["mcp__github__create_issue", "mcp__github__list_prs", "mcp__idle__ping"],
    attachments,
  });

  await runInjector(runtime, "[@GitHub](mcp://github) [@Idle](mcp://idle)");

  assert.equal(attachments.length, 1);
  const [attachment] = attachments;
  assert.ok(attachment);
  assert.equal(attachment.source, "mcp_reference");
  assert.match(attachment.content, /- name: "github"/);
  assert.match(attachment.content, /transport: "http"/);
  assert.match(attachment.content, /"mcp__github__create_issue"/);
  // 未连接的服务器不注入。
  assert.doesNotMatch(attachment.content, /idle/);
});

test("provider 不可见的工具（未注册或被本轮 disallow）不进提醒", async () => {
  const attachments: Attachment[] = [];
  const runtime = createRuntime({
    statuses: { s: { status: "connected", transport: "stdio" } },
    tools: [
      { serverName: "s", toolName: "hidden_by_registry" },
      { serverName: "s", toolName: "hidden_by_turn" },
      { serverName: "s", toolName: "visible" },
    ],
    registeredToolNames: ["mcp__s__hidden_by_turn", "mcp__s__visible"],
    attachments,
  });

  await runInjector(runtime, "[@S](mcp://s)", ["mcp__s__hidden_by_turn"]);

  assert.equal(attachments.length, 1);
  assert.match(attachments[0]?.content ?? "", /"mcp__s__visible"/);
  assert.doesNotMatch(attachments[0]?.content ?? "", /hidden_by_registry/);
  assert.doesNotMatch(attachments[0]?.content ?? "", /hidden_by_turn/);
});

test("没有引用或全部解析不出时不写附件（fail closed，零副作用）", async () => {
  const attachments: Attachment[] = [];
  const runtime = createRuntime({
    statuses: { s: { status: "connected", transport: "stdio" } },
    tools: [{ serverName: "s", toolName: "t" }],
    registeredToolNames: ["mcp__s__t"],
    attachments,
  });

  await runInjector(runtime, "普通消息，没有引用");
  await runInjector(runtime, "[@x](mcp://unknown-server)");
  await runInjector(runtime, "[@x](MCP://s)");

  assert.deepEqual(attachments, []);
});
