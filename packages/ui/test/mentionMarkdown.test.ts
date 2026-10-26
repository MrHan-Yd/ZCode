import assert from "node:assert/strict";
import test from "node:test";
import { buildMcpMentionMarkdown, parseMentionMarkdown } from "../src/mentions/mentionMarkdown.js";

test("mcp:// 引用在发送后的气泡解析中保留 MCP 身份", () => {
  const parts = parseMentionMarkdown(
    "请用 [@pgsql_9_nbtp_20261015](mcp://pgsql_9_nbtp_20261015) 查一下",
  );

  assert.deepEqual(parts, [
    { type: "text", text: "请用 " },
    { type: "mcp", label: "pgsql_9_nbtp_20261015", serverName: "pgsql_9_nbtp_20261015" },
    { type: "text", text: " 查一下" },
  ]);
});

test("输入框生成的 MCP markdown 可以无损还原为 MCP chip", () => {
  assert.deepEqual(parseMentionMarkdown(buildMcpMentionMarkdown("mogo_9", "mogo_9")), [
    { type: "mcp", label: "mogo_9", serverName: "mogo_9" },
  ]);
});

test("非法 mcp destination 保持 display-only，不回落成文件", () => {
  assert.deepEqual(parseMentionMarkdown("[@bad](mcp://bad name)"), [{ type: "mcp", label: "bad" }]);
});

test("普通文件和 plugin 引用仍按各自类型解析", () => {
  assert.deepEqual(parseMentionMarkdown("[@a.ts](./a.ts)"), [{ type: "file", label: "a.ts" }]);
  assert.deepEqual(parseMentionMarkdown("[@Demo](plugin://demo@market)"), [
    { type: "plugin", label: "Demo", pluginId: "demo@market" },
  ]);
});
