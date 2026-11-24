import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test, { mock } from "node:test";
import type { LogContext, Logger } from "@zcode/contracts";

const sdk = await import("@modelcontextprotocol/client");
const stdioSdk = await import("@modelcontextprotocol/client/stdio");
let connectBehavior: (transport: FakeStdioTransport) => Promise<void> = async () => {};
const connectedClientClosers: Array<() => void> = [];

// 官方 a9fe401e / b95ebaff 的回归以 public McpPort 为入口；SDK 端口为内存桩，绝不拉进程。
class FakeStdioTransport {
  readonly stderr = new PassThrough();
  readonly pid = undefined;
  async start(): Promise<void> {}
  async send(): Promise<void> {}
  async close(): Promise<void> {
    this.stderr.end();
  }
}

class FakeClient {
  onclose?: () => void;
  async connect(transport: FakeStdioTransport): Promise<void> {
    connectedClientClosers.push(() => this.onclose?.());
    await connectBehavior(transport);
  }
  async listTools(): Promise<{ tools: never[] }> {
    return { tools: [] };
  }
  getProtocolEra(): "legacy" {
    return "legacy";
  }
  getNegotiatedProtocolVersion(): string {
    return "2025-03-26";
  }
  async close(): Promise<void> {}
}

mock.module("@modelcontextprotocol/client", {
  namedExports: { ...sdk, Client: FakeClient },
});
mock.module("@modelcontextprotocol/client/stdio", {
  namedExports: { ...stdioSdk, StdioClientTransport: FakeStdioTransport },
});
mock.method(globalThis, "fetch", async () => {
  throw new Error("Upstream stderr regressions must not make network requests");
});

const { createMcpAdapter } = await import("../src/mcp/index.js");

interface CapturedLog {
  level: string;
  message: string;
  context?: LogContext;
}

function captureLogger(logs: CapturedLog[]): Logger {
  const logger: Logger = {
    child: () => logger,
    debug: (message, context) => logs.push({ level: "debug", message, context }),
    info: (message, context) => logs.push({ level: "info", message, context }),
    warn: (message, context) => logs.push({ level: "warn", message, context }),
    error: (message, _error, context) => logs.push({ level: "error", message, context }),
  };
  return logger;
}

async function observeStderr(chunks: readonly Buffer[], unexpectedClose = false, endStderr = true) {
  const logs: CapturedLog[] = [];
  connectedClientClosers.length = 0;
  connectBehavior = async (transport) => {
    for (const chunk of chunks) transport.stderr.write(chunk);
    if (endStderr) transport.stderr.end();
    if (!unexpectedClose) throw new Error("Connection closed");
  };
  const adapter = createMcpAdapter({ logger: captureLogger(logs) });
  try {
    const status = await adapter.connectServer("synthetic-stderr", {
      command: "unused-synthetic-command",
      type: "stdio",
      protocolVersion: "legacy",
    });
    if (unexpectedClose) connectedClientClosers.at(-1)?.();
    const event = unexpectedClose ? "mcp.server.connection_lost" : "mcp.server.failed";
    const failure = logs.find((entry) => entry.context?.event === event);
    assert.ok(failure, `Must retain the existing ${event} log`);
    const stderr = failure.context?.stderr;
    assert.ok(stderr === undefined || typeof stderr === "string");
    if (typeof stderr === "string") assert.ok(stderr.length <= 4_000);
    for (const entry of logs) {
      if (entry.context?.event === "mcp.stdio.stderr") {
        assert.equal(typeof entry.context.stderr, "string");
        assert.ok((entry.context.stderr as string).length <= 4_000);
      }
    }
    return { logs, stderr: typeof stderr === "string" ? stderr : "", status };
  } finally {
    await adapter.close();
  }
}

function assertNoSecrets(logs: CapturedLog[], secrets: readonly string[]): void {
  const serialized = JSON.stringify(logs);
  for (const secret of secrets) {
    assert.ok(
      !serialized.includes(secret),
      `A diagnostic sink retained synthetic secret ${secret}`,
    );
  }
}

for (const key of ["API_TOKEN", "VE_SPEECH_MCP_TOKEN", "access_token", "vendor-api-key"]) {
  test(`upstream: MCP redacts prefixed credential ${key} in both existing log sinks`, async () => {
    const secret = `fake-${key}-value`;
    const observed = await observeStderr([Buffer.from(`${key}=${secret}\nreal failure\n`)]);
    assertNoSecrets(observed.logs, [secret]);
    assert.match(observed.stderr, /real failure/);
    assert.equal(observed.status.error, "Connection closed");
    assert.equal(observed.status.failureKind, "process_start_failed");
  });
}

const quotedCases = [
  ['API_TOKEN="fake-first fake-spaces fake-last"', ["fake-first", "fake-spaces", "fake-last"]],
  [String.raw`VE_SPEECH_MCP_TOKEN="fake-escaped\" fake-suffix"`, ["fake-escaped", "fake-suffix"]],
  [
    String.raw`{"access_token":"fake-json\" fake-tail","code":"ECONNRESET"}`,
    ["fake-json", "fake-tail"],
  ],
  [String.raw`password='fake-single\' fake-end'`, ["fake-single", "fake-end"]],
] as const;
for (const [line, secrets] of quotedCases) {
  test(`upstream: MCP preserves whole quoted value boundaries for ${secrets[0]}`, async () => {
    const observed = await observeStderr([Buffer.from(`${line}\nreal failure\n`)]);
    assertNoSecrets(observed.logs, secrets);
    assert.match(observed.stderr, /real failure/);
    if (line.includes("ECONNRESET")) assert.match(observed.stderr, /ECONNRESET/);
  });
}

test("upstream: MCP strips VT controls before matching keys and auth schemes", async () => {
  const observed = await observeStderr([
    Buffer.from("\u001b[31mAPI_TO\u001b[0mKEN=fake-ansi-key\n"),
    Buffer.from("Authorization: Bea\u001b[31mrer fake-ansi-bearer\u001b[0m\nreal failure\n"),
  ]);
  assertNoSecrets(observed.logs, ["fake-ansi-key", "fake-ansi-bearer"]);
  assert.ok(!observed.stderr.includes("\u001b"));
  assert.match(observed.stderr, /real failure/);
});

test("upstream: MCP assembles split key, quote and token chunks before either log sink", async () => {
  const observed = await observeStderr([
    Buffer.from("VE_SPEECH_MCP_TO"),
    Buffer.from('KEN="fake-chunk-head '),
    Buffer.from(String.raw`fake-chunk-middle\" `),
    Buffer.from('fake-chunk-tail"\nAuthorization: Bear'),
    Buffer.from("er fake-chunk-bearer\nreal failure\n"),
  ]);
  assertNoSecrets(observed.logs, [
    "fake-chunk-head",
    "fake-chunk-middle",
    "fake-chunk-tail",
    "fake-chunk-bearer",
  ]);
  assert.match(observed.stderr, /real failure/);
});

test("upstream: MCP does not recover an unsafe suffix when the 4000 character tail cuts the key", async () => {
  const head = "KEN=fake-cut-key\nreal failure\n";
  const tail = `${head}${"y".repeat(4_000 - head.length - 1)}\n`;
  const observed = await observeStderr([Buffer.from(`first line\nVE_SPEECH_MCP_TO${tail}`)]);
  assertNoSecrets(observed.logs, ["fake-cut-key"]);
  assert.match(observed.stderr, /real failure/);
});

for (const separator of [" ", ",", ";", "&"]) {
  test(`upstream: MCP fails closed for truncated quoted credentials containing ${JSON.stringify(separator)}`, async () => {
    const tail = `KEN="fake-truncated${separator}fake-leaked-suffix"`;
    const observed = await observeStderr([
      Buffer.from(`VE_SPEECH_MCP_TO${tail}${"y".repeat(4_000 - tail.length)}`),
    ]);
    assertNoSecrets(observed.logs, ["fake-truncated", "fake-leaked-suffix"]);
    assert.equal(observed.status.error, "Connection closed");
  });
}

test("upstream: MCP drops an overlong line until CR and keeps the next diagnostic", async () => {
  const observed = await observeStderr([
    Buffer.from(`API_TOKEN="${"y".repeat(4_100)}`),
    Buffer.from('fake-dropped-suffix"\rreal failure\r'),
  ]);
  assertNoSecrets(observed.logs, ["fake-dropped-suffix"]);
  assert.match(observed.stderr, /real failure/);
});

test("upstream: unexpected MCP disconnect consumes the same redacted tail as failed connect", async () => {
  const observed = await observeStderr(
    [Buffer.from("API_TOKEN=fake-disconnect\nreal failure\n")],
    true,
  );
  assertNoSecrets(observed.logs, ["fake-disconnect"]);
  assert.match(observed.stderr, /real failure/);
  assert.equal(observed.status.status, "connected");
});

test("upstream: MCP auth/query/userinfo masking retains harmless diagnostic controls and EOF", async () => {
  const input = [
    "Authorization: Bearer fake-auth",
    "https://example.invalid/mcp?api_token=fake-query&safe=1",
    "https://fake-user:fake-userinfo@example.invalid/mcp",
    "tokenCount=7 authorizationMode=optional passwordPolicy=strict",
    "ModuleNotFoundError: No module named 'mcp'; ECONNRESET; 中文诊断",
  ].join("\n");
  const bytes = Buffer.from(input);
  const split = bytes.indexOf(Buffer.from("中文")) + 1;
  const observed = await observeStderr([bytes.subarray(0, split), bytes.subarray(split)]);
  assertNoSecrets(observed.logs, ["fake-auth", "fake-query", "fake-userinfo"]);
  assert.match(observed.stderr, /tokenCount=7 authorizationMode=optional passwordPolicy=strict/);
  assert.match(observed.stderr, /ModuleNotFoundError/);
  assert.match(observed.stderr, /ECONNRESET; 中文诊断/);
  assert.ok(!observed.stderr.includes("\uFFFD"));
});

test("upstream: empty MCP stderr does not manufacture a diagnostic", async () => {
  const observed = await observeStderr([]);
  assert.equal(observed.stderr, "");
  assert.equal(observed.status.error, "Connection closed");
});

const wrappedCredentialCases = [
  ["LF assignment", "API_TOKEN=\nfake-wrapped-key-secret\n", "fake-wrapped-key-secret"],
  [
    "LF auth scheme",
    "Authorization: Bearer\nfake-wrapped-auth-secret\n",
    "fake-wrapped-auth-secret",
  ],
  ["LF JSON", '{"API_TOKEN":\n"fake-json-secret"}\n', "fake-json-secret"],
  ["CR assignment", "API_TOKEN=\rfake-wrapped-key-secret\r", "fake-wrapped-key-secret"],
] as const;

function splitFiveBytes(text: string): Buffer[] {
  const bytes = Buffer.from(text);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 5)
    chunks.push(bytes.subarray(offset, offset + 5));
  return chunks;
}

for (const [label, payload, secret] of wrappedCredentialCases) {
  for (const fragmented of [false, true]) {
    for (const endStderr of [false, true]) {
      for (const unexpectedClose of [false, true]) {
        test(`upstream: MCP wrapped ${label}, ${fragmented ? "5-byte" : "single"} chunks, ${endStderr ? "EOF" : "open"}, ${unexpectedClose ? "lost" : "failed"} stays secret before every sink`, async () => {
          const text = `${payload}real failure\nECONNRESET\n`;
          const chunks = fragmented ? splitFiveBytes(text) : [Buffer.from(text)];
          const observed = await observeStderr(chunks, unexpectedClose, endStderr);
          assertNoSecrets(observed.logs, [secret]);
          assert.match(observed.stderr, /real failure/);
          assert.match(observed.stderr, /ECONNRESET/);
          assert.equal(observed.status.status, unexpectedClose ? "connected" : "failed");
          assert.equal(observed.status.error, unexpectedClose ? undefined : "Connection closed");
          const debug = observed.logs.filter(
            (entry) => entry.context?.event === "mcp.stdio.stderr",
          );
          assert.ok(debug.length > 0, "Preserve the existing debug diagnostic sink");
          assertNoSecrets(debug, [secret]);
        });
      }
    }
  }
}

test("upstream: MCP wrapped value at EOF or open failure snapshot is redacted without a trailing newline", async () => {
  for (const endStderr of [false, true]) {
    for (const unexpectedClose of [false, true]) {
      const observed = await observeStderr(
        splitFiveBytes("API_TOKEN=\nfake-eof-continuation"),
        unexpectedClose,
        endStderr,
      );
      assertNoSecrets(observed.logs, ["fake-eof-continuation"]);
      assert.match(observed.stderr, /\[Redacted\]/);
    }
  }
});

test("upstream: bounded wrapped-value context survives empty CR/LF and oversized whitespace but ends after the value", async () => {
  const payload = `API_TOKEN=\r\n\r\n${" ".repeat(4_100)}\r\nfake-budget-continuation\r\nECONNRESET\r\nreal failure\r\n`;
  const observed = await observeStderr(splitFiveBytes(payload), false, false);
  assertNoSecrets(observed.logs, ["fake-budget-continuation"]);
  assert.match(observed.stderr, /ECONNRESET/);
  assert.match(observed.stderr, /real failure/);
});

test("upstream: overlong wrapped credential value is discarded at the original bound without swallowing the next diagnostic", async () => {
  const payload = `API_TOKEN=\n${"x".repeat(4_100)}fake-long-continuation\nECONNRESET\nreal failure\n`;
  const observed = await observeStderr(splitFiveBytes(payload), true, false);
  assertNoSecrets(observed.logs, ["fake-long-continuation"]);
  assert.match(observed.stderr, /ECONNRESET/);
  assert.match(observed.stderr, /real failure/);
});

test("upstream: empty ordinary assignment and complete credentials never mark following diagnostics as secret continuations", async () => {
  const observed = await observeStderr(
    splitFiveBytes("tokenCount=\nECONNRESET\nAPI_TOKEN=fake-complete-value\nreal failure\n"),
    false,
    false,
  );
  assertNoSecrets(observed.logs, ["fake-complete-value"]);
  assert.match(observed.stderr, /tokenCount=/);
  assert.match(observed.stderr, /ECONNRESET/);
  assert.match(observed.stderr, /real failure/);
});
