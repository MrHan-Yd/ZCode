import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMcpReferenceReminderBody,
  extractMcpReferences,
  MAX_MCP_REFERENCES_PER_TURN,
  MAX_MCP_REFERENCE_TOOL_NAMES,
  type LiveMcpServerReference,
} from "../src/mcp-reference/index.js";

function liveServer(
  overrides: Partial<LiveMcpServerReference> & { serverName: string },
): LiveMcpServerReference {
  return {
    transport: "stdio",
    connected: true,
    providerVisibleToolNames: [],
    ...overrides,
  };
}

test("只按 mcp:// destination 识别身份，label 不参与", () => {
  assert.deepEqual(extractMcpReferences("请用 [@github](mcp://github) 查一下").references, [
    "github",
  ]);
  // label 与 destination 不一致时以 destination 为准（防 label 欺骗）。
  assert.deepEqual(extractMcpReferences("[@github](mcp://filesystem)").references, ["filesystem"]);
  // 裸链接与其他协议都不认。
  assert.deepEqual(extractMcpReferences("(mcp://github) https://example.com").references, []);
  assert.deepEqual(extractMcpReferences("[@x](plugin://a@b)").references, []);
});

test("协议名大小写敏感，非法 destination 计入 invalid", () => {
  for (const input of [
    "[@x](MCP://github)",
    "[@x](Mcp://github)",
    "[@x](mcp://)",
    "[@x](mcp://bad%20name)",
    "[@x](mcp://bad(paren)",
    // `<...>` 形态可以带空白，因此会进解析再被字母表拒掉。
    "[@x](<mcp://bad name>)",
  ]) {
    const result = extractMcpReferences(input);
    assert.deepEqual(result.references, [], input);
    assert.equal(result.invalidCount, 1, input);
  }
});

test("不成链接的 destination 一律不识别（fail closed，不计入 invalid）", () => {
  // 裸 destination 不含空白，空格会让整段根本不成链接——既不注入也不报 invalid。
  const spaced = extractMcpReferences("[@x](mcp://bad name)");
  assert.deepEqual(spaced.references, []);
  assert.equal(spaced.invalidCount, 0);
});

test("按名字去重并执行单轮上限", () => {
  assert.deepEqual(extractMcpReferences("[@a](mcp://s1) [@b](mcp://s1)").references, ["s1"]);

  const many = Array.from(
    { length: MAX_MCP_REFERENCES_PER_TURN + 2 },
    (_, index) => `[@s${index}](mcp://s${index})`,
  ).join(" ");
  const capped = extractMcpReferences(many);
  assert.equal(capped.references.length, MAX_MCP_REFERENCES_PER_TURN);
  assert.equal(capped.truncatedCount, 2);
});

test("只注入已连接且有 provider 可见工具的服务器，其余按原因跳过", () => {
  const result = buildMcpReferenceReminderBody({
    references: ["github", "unknown", "offline", "empty"],
    liveServers: [
      liveServer({
        serverName: "github",
        providerVisibleToolNames: ["mcp__github__create_issue", "mcp__github__list_prs"],
      }),
      liveServer({ serverName: "offline", connected: false, providerVisibleToolNames: ["t"] }),
      liveServer({ serverName: "empty", providerVisibleToolNames: [] }),
    ],
  });

  assert.ok(result.body);
  assert.match(result.body, /^<mcp_reference>/);
  assert.match(result.body, /- name: "github"/);
  assert.match(result.body, /"mcp__github__create_issue"/);
  // 未连接 / 无可见工具 / 未知的服务器不得出现在正文里。
  assert.doesNotMatch(result.body, /offline/);
  assert.doesNotMatch(result.body, /empty/);
  assert.doesNotMatch(result.body, /unknown/);
  assert.match(result.body, /does not connect, enable, authenticate, or authorize/);
  assert.deepEqual(result.diagnostics.resolvedServerNames, ["github"]);
  assert.deepEqual(result.diagnostics.skipped, [
    { serverName: "unknown", reason: "unknown" },
    { serverName: "offline", reason: "not_connected" },
    { serverName: "empty", reason: "no_visible_tools" },
  ]);
  assert.equal(result.diagnostics.toolCount, 2);
});

test("全部跳过时不注入（fail closed）", () => {
  assert.equal(buildMcpReferenceReminderBody({ references: ["nope"], liveServers: [] }).body, null);
  assert.equal(
    buildMcpReferenceReminderBody({
      references: ["offline"],
      liveServers: [liveServer({ serverName: "offline", connected: false })],
    }).body,
    null,
  );
});

test("非法标识不进正文：工具名被剔除，服务器名非法整条跳过", () => {
  const invalidTool = buildMcpReferenceReminderBody({
    references: ["s"],
    liveServers: [
      liveServer({ serverName: "s", providerVisibleToolNames: ["bad tool", "mcp__s__ok"] }),
    ],
  });
  assert.ok(invalidTool.body);
  assert.match(invalidTool.body, /"mcp__s__ok"/);
  assert.doesNotMatch(invalidTool.body, /bad tool/);
  assert.equal(invalidTool.diagnostics.toolCount, 1);

  const invalidName = buildMcpReferenceReminderBody({
    references: ["bad name"],
    liveServers: [liveServer({ serverName: "bad name", providerVisibleToolNames: ["t"] })],
  });
  assert.equal(invalidName.body, null);
  assert.deepEqual(invalidName.diagnostics.skipped, [
    { serverName: "bad name", reason: "invalid_identifier" },
  ]);
});

test("工具名超出单服务器上限时截断并标记", () => {
  const toolNames = Array.from(
    { length: MAX_MCP_REFERENCE_TOOL_NAMES + 4 },
    (_, index) => `mcp__s__tool_${String(index).padStart(3, "0")}`,
  );
  const result = buildMcpReferenceReminderBody({
    references: ["s"],
    liveServers: [liveServer({ serverName: "s", providerVisibleToolNames: toolNames })],
  });

  assert.equal(result.diagnostics.toolCount, MAX_MCP_REFERENCE_TOOL_NAMES);
  assert.equal(result.diagnostics.truncated, true);
  assert.doesNotMatch(result.body ?? "", /tool_036/);
});
