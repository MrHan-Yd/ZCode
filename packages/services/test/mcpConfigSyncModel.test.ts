import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_CONFIG_PROFILE,
  mcpServerFileName,
  mcpServerItemContent,
  mcpServerNameFromFileName,
  parseMcpServerConfig,
  resolveServerMap,
} from "../src/mcp-sync/mcpConfigSyncModel.js";
import type { ConfigSyncItem } from "../src/config-sync/types.js";

function item(name: string, config: Record<string, unknown>): ConfigSyncItem {
  return { name, content: mcpServerItemContent(config, true) };
}

test("server 文件名映射：空格与中文原样保留，危险字符转义且可还原", () => {
  assert.equal(mcpServerFileName("alpha"), "server.alpha.json");
  assert.equal(mcpServerNameFromFileName("server.alpha.json"), "alpha");
  assert.equal(mcpServerFileName("my server 中文"), "server.my server 中文.json");
  assert.equal(mcpServerNameFromFileName("server.my server 中文.json"), "my server 中文");

  // `/`、`%`、控制字符必须转义，否则 gist 文件名会带路径语义或被二次解析。
  const tricky = "a/b%c\u0001";
  const fileName = mcpServerFileName(tricky);
  assert.equal(fileName, "server.a%2fb%25c%01.json");
  assert.equal(mcpServerNameFromFileName(fileName ?? ""), tricky);

  // 非 server 文件与非法转义不认。
  assert.equal(mcpServerNameFromFileName("manifest.json"), null);
  assert.equal(mcpServerNameFromFileName("server.a%zz.json"), null);
});

test("条目内容：enabled 归一化写进配置对象，键排序稳定", () => {
  const content = mcpServerItemContent({ command: "npx", args: ["-y", "x"] }, false);
  assert.equal(content.includes('"enabled": false'), true);
  assert.equal(parseMcpServerConfig(content)?.command, "npx");
  // 同一份配置不同键序 → 同一份文本（指纹与 diff 依赖这个稳定性）。
  assert.equal(content, mcpServerItemContent({ args: ["-y", "x"], command: "npx" }, false));
});

test("内容校验：必须是 JSON 对象", () => {
  assert.equal(MCP_CONFIG_PROFILE.isValidContent("server.a.json", '{"command":"npx"}'), true);
  assert.equal(MCP_CONFIG_PROFILE.isValidContent("server.a.json", "不是 JSON"), false);
  assert.equal(MCP_CONFIG_PROFILE.isValidContent("server.a.json", "[1,2]"), false);
  assert.equal(MCP_CONFIG_PROFILE.isValidContent("server.a.json", "null"), false);
  assert.equal(parseMcpServerConfig("[]"), null);
  // MCP 没有额外通道（启用状态写在配置对象内）。
  assert.deepEqual(MCP_CONFIG_PROFILE.extraFileNames, []);
});

test("整份重写：merge 以本机集合打底 + 远端全集覆盖，replace 只留远端全集", () => {
  const local = new Map<string, Record<string, unknown>>([
    ["keep", { command: "local" }],
    ["shared", { command: "local" }],
  ]);
  const remoteItems = [item("shared", { command: "remote" }), item("same", { command: "same" })];

  const merged = resolveServerMap({ base: local, remoteItems });
  assert.ok(merged);
  assert.deepEqual(Object.keys(merged).sort(), ["keep", "same", "shared"]);
  assert.equal((merged.shared as { command: string }).command, "remote");
  assert.equal((merged.keep as { command: string }).command, "local");

  // replace：base 为空，但远端「未变更的 same」也必须在结果里。
  const replaced = resolveServerMap({ base: new Map(), remoteItems });
  assert.ok(replaced);
  assert.deepEqual(Object.keys(replaced).sort(), ["same", "shared"]);
});
