import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { getGitCommandEnv } from "../src/git/config.js";
import { createGitService } from "../src/git/gitService.js";

const execute = promisify(execFile);
const AUTHOR_TIME = 1_700_000_000;

async function withRepository(run: (value: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-graph-test-"));
  try {
    await run(await fixture(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function fixture(directory: string) {
  async function git(args: string[], overrides: NodeJS.ProcessEnv = {}) {
    const result = await execute("git", args, {
      cwd: directory,
      env: {
        ...getGitCommandEnv(),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(directory, "no-global-config"),
        GIT_AUTHOR_NAME: "Graph Tester",
        GIT_AUTHOR_EMAIL: "graph@example.invalid",
        GIT_COMMITTER_NAME: "Graph Committer",
        GIT_COMMITTER_EMAIL: "committer@example.invalid",
        GIT_AUTHOR_DATE: `@${AUTHOR_TIME} +0000`,
        GIT_COMMITTER_DATE: "@1800000000 +0000",
        ...overrides,
      },
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return result.stdout.trim();
  }
  await git(["init", "--quiet", "--initial-branch=main"]);
  const tree = await git(["write-tree"]);
  async function commit(input: {
    subject: string;
    body?: string;
    parents?: string[];
    name?: string;
    email?: string;
    at?: number;
  }) {
    return await git(
      [
        "commit-tree",
        tree,
        ...(input.parents ?? []).flatMap((parent) => ["-p", parent]),
        "-m",
        input.subject,
        ...(input.body ? ["-m", input.body] : []),
      ],
      {
        GIT_AUTHOR_NAME: input.name ?? "Graph Tester",
        GIT_AUTHOR_EMAIL: input.email ?? "graph@example.invalid",
        GIT_AUTHOR_DATE: `@${input.at ?? AUTHOR_TIME} +0000`,
      },
    );
  }
  return { directory, git, commit, service: createGitService() };
}

test("visible history, full branch refs, merge parents and raw author options share one boundary", async () => {
  await withRepository(async ({ directory, git, commit, service }) => {
    const base = await commit({ subject: "base", name: "Same Name", email: "one@example.invalid" });
    const main = await commit({ subject: "main", parents: [base] });
    const feature = await commit({
      subject: "feature",
      parents: [base],
      name: "Same Name",
      email: "two@example.invalid",
    });
    const merge = await commit({ subject: "merge", parents: [main, feature] });
    const remote = await commit({ subject: "remote only", name: "Remote Author" });
    const tagged = await commit({ subject: "tag only", name: "Tag Author" });
    const hidden = await commit({ subject: "hidden", name: "Hidden Author" });
    await git(["update-ref", "refs/heads/main", merge]);
    await git(["update-ref", "refs/heads/feature/foo", feature]);
    await git(["update-ref", "refs/remotes/origin/main", remote]);
    await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await git(["tag", "-a", "visible-tag", "-m", "tag", tagged]);
    await git(["update-ref", "refs/zcode/checkpoints/test", hidden]);
    await writeFile(
      join(directory, ".mailmap"),
      "Mapped <mapped@example.invalid> Same Name <one@example.invalid>\n",
    );
    await git(["config", "log.mailmap", "true"]);

    const all = await service.getCommitGraph({ workspacePath: directory, maxCount: 200 });
    assert.deepEqual(
      new Set(all.commits.map((entry) => entry.hash)),
      new Set([base, main, feature, merge, remote, tagged]),
    );
    assert.equal(all.hasMore, false);
    assert.deepEqual(all.commits.find((entry) => entry.hash === merge)?.parents, [main, feature]);
    assert.ok(
      all.commits
        .find((entry) => entry.hash === merge)
        ?.refs.some((ref) => ref.name === "HEAD" && ref.kind === "head"),
    );
    assert.ok(
      all.commits
        .find((entry) => entry.hash === feature)
        ?.refs.some((ref) => ref.name === "feature/foo" && ref.kind === "branch"),
    );
    assert.ok(
      all.commits
        .find((entry) => entry.hash === remote)
        ?.refs.some((ref) => ref.name === "origin/main" && ref.kind === "remote"),
    );
    assert.ok(
      all.commits.every((entry) => entry.refs.every((ref) => !ref.name.includes("checkpoints"))),
    );

    const branch = await service.getCommitGraph({
      workspacePath: directory,
      filters: { branchRef: "refs/heads/feature/foo" },
    });
    assert.deepEqual(new Set(branch.commits.map((entry) => entry.hash)), new Set([base, feature]));
    const remoteBranch = await service.getCommitGraph({
      workspacePath: directory,
      filters: { branchRef: "refs/remotes/origin/main" },
    });
    assert.deepEqual(
      remoteBranch.commits.map((entry) => entry.hash),
      [remote],
    );

    const options = await service.getCommitGraphFilterOptions({ workspacePath: directory });
    assert.ok(
      options.branches.some(
        (entry) => entry.ref === "refs/heads/feature/foo" && entry.kind === "branch",
      ),
    );
    assert.ok(
      options.branches.some(
        (entry) => entry.ref === "refs/remotes/origin/main" && entry.kind === "remote",
      ),
    );
    assert.ok(!options.branches.some((entry) => entry.ref === "refs/remotes/origin/HEAD"));
    assert.ok(
      options.authors.some(
        (entry) => entry.name === "Same Name" && entry.email === "one@example.invalid",
      ),
    );
    assert.ok(
      options.authors.some(
        (entry) => entry.name === "Same Name" && entry.email === "two@example.invalid",
      ),
    );
    assert.ok(
      !options.authors.some((entry) => entry.name === "Mapped" || entry.name === "Hidden Author"),
    );
    assert.equal(
      all.commits.find((entry) => entry.hash === base)?.authorEmail,
      "one@example.invalid",
    );

    const firstPage = await service.getCommitGraph({ workspacePath: directory, maxCount: 2 });
    assert.ok(firstPage.cursor);
    const movedMain = await commit({ subject: "moved main", parents: [merge] });
    await git(["update-ref", "refs/heads/main", movedMain]);
    await git(["update-ref", "refs/remotes/origin/main", hidden]);
    await git(["update-ref", "-d", "refs/tags/visible-tag"]);
    const paged = [...firstPage.commits];
    let cursor: string | undefined = firstPage.cursor;
    while (cursor) {
      const page = await service.getCommitGraph({ workspacePath: directory, maxCount: 2, cursor });
      paged.push(...page.commits);
      cursor = page.cursor;
    }
    assert.deepEqual(
      paged.map((entry) => entry.hash),
      all.commits.map((entry) => entry.hash),
    );
    await git(["checkout", "--quiet", "--detach", feature]);
    const detached = await service.getCommitGraph({ workspacePath: directory });
    assert.ok(
      detached.commits
        .find((entry) => entry.hash === feature)
        ?.refs.some((ref) => ref.name === "HEAD" && ref.kind === "head"),
    );
  });
});

test("empty author email remains selectable by its exact history identity", async () => {
  await withRepository(async ({ directory, git, commit, service }) => {
    const hash = await commit({ subject: "empty email commit", name: "Empty Email", email: "" });
    await git(["update-ref", "refs/heads/main", hash]);
    const options = await service.getCommitGraphFilterOptions({ workspacePath: directory });
    const author = options.authors.find(
      (entry) => entry.name === "Empty Email" && entry.email === "",
    );
    assert.ok(author);
    const filtered = await service.getCommitGraph({
      workspacePath: directory,
      filters: { author },
    });
    assert.deepEqual(
      filtered.commits.map((entry) => entry.hash),
      [hash],
    );
  });
});

test("text or hash OR combines with exact author, branch and non-monotonic author-date AND", async () => {
  await withRepository(async ({ directory, git, commit, service }) => {
    const target = await commit({
      subject: "[Needle]. Title",
      body: "Body TOKEN α\nsentinel\u001einside",
      name: "Case Author",
      email: "case@example.invalid",
    });
    const older = await commit({
      subject: "new tip with old author date",
      parents: [target],
      at: 1_000_000_000,
    });
    await git(["update-ref", "refs/heads/main", older]);
    const request = { workspacePath: directory };
    const literal = await service.getCommitGraph({
      ...request,
      filters: { search: { value: "[needle].", mode: "literal" } },
    });
    assert.deepEqual(
      literal.commits.map((entry) => entry.hash),
      [target],
    );
    const body = await service.getCommitGraph({
      ...request,
      filters: { search: { value: "sentinel\u001einside", mode: "literal" } },
    });
    assert.deepEqual(
      body.commits.map((entry) => entry.hash),
      [target],
    );
    const regex = await service.getCommitGraph({
      ...request,
      filters: { search: { value: "BODY.*α", mode: "regex" } },
    });
    assert.deepEqual(
      regex.commits.map((entry) => entry.hash),
      [target],
    );
    const unicodeRegex = await service.getCommitGraph({
      ...request,
      filters: { search: { value: "\\p{L}+.*α", mode: "regex" } },
    });
    assert.deepEqual(
      unicodeRegex.commits.map((entry) => entry.hash),
      [target],
    );
    const sensitiveRegex = await service.getCommitGraph({
      ...request,
      filters: { search: { value: "BODY", mode: "regex", caseSensitive: true } },
    });
    assert.deepEqual(sensitiveRegex.commits, []);
    const sensitive = await service.getCommitGraph({
      ...request,
      filters: { search: { value: "BODY", mode: "literal", caseSensitive: true } },
    });
    assert.deepEqual(sensitive.commits, []);
    const hash = await service.getCommitGraph({
      ...request,
      filters: { search: { value: target.slice(0, 14).toUpperCase(), mode: "literal" } },
    });
    assert.deepEqual(
      hash.commits.map((entry) => entry.hash),
      [target],
    );
    const separated = await service.getCommitGraph({
      ...request,
      filters: { search: { value: "Title\\nBody", mode: "regex" } },
    });
    assert.deepEqual(separated.commits, []);
    const combined = await service.getCommitGraph({
      ...request,
      filters: {
        search: { value: "TOKEN", mode: "literal" },
        branchRef: "refs/heads/main",
        author: { name: "Case Author", email: "case@example.invalid" },
        date: { fromMs: AUTHOR_TIME * 1000, toMs: (AUTHOR_TIME + 1) * 1000 },
      },
    });
    assert.deepEqual(
      combined.commits.map((entry) => entry.hash),
      [target],
    );
    const beforeBoundary = await service.getCommitGraph({
      ...request,
      filters: { date: { toMs: AUTHOR_TIME * 1000 } },
    });
    assert.deepEqual(
      beforeBoundary.commits.map((entry) => entry.hash),
      [older],
    );
    const wrongIdentity = await service.getCommitGraph({
      ...request,
      filters: { author: { name: "Case Author", email: "other@example.invalid" } },
    });
    assert.deepEqual(wrongIdentity.commits, []);
  });
});

test("deep sparse matches paginate without losing lookahead and pin roots across ref changes", async () => {
  await withRepository(async ({ directory, git, commit, service }) => {
    const matches: string[] = [];
    let tip: string | undefined;
    for (let index = 0; index < 140; index += 1) {
      const matching = index % 65 === 0;
      tip = await commit({
        subject: matching ? `deep needle ${index}` : `filler ${index}`,
        parents: tip ? [tip] : [],
        name: index === 0 ? "Rare Old Author" : "Graph Tester",
        at: AUTHOR_TIME + index,
      });
      if (matching) matches.unshift(tip);
    }
    assert.ok(tip);
    await git(["update-ref", "refs/heads/main", tip]);
    const request = {
      workspacePath: directory,
      workspaceIdentity: "remote-graph-fixture",
      maxCount: 1,
      filters: {
        branchRef: "refs/heads/main",
        search: { value: "deep needle", mode: "literal" as const },
      },
    };
    const first = await service.getCommitGraph(request);
    assert.deepEqual(
      first.commits.map((entry) => entry.hash),
      matches.slice(0, 1),
    );
    assert.equal(first.hasMore, true);
    assert.ok(first.cursor);
    const skipped = await service.getCommitGraph({ ...request, skip: 1 });
    assert.deepEqual(
      skipped.commits.map((entry) => entry.hash),
      matches.slice(1, 2),
    );
    const legacy = await service.getCommitGraph({ workspacePath: directory, maxCount: 2, skip: 1 });
    assert.equal(legacy.commits.length, 2);
    assert.notEqual(legacy.commits[0]?.hash, tip);
    const oldestOnly = await service.getCommitGraph({
      workspacePath: directory,
      maxCount: 1,
      filters: { search: { value: "deep needle 0", mode: "literal" } },
    });
    assert.deepEqual(
      oldestOnly.commits.map((entry) => entry.hash),
      matches.slice(2),
    );
    assert.equal(oldestOnly.hasMore, false);

    const moved = await commit({
      subject: "deep needle newly added",
      parents: [tip],
      at: AUTHOR_TIME + 200,
    });
    await git(["update-ref", "refs/heads/main", moved]);
    const anotherRoot = await commit({ subject: "deep needle new unrelated root" });
    await git(["update-ref", "refs/heads/another", anotherRoot]);
    const second = await service.getCommitGraph({ ...request, cursor: first.cursor });
    assert.deepEqual(
      second.commits.map((entry) => entry.hash),
      matches.slice(1, 2),
    );
    assert.ok(second.cursor);
    const third = await service.getCommitGraph({ ...request, cursor: second.cursor });
    assert.deepEqual(
      third.commits.map((entry) => entry.hash),
      matches.slice(2),
    );
    assert.equal(third.hasMore, false);
    assert.equal(third.cursor, undefined);
    const options = await service.getCommitGraphFilterOptions({ workspacePath: directory });
    assert.ok(options.authors.some((entry) => entry.name === "Rare Old Author"));
  });
});

test("unborn HEAD does not hide other refs, and a truly empty repository remains empty", async () => {
  await withRepository(async ({ directory, git, commit, service }) => {
    const stored = await commit({ subject: "stored branch" });
    await git(["update-ref", "refs/heads/stored", stored]);
    await git(["symbolic-ref", "HEAD", "refs/heads/unborn"]);
    const graph = await service.getCommitGraph({ workspacePath: directory });
    assert.deepEqual(
      graph.commits.map((entry) => entry.hash),
      [stored],
    );
  });
  await withRepository(async ({ directory, service }) => {
    assert.deepEqual((await service.getCommitGraph({ workspacePath: directory })).commits, []);
    assert.deepEqual(await service.getCommitGraphFilterOptions({ workspacePath: directory }), {
      branches: [],
      authors: [],
    });
  });
});
