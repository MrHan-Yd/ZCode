import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  ZCODE_AGENT_PROVIDER,
  type HostAgentProcessExceptionResponse,
  type HostAgentProcessExitedResponse,
} from "@zcode/shared";

const customEvents: Array<{ name: string; properties: Record<string, string> }> = [];
const exceptionEvents: Array<{ name: string; message: string; stack?: string }> = [];

// 官方 b95ebaff 回归最终 sendCustom/sendEvent 参数，所有 ARMS/Electron/本地日志 IO 均为桩。
mock.module("@arms/rum-electron", {
  defaultExport: {
    sendCustom: (event: (typeof customEvents)[number]) => customEvents.push(event),
    sendEvent: (event: (typeof exceptionEvents)[number]) => exceptionEvents.push(event),
    setConfig: () => {},
  },
});
mock.module("electron", { namedExports: { BrowserWindow: {} } });
mock.module(new URL("../src/main/desktopCrashCapture.ts", import.meta.url).href, {
  namedExports: { registerCrashEventMonitor: () => {} },
});
mock.module(new URL("../src/main/resourceManagerWindow.ts", import.meta.url).href, {
  namedExports: { getResourceManagerWindowId: () => null },
});
mock.method(globalThis, "fetch", async () => {
  throw new Error("Upstream desktop regressions must not send telemetry");
});

const {
  configureDesktopStabilityTelemetry,
  notifyStabilityLifecycle,
  reportAgentProcessExceptionToArms,
  reportAgentProcessExitToArms,
} = await import("../src/main/desktopStabilityTelemetry.js");
const diagnosticModule = await import("@zcode/shared/process-diagnostic");
const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
configureDesktopStabilityTelemetry({
  deviceMid: "synthetic-device",
  platform: "win32",
  appVersion: "0.0.0",
  armsEnv: "local",
});

function exitEvent(stderrTail?: string[]): HostAgentProcessExitedResponse {
  return {
    type: "agent-process-exited",
    provider: ZCODE_AGENT_PROVIDER,
    pid: 12345,
    workspacePath: "/workspace/fake-project",
    exitCode: 1,
    signal: null,
    endedAt: 1,
    terminationKind: "unexpected",
    runtimeReady: true,
    runtimeGeneration: 1,
    runtimeInstanceId: "synthetic-runtime",
    uptimeMs: 1,
    stderrLineCount: stderrTail?.length ?? 0,
    ...(stderrTail ? { stderrTail } : {}),
  };
}

function assertNoSecrets(value: unknown, secrets: readonly string[]): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) {
    assert.ok(
      !serialized.includes(secret),
      `Final telemetry port retained synthetic secret ${secret}`,
    );
  }
}

function reportExit(stderrTail?: string[]) {
  customEvents.length = 0;
  notifyStabilityLifecycle("runtime");
  reportAgentProcessExitToArms(exitEvent(stderrTail), logger);
  const event = customEvents.at(-1);
  assert.ok(event);
  return event;
}

test("upstream: main independently masks unquoted Bearer/Basic before final crash port", () => {
  const event = reportExit([
    "Error: request failed",
    "Authorization: Bearer fake-main-bearer",
    "Proxy-Authorization: Basic fake-main-basic",
  ]);
  assertNoSecrets(event, ["fake-main-bearer", "fake-main-basic"]);
  assert.equal(event.name, "perf_agent_crash");
  assert.equal(event.properties.error_name, "Error");
  assert.equal(event.properties.error_message, "request failed");
});

test("upstream: services and main use one idempotent credential redactor", () => {
  assert.ok(
    "redactAgentDiagnosticSecrets" in diagnosticModule,
    "Existing shared process-diagnostic public entry must own the common credential rules",
  );
  const redact = diagnosticModule.redactAgentDiagnosticSecrets as (value: string) => string;
  const lines = [
    "Error: request failed",
    "Authorization: Bearer Bearer fake-common-nested",
    'Bearer "fake-common-quoted fake-common-tail"',
    String.raw`{"headers":{"Authorization":"Bearer fake-common-json","cookie":"sid=fake-common-cookie; uid=fake-common-refresh"},"code":"ECONNRESET"}`,
    String.raw`password="fake-common-password\" fake-common-password-tail"`,
    "cookie: sid=fake-common-one; refresh=fake-common-two",
  ];
  for (const line of lines) {
    const once = redact(line);
    assert.equal(
      redact(once),
      once,
      "Repeating the shared rule must not destroy quote or field boundaries",
    );
  }
  const event = reportExit(lines.map(redact));
  assertNoSecrets(event, [
    "fake-common-nested",
    "fake-common-quoted",
    "fake-common-tail",
    "fake-common-json",
    "fake-common-cookie",
    "fake-common-refresh",
    "fake-common-password",
    "fake-common-password-tail",
    "fake-common-one",
    "fake-common-two",
  ]);
  assert.match(event.properties.error_stack ?? "", /ECONNRESET/);
});

test("upstream: independent Agent exception sends redacted name/message/stack and retains dedup", () => {
  exceptionEvents.length = 0;
  const event: HostAgentProcessExceptionResponse = {
    type: "agent-process-exception",
    pid: 12345,
    provider: ZCODE_AGENT_PROVIDER,
    workspacePath: "/workspace/fake-project",
    runtimeGeneration: 1,
    runtimeInstanceId: "synthetic-exception-runtime",
    diagnostic: {
      version: 1,
      errorId: "00000000-0000-4000-8000-000000000003",
      kind: "unhandledRejection",
      origin: "unhandledRejection",
      name: "Authorization: Bearer fake-final-name",
      message: "Authorization: Bearer fake-final-message",
      stack: "Error: request failed\nProxy-Authorization: Basic fake-final-stack",
      occurredAt: 1,
    },
  };
  reportAgentProcessExceptionToArms(event, logger);
  reportAgentProcessExceptionToArms(event, logger);
  assert.equal(exceptionEvents.length, 1);
  assertNoSecrets(exceptionEvents, ["fake-final-name", "fake-final-message", "fake-final-stack"]);
});

test("upstream: redaction retains existing path privacy, errno attribution and fingerprint", () => {
  const lines = [
    "Error: ECONNRESET: request failed",
    "at read (/workspace/fake-project/source.ts:1:2)",
    "at open (C:\\Users\\fake-user\\source.ts:3:4)",
    "tokenCount=7 authorizationMode=optional passwordPolicy=strict; 中文诊断",
  ];
  const first = reportExit(lines);
  const second = reportExit(lines);
  assert.equal(first.properties.error_code, "ECONNRESET");
  assert.equal(first.properties.diagnostic_class, "errno");
  assert.equal(first.properties.error_fingerprint, second.properties.error_fingerprint);
  assert.match(first.properties.error_stack ?? "", /<workspace>/);
  assertNoSecrets(first, ["fake-project", "fake-user"]);
  assert.match(
    first.properties.error_stack ?? "",
    /tokenCount=7 authorizationMode=optional passwordPolicy=strict; 中文诊断/,
  );
  assert.ok((first.properties.error_stack?.length ?? 0) <= 4_000);
});

test("upstream: empty or missing stderr retains existing fallback and expected exits stay suppressed", () => {
  const missing = reportExit();
  const empty = reportExit([]);
  assert.equal(missing.properties.error_message, empty.properties.error_message);
  assert.equal(missing.properties.diagnostic_class, "none");
  assert.equal(missing.properties.error_stack, "");
  const count = customEvents.length;
  reportAgentProcessExitToArms({ ...exitEvent([]), terminationKind: "expected" }, logger);
  assert.equal(customEvents.length, count);
});
