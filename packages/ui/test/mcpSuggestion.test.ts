import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeMcpServer } from "@zcode/shared";
import { buildSlashApplyMentionPayload } from "../src/lib/slashApplyMentionPayload.js";
import { buildMcpMentionMarkdown } from "../src/mentions/mentionMarkdown.js";
import { buildMcpSuggestions } from "../src/slashCommandHelpers.js";

function mcpServer(overrides: Partial<ZCodeMcpServer> & { name: string }): ZCodeMcpServer {
  return {
    id: `zcodeagentmcp:${overrides.name}`,
    config: { command: "npx" },
    enabled: true,
    source: "zcodeagentmcp",
    scope: "user",
    ...overrides,
  } as ZCodeMcpServer;
}

/** 只回 id 的 intl 替身：断言的是"用了哪个文案 key"，不是译文。 */
const intl = {
  formatMessage: (descriptor: { id: string }) => descriptor.id,
} as unknown as Parameters<typeof buildMcpSuggestions>[1];

test("列出项目级与全局的本地 MCP，并标出作用域", () => {
  const suggestions = buildMcpSuggestions(
    [
      mcpServer({ name: "github", scope: "user", toolCount: 12 }),
      mcpServer({ name: "local-fs", scope: "workspace", projectPath: "D:/workspace" }),
    ],
    intl,
  );

  assert.deepEqual(
    suggestions.map((item) => item.value),
    ["github", "local-fs"],
  );
  assert.deepEqual(
    suggestions.map((item) => item.label),
    ["@github", "@local-fs"],
  );
  const [github, localFs] = suggestions;
  assert.ok(github && localFs);
  assert.equal(github.data?.scope, "user");
  assert.match(github.description, /chat\.slash\.mcp\.scope\.global/);
  assert.match(github.description, /chat\.slash\.mcp\.toolCount/);
  assert.equal(localFs.data?.scope, "workspace");
  assert.match(localFs.description, /chat\.slash\.mcp\.scope\.project/);
  assert.equal(localFs.id, "mcp:local-fs");
});

test("排除插件提供的 MCP、已禁用的与名称不受支持的服务器", () => {
  const suggestions = buildMcpSuggestions(
    [
      mcpServer({ name: "from-plugin", source: "mcp" }),
      mcpServer({ name: "off", enabled: false }),
      mcpServer({ name: "bad name" }),
      mcpServer({ name: "ok" }),
    ],
    intl,
  );

  assert.deepEqual(
    suggestions.map((item) => item.value),
    ["ok"],
  );
});

test("项目级与全局同名时只保留项目级（运行时按名成键，无法区分同名）", () => {
  const suggestions = buildMcpSuggestions(
    [
      mcpServer({ name: "dup", scope: "user" }),
      mcpServer({ name: "dup", scope: "workspace", projectPath: "D:/workspace" }),
    ],
    intl,
  );

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0]?.data?.scope, "workspace");
});

test("选中后的引用载荷是 mcp:// 的 canonical markdown", () => {
  const suggestions = buildMcpSuggestions([mcpServer({ name: "github" })], intl);
  const suggestion = suggestions[0];
  assert.ok(suggestion);

  const payload = buildSlashApplyMentionPayload(suggestion);
  assert.equal(payload.category, "mcp");
  assert.equal(payload.label, "github");
  assert.equal(payload.markdown, "[@github](mcp://github)");
  // UI 生成的形态必须与 CLI 解析器识别的形态一致（解析侧断言见 core/test/mcpReference.test.ts）。
  assert.equal(buildMcpMentionMarkdown("github", "github"), payload.markdown);
});

test("含合法分隔符的服务器名原样进 destination", () => {
  assert.equal(
    buildMcpMentionMarkdown("weird.name:v1", "weird.name:v1"),
    "[@weird.name:v1](mcp://weird.name:v1)",
  );
});
