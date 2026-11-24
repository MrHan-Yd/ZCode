import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test, { mock } from "node:test";
import type {
  RuntimeProcessExitEvent,
  RuntimeProcessExceptionEvent,
} from "../src/process/runtimeProcessLifecycle.js";
import {
  ZCODE_PROCESS_DIAGNOSTIC_PREFIX,
  zcodeProcessDiagnosticSchema,
} from "@zcode/shared/process-diagnostic";

const childProcess = await import("node:child_process");
const logs: unknown[][] = [];
const spawnedChildren: FakeChild[] = [];
const stderrLines: Array<(line: string) => void> = [];

class FakeChild extends EventEmitter {
  readonly pid = 12345;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
}

class FakeTransport {
  constructor(_child: FakeChild, options: { onStderrLine?: (line: string) => void }) {
    if (options.onStderrLine) stderrLines.push(options.onStderrLine);
  }
  async waitForStderrDrain(): Promise<void> {}
}

class FakeProtocolClient {
  readonly storageStartup = { isWaiting: false, snapshot: null, onDidChange: () => {} };
  readonly pendingOperationRequestCount = 0;
  onRequestTimeout(): void {}
  onClose(): void {}
  async disposeAndWait(): Promise<void> {}
}

// 官方 b95ebaff 的真实边界：manager 收集 stderr → 生命周期 port / 生产日志。
// spawn、协议与 logger 全为内存桩，不接触真实进程、用户日志或遥测。
mock.module("node:child_process", {
  namedExports: {
    ...childProcess,
    spawn: () => {
      const child = new FakeChild();
      spawnedChildren.push(child);
      return child;
    },
  },
});
mock.module(new URL("../src/zcode-agent/zcodeStdioTransport.ts", import.meta.url).href, {
  namedExports: { ZCodeStdioTransport: FakeTransport },
});
mock.module(new URL("../src/zcode-agent/zcodeProtocolClient.ts", import.meta.url).href, {
  namedExports: { ZCodeProtocolClient: FakeProtocolClient },
});
mock.module(new URL("../src/zcode-agent/zcodeStdioTapDevConfig.ts", import.meta.url).href, {
  namedExports: { readZCodeStdioTapDevState: () => ({ enabled: false }) },
});
mock.module(new URL("../src/logger/serviceLogger.ts", import.meta.url).href, {
  namedExports: {
    createServiceLogger: () => ({
      info: (...args: unknown[]) => logs.push(args),
      warn: (...args: unknown[]) => logs.push(args),
      error: (...args: unknown[]) => logs.push(args),
      debug: () => {},
    }),
  },
});
mock.method(globalThis, "fetch", async () => {
  throw new Error("Upstream diagnostic regressions must not make network requests");
});

const { ZCodeAgentProcessManager } = await import("../src/zcode-agent/zcodeAgentProcessManager.js");

async function observeAgent(lines: readonly string[]) {
  logs.length = 0;
  spawnedChildren.length = 0;
  stderrLines.length = 0;
  const exceptions: RuntimeProcessExceptionEvent[] = [];
  const { promise: exitObserved, resolve: resolveExit } =
    Promise.withResolvers<RuntimeProcessExitEvent>();
  const manager = new ZCodeAgentProcessManager({
    commandResolver: () => ({ command: process.execPath }),
    processLifecycleReporter: {
      onSpawn: () => {},
      onExit: resolveExit,
      onException: (event) => exceptions.push(event),
    },
  });
  try {
    await manager.getClient({ workspacePath: process.cwd() });
    const child = spawnedChildren.at(-1);
    const onLine = stderrLines.at(-1);
    assert.ok(child);
    assert.ok(onLine);
    child.emit("spawn");
    for (const line of lines) onLine(line);
    child.exitCode = 1;
    child.emit("exit", 1, null);
    const exit = await exitObserved;
    return { exit, exceptions, logs: [...logs] };
  } finally {
    await manager.disposeAllAndWait();
    for (const child of spawnedChildren) {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
}

function assertNoSecrets(value: unknown, secrets: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    assert.ok(
      !serialized.includes(secret),
      `A diagnostic port retained synthetic secret ${secret}`,
    );
  }
}

for (const line of [
  "Authorization: Bearer fake-agent-bearer",
  "Proxy-Authorization: Basic fake-agent-basic",
]) {
  test(`upstream: Agent redacts unquoted auth scheme before assignment in ${line.split(":")[0]}`, async () => {
    const secret = line.split(" ").at(-1)!;
    const observed = await observeAgent(["Error: request failed", line]);
    assertNoSecrets(observed, [secret]);
    assert.equal(observed.exit.stderrLineCount, 2);
    assert.match(observed.exit.stderrTail?.join("\n") ?? "", /Error: request failed/);
    assert.equal(observed.exit.terminationKind, "unexpected");
  });
}

test("upstream: Agent redaction handles nested auth, quoted values and cookie suffixes", async () => {
  const lines = [
    "Authorization: Bearer Bearer fake-agent-nested",
    'Bearer "fake-agent-quoted fake-agent-quoted-tail"',
    String.raw`{"headers":{"Authorization":"Bearer fake-agent-json","cookie":"sid=fake-cookie-one; uid=fake-cookie-two"},"code":"ECONNRESET"}`,
    String.raw`password="fake-password\" fake-password-tail"`,
    "cookie: sid=fake-cookie-three; refresh=fake-cookie-four",
    "sk-fakebarekey01234567890123",
  ];
  const observed = await observeAgent(lines);
  assertNoSecrets(observed, [
    "fake-agent-nested",
    "fake-agent-quoted",
    "fake-agent-quoted-tail",
    "fake-agent-json",
    "fake-cookie-one",
    "fake-cookie-two",
    "fake-password",
    "fake-password-tail",
    "fake-cookie-three",
    "fake-cookie-four",
    "fakebarekey01234567890123",
  ]);
  assert.match(observed.exit.stderrTail?.join("\n") ?? "", /ECONNRESET/);
});

test("upstream: Agent structured diagnostic is redacted before the strict lifecycle port", async () => {
  const diagnostic = {
    version: 1,
    errorId: "00000000-0000-4000-8000-000000000001",
    kind: "unhandledRejection",
    origin: "unhandledRejection",
    name: "Authorization: Bearer fake-diagnostic-name",
    message: "Authorization: Bearer fake-diagnostic-message",
    stack: "Error: request failed\nProxy-Authorization: Basic fake-diagnostic-stack",
    occurredAt: 1,
  };
  const observed = await observeAgent([
    `${ZCODE_PROCESS_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`,
  ]);
  assert.equal(observed.exceptions.length, 1);
  assertNoSecrets(observed, [
    "fake-diagnostic-name",
    "fake-diagnostic-message",
    "fake-diagnostic-stack",
  ]);
  assert.ok(zcodeProcessDiagnosticSchema.safeParse(observed.exceptions[0]?.diagnostic).success);
  assert.equal(observed.exit.stderrLineCount, 0);
});

test("upstream: Agent preserves diagnostic protocol bounds, tail count and safe negative controls", async () => {
  const diagnostic = {
    version: 1,
    errorId: "00000000-0000-4000-8000-000000000002",
    kind: "uncaughtException",
    origin: "uncaughtException",
    name: "Authorization: Bearer x",
    message: "token=x ".repeat(500),
    stack: "token=x ".repeat(2_000),
    occurredAt: 2,
  };
  const lines = Array.from({ length: 22 }, (_value, index) => `safe diagnostic ${index}`);
  lines.push(`${"safe ".repeat(210)}Authorization: Bearer fake-after-bound`);
  lines.push("tokenCount=7 authorizationMode=optional passwordPolicy=strict; ECONNRESET; 中文诊断");
  const observed = await observeAgent([
    `${ZCODE_PROCESS_DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`,
    ...lines,
  ]);
  assert.equal(observed.exit.stderrLineCount, 24);
  assert.equal(observed.exit.stderrTail?.length, 20);
  assertNoSecrets(observed, ["fake-after-bound"]);
  assert.ok(observed.exit.stderrTail?.every((line) => line.length <= 1_100));
  assert.match(observed.exit.stderrTail?.join("\n") ?? "", /…\[truncated\]/);
  assert.match(
    observed.exit.stderrTail?.at(-1) ?? "",
    /tokenCount=7 authorizationMode=optional passwordPolicy=strict; ECONNRESET; 中文诊断/,
  );
  assert.ok(zcodeProcessDiagnosticSchema.safeParse(observed.exceptions[0]?.diagnostic).success);
});
