import assert from "node:assert/strict";
import test from "node:test";
import { resolveDefaultZCodeAgentCommand } from "../src/zcode-agent/zcodeAgentProcessManager.js";

/**
 * 回归：monorepo 源码兜底曾经把 `node_modules/.bin/tsx` 直接当 spawn 命令。
 * 那是个无扩展名的 POSIX shell 脚本（Windows 上同目录只有 tsx.CMD），而调用方
 * spawn 不带 shell，Windows 下必然 ENOENT，且 preflight 仍报 commandExists: true。
 */
test("agent 源码兜底不允许把 .bin/tsx shim 当作 spawn 命令", () => {
  const previousCommand = process.env.ZCODE_AGENT_SERVER_COMMAND;
  delete process.env.ZCODE_AGENT_SERVER_COMMAND;
  try {
    const command = resolveDefaultZCodeAgentCommand({
      workspacePath: process.cwd(),
      workspaceKey: process.cwd(),
    });

    assert.ok(command, "在仓库内应当能解析出 agent 命令");
    assert.equal(
      command.command,
      process.execPath,
      `源码兜底必须由 Node 本体执行，实际得到 ${command.command}`,
    );
    assert.ok(
      !/(^|[\\/])\.bin[\\/]tsx$/.test(command.command),
      `不允许把 tsx shim 当作 spawn 命令: ${command.command}`,
    );
    assert.ok(command.args?.includes("app-server"), "args 必须包含 app-server");
    assert.ok(command.args?.includes("--stdio"), "args 必须包含 --stdio");
  } finally {
    if (previousCommand === undefined) {
      delete process.env.ZCODE_AGENT_SERVER_COMMAND;
    } else {
      process.env.ZCODE_AGENT_SERVER_COMMAND = previousCommand;
    }
  }
});
