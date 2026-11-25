import assert from "node:assert/strict";
import test from "node:test";
import type { GitCommitGraphRequest } from "@zcode/shared";
import { createGitService } from "../src/git/gitService.js";
import {
  createGitGraphCursorState,
  decodeGitGraphCursor,
  encodeGitGraphCursor,
  gitGraphQueryFingerprint,
  gitGraphScope,
} from "../src/git/repo/gitCommitGraphCursor.js";
import {
  createGitGraphBudget,
  GIT_GRAPH_CURSOR_TTL_MS,
  GIT_GRAPH_MAX_HISTORY,
  GIT_GRAPH_MAX_ROOTS,
} from "../src/git/repo/gitCommitGraphLimits.js";
import { parseGitGraphRecords } from "../src/git/repo/gitCommitGraphParser.js";
import { createGitCliRepo, type GitCliRepo } from "../src/git/repo/gitCliRepo.js";
import {
  type GitCommandExecutionOptions,
  type GitCommandExecutionResult,
  type GitCommandProvider,
} from "../src/git/providers/gitCommandProvider.js";

const ROOT = "C:/graph-synthetic";
const OID = "a".repeat(40);
const PARENT = "b".repeat(40);
function result(command: GitCommandExecutionOptions, stdout = ""): GitCommandExecutionResult {
  return {
    binaryPath: "git",
    cwd: command.cwd,
    args: command.args,
    stdout,
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 1,
    timedOut: false,
    outputTruncated: false,
  };
}
function syntheticProvider(
  override?: (command: GitCommandExecutionOptions) => GitCommandExecutionResult | undefined,
) {
  const commands: GitCommandExecutionOptions[] = [];
  const provider: GitCommandProvider = {
    resolveGitBinary: async () => "git",
    async run(command) {
      commands.push(command);
      const supplied = override?.(command);
      if (supplied) return supplied;
      if (command.args.includes("--show-toplevel"))
        return result(command, `${ROOT}\n\n${ROOT}/.git\n.git\n`);
      if (command.args[0] === "for-each-ref")
        return result(command, `refs/heads/main\0${OID}\0commit\0\0\0\0\n`);
      if (command.args.includes("HEAD^{commit}")) return result(command, `${OID}\n`);
      if (command.args[0] === "log") {
        const record = (hash: string, parents: string, subject: string) =>
          [
            hash,
            parents,
            "Synthetic",
            "synthetic@example.invalid",
            "1700000000",
            subject,
            "refs/heads/main",
            "body",
          ].join("\0") + "\0";
        const skip = Number(command.args.find((arg) => arg.startsWith("--skip="))?.slice(7) ?? 0);
        return result(
          command,
          [record(OID, PARENT, "one"), record(PARENT, "", "two")].slice(skip).join("\n"),
        );
      }
      return result(command);
    },
  };
  return {
    provider,
    commands,
    service: createGitService({ repo: createGitCliRepo({ commandProvider: provider }) }),
  };
}

function issue(code: string) {
  return (error: unknown) =>
    error instanceof Error && (error as Error & { code?: string }).code === code;
}

test("service validates request shape and NUL before repository IO", async () => {
  let calls = 0;
  const repo = {
    getCommitGraph: async () => {
      calls += 1;
      throw new Error("unexpected IO");
    },
  } as unknown as GitCliRepo;
  const service = createGitService({ repo });
  const invalid: unknown[] = [
    { workspacePath: ROOT + "\0" },
    { workspacePath: ROOT, filters: { search: { value: "x", mode: "unknown" } } },
    { workspacePath: ROOT, filters: { search: { value: "x".repeat(513), mode: "regex" } } },
    { workspacePath: ROOT, filters: { date: { fromMs: 20, toMs: 10 } } },
    { workspacePath: ROOT, filters: { author: { name: "NUL\0", email: "x" } } },
    { workspacePath: ROOT, filters: { date: { fromMs: Infinity } } },
    { workspacePath: ROOT, maxCount: NaN },
  ];
  for (const params of invalid)
    await assert.rejects(
      service.getCommitGraph(params as GitCommitGraphRequest),
      issue("invalid-query"),
    );
  assert.equal(calls, 0);
  await assert.rejects(
    service.getCommitGraphFilterOptions({ workspacePath: "bad\0path" }),
    issue("invalid-query"),
  );
});

test("invalid regex and unsafe/nonexistent branch refs have stable errors", async () => {
  const { service, commands } = syntheticProvider();
  await assert.rejects(
    service.getCommitGraph({
      workspacePath: ROOT,
      filters: { search: { value: "[", mode: "regex" } },
    }),
    issue("invalid-regex"),
  );
  for (const branchRef of [
    "refs/heads/main~1",
    "refs/heads/missing",
    "refs/remotes/origin/HEAD",
    "refs/heads/main;touch injected",
  ]) {
    await assert.rejects(
      service.getCommitGraph({ workspacePath: ROOT, filters: { branchRef } }),
      issue("branch-not-found"),
    );
    assert.ok(!commands.some((command) => command.args.includes(branchRef)));
  }
});

test("signed cursors reject mutation, invalid offsets, other scopes/repos and different queries", async () => {
  const { service } = syntheticProvider();
  const request = {
    workspacePath: ROOT,
    workspaceIdentity: "scope-one",
    maxCount: 1,
    filters: { search: { value: "o", mode: "literal" as const } },
  };
  const first = await service.getCommitGraph(request);
  assert.ok(first.cursor);
  assert.equal(first.hasMore, true);
  const cursor = first.cursor;
  const tokenParts = cursor.split(".");
  const payload = JSON.parse(
    Buffer.from(tokenParts[0] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  payload.offset = -1;
  const tampered = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${tokenParts[1]}`;
  await assert.rejects(
    service.getCommitGraph({ ...request, cursor: tampered }),
    issue("invalid-cursor"),
  );
  await assert.rejects(
    service.getCommitGraph({ ...request, cursor: "nonsense" }),
    issue("invalid-cursor"),
  );
  await assert.rejects(
    service.getCommitGraph({ ...request, cursor: cursor.slice(0, -1) + "!" }),
    issue("invalid-cursor"),
  );
  await assert.rejects(
    service.getCommitGraph({ ...request, cursor, workspaceIdentity: "scope-two" }),
    issue("invalid-cursor"),
  );
  await assert.rejects(
    service.getCommitGraph({
      ...request,
      cursor,
      workspaceIdentity: undefined,
      workspacePath: "C:/other",
    }),
    issue("invalid-cursor"),
  );
  await assert.rejects(
    service.getCommitGraph({
      ...request,
      cursor,
      filters: { search: { value: "different", mode: "literal" } },
    }),
    issue("invalid-cursor"),
  );
  const next = await service.getCommitGraph({
    ...request,
    cursor,
    workspaceIdentity: "  scope-one  ",
  });
  assert.deepEqual(
    next.commits.map((entry) => entry.hash),
    [PARENT],
  );
});

test("Git timeout/truncation including HEAD/ref discovery never becomes empty history", async () => {
  for (const stage of ["resolution", "head", "refs", "log"]) {
    for (const failure of ["timedOut", "outputTruncated"] as const) {
      const { service } = syntheticProvider((command) => {
        const targeted =
          stage === "resolution"
            ? command.args.includes("--show-toplevel")
            : stage === "head"
              ? command.args.includes("HEAD^{commit}")
              : command.args[0] === (stage === "refs" ? "for-each-ref" : "log");
        if (!targeted) return undefined;
        return {
          ...result(command),
          exitCode: 1,
          stderr: "ambiguous argument 'HEAD'",
          [failure]: true,
        };
      });
      await assert.rejects(service.getCommitGraph({ workspacePath: ROOT }), issue("query-timeout"));
      await assert.rejects(
        service.getCommitGraphFilterOptions({ workspacePath: ROOT }),
        issue("query-timeout"),
      );
    }
  }
});

test("catastrophic regex is worker-bounded, leaves Host responsive and terminates after rejection", async () => {
  const { service } = syntheticProvider((command) =>
    command.args[0] === "log"
      ? result(
          command,
          [
            OID,
            "",
            "Synthetic",
            "synthetic@example.invalid",
            "1700000000",
            "normal title",
            "",
            "a".repeat(40_000) + "!",
          ].join("\0") + "\0",
        )
      : undefined,
  );
  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks += 1;
  }, 5);
  const startedAt = Date.now();
  try {
    await assert.rejects(
      service.getCommitGraph({
        workspacePath: ROOT,
        filters: { search: { value: "(a+)+$", mode: "regex" } },
      }),
      issue("query-timeout"),
    );
    assert.ok(ticks > 1);
    assert.ok(Date.now() - startedAt < 5_000);
  } finally {
    clearInterval(heartbeat);
  }
});

test("cursor validates signed bounds and expiration and is tied to repository root", () => {
  const fingerprint = gitGraphQueryFingerprint();
  const scope = gitGraphScope(ROOT, ROOT);
  const state = createGitGraphCursorState([OID, PARENT], fingerprint, scope);
  const changes = [
    { offset: -1 },
    { offset: 0.5 },
    { offset: GIT_GRAPH_MAX_HISTORY },
    { expiresAt: Date.now() - 1 },
    { expiresAt: Date.now() + GIT_GRAPH_CURSOR_TTL_MS + 10_000 },
    { roots: [] },
    { roots: [OID, OID] },
    { roots: ["--all"] },
    {
      roots: Array.from({ length: GIT_GRAPH_MAX_ROOTS + 1 }, (_, index) =>
        index.toString(16).padStart(40, "0"),
      ),
    },
    { branchOid: "c".repeat(40) },
    { version: 2 as 1 },
  ];
  for (const change of changes) {
    const token = encodeGitGraphCursor({ ...state, ...change });
    assert.throws(() => decodeGitGraphCursor(token, fingerprint, scope), issue("invalid-cursor"));
  }
  const token = encodeGitGraphCursor(state);
  assert.throws(
    () => decodeGitGraphCursor(token, fingerprint, gitGraphScope(ROOT, "C:/other-root")),
    issue("invalid-cursor"),
  );
  assert.equal(gitGraphQueryFingerprint({}), fingerprint);
  assert.equal(gitGraphQueryFingerprint({ search: { value: "", mode: "literal" } }), fingerprint);
});

test("batch scan crosses boundaries and fails explicitly on history/ref/output resource bounds", async () => {
  const manyRecords = Array.from(
    { length: 405 },
    (_, index) =>
      [
        index.toString(16).padStart(40, "0"),
        "",
        "Synthetic",
        "synthetic@example.invalid",
        "1700000000",
        index === 404 ? "deep final" : `filler ${index}`,
        "",
        "",
      ].join("\0") + "\0",
  );
  const { service, commands } = syntheticProvider((command) => {
    if (command.args[0] !== "log") return undefined;
    const skip = Number(command.args.find((arg) => arg.startsWith("--skip="))?.slice(7) ?? 0);
    const count = Number(
      command.args.find((arg) => arg.startsWith("--max-count="))?.slice(12) ?? 0,
    );
    return result(command, manyRecords.slice(skip, skip + count).join("\n"));
  });
  const page = await service.getCommitGraph({
    workspacePath: ROOT,
    filters: { search: { value: "deep final", mode: "literal" } },
  });
  assert.equal(page.commits[0]?.subject, "deep final");
  assert.equal(commands.filter((command) => command.args[0] === "log").length, 3);
  assert.ok(commands.every((command) => !command.args.includes("--all")));
  const budget = createGitGraphBudget(Date.now() - 20_000);
  assert.throws(() => budget.remainingMs(), issue("query-timeout"));
  await assert.rejects(
    service.getCommitGraph({ workspacePath: ROOT, skip: GIT_GRAPH_MAX_HISTORY + 1 }),
    issue("query-timeout"),
  );
  const limited = syntheticProvider((command) => {
    if (command.args[0] !== "for-each-ref") return undefined;
    const refs = Array.from(
      { length: GIT_GRAPH_MAX_ROOTS + 1 },
      (_, index) =>
        `refs/heads/b${index}\0${index.toString(16).padStart(40, "0")}\0commit\0\0\0\0\n`,
    ).join("");
    return result(command, refs);
  });
  await assert.rejects(
    limited.service.getCommitGraph({ workspacePath: ROOT }),
    issue("query-timeout"),
  );
  await assert.rejects(
    limited.service.getCommitGraphFilterOptions({ workspacePath: ROOT }),
    issue("query-timeout"),
  );
});

test("truncated or delimiter-corrupted records cannot become a partial successful graph", () => {
  assert.throws(() => parseGitGraphRecords(`${OID}\0parent\0author`), issue("query-timeout"));
  const invalid =
    [
      OID,
      "not-an-oid",
      "Synthetic",
      "synthetic@example.invalid",
      "1700000000",
      "title",
      "",
      "body",
    ].join("\0") + "\0";
  assert.throws(() => parseGitGraphRecords(invalid), issue("query-timeout"));
});

test("legal legacy maxCount/skip still normalize to default, floor, non-negative and page cap", async () => {
  const { service } = syntheticProvider();
  assert.equal((await service.getCommitGraph({ workspacePath: ROOT })).commits.length, 2);
  assert.equal(
    (await service.getCommitGraph({ workspacePath: ROOT, maxCount: 1.9, skip: -2 })).commits.length,
    1,
  );
  assert.equal(
    (await service.getCommitGraph({ workspacePath: ROOT, maxCount: -10 })).commits.length,
    1,
  );
  assert.deepEqual(
    (await service.getCommitGraph({ workspacePath: ROOT, maxCount: 999, skip: 1.9 })).commits.map(
      (entry) => entry.hash,
    ),
    [PARENT],
  );
});
