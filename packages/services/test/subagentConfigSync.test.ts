import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ConfigSyncError } from "../src/config-sync/types.js";
import { GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY } from "../src/github/githubAuth.js";
import { setDataBaseDir } from "../src/paths.js";
import {
  resolveSubagentStateFile,
  resolveUserSubagentRoot,
  resolveWorkspaceSubagentRoot,
} from "../src/subagents/subagentStorage.js";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

const GIST_DESCRIPTION = "zcode-subagents-config-sync";

function agentMarkdown(name: string, body = "Do the thing."): string {
  return ["---", `name: ${name}`, `description: ${name} agent`, "---", body, ""].join("\n");
}

interface FakeGistRecord {
  readonly id: string;
  description: string;
  readonly files: Map<string, string>;
}

interface FakeRequest {
  readonly method: string;
  readonly path: string;
  readonly body?: Record<string, unknown>;
}

/**
 * 按真实 GitHub 的契约解析请求体里的 `files`：每个值必须是 `{ content: string }`，或 `null`（删除标记）。
 * 形状不符返回 null，调用方回 422。
 *
 * 假服务器原先直接把裸字符串当内容收下，比真 GitHub 宽松，于是「上传请求体形状不对」在本地一直测不出来。
 */
function parseGistFiles(raw: unknown): Map<string, string | null> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const files = new Map<string, string | null>();
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (name.length === 0) return null;
    if (entry === null) {
      files.set(name, null);
      continue;
    }
    if (typeof entry !== "object" || Array.isArray(entry)) return null;
    const keys = Object.keys(entry);
    const content = (entry as { content?: unknown }).content;
    if (keys.length !== 1 || keys[0] !== "content" || typeof content !== "string") return null;
    files.set(name, content);
  }
  return files;
}

/** 真实 GitHub 对形状不符的 `files` 返回 422。 */
function rejectedFiles(): Response {
  return Response.json(
    {
      message: "Validation Failed",
      errors: [{ resource: "Gist", field: "files", code: "invalid" }],
    },
    { status: 422 },
  );
}

/**
 * 内存版 GitHub gist API：只实现本改动用到的 4 个路由，并把请求记录下来供断言。
 * 支持注入 HTTP 失败、网络异常与「挂住请求」三种故障，用来覆盖并发与失败语义。
 */
function createFakeGithub() {
  const gists = new Map<string, FakeGistRecord>();
  const requests: FakeRequest[] = [];
  let counter = 0;
  let failure: { status: number; headers?: Record<string, string> } | null = null;
  let networkError: Error | null = null;
  let gate: Promise<void> | null = null;

  const toJson = (gist: FakeGistRecord, withContent: boolean) => ({
    id: gist.id,
    html_url: `https://gist.github.com/${gist.id}`,
    description: gist.description,
    updated_at: "2026-10-17T00:00:00.000Z",
    files: Object.fromEntries(
      [...gist.files].map(([name, content]) => [
        name,
        withContent ? { content, truncated: false } : { filename: name },
      ]),
    ),
  });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace("https://api.github.com", "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    requests.push({ method, path, ...(body ? { body } : {}) });
    if (gate) await gate;
    if (networkError) throw networkError;
    if (failure) {
      return new Response(null, { status: failure.status, headers: failure.headers ?? {} });
    }
    if (method === "POST" && path === "/gists") {
      const files = parseGistFiles(body?.files);
      if (!files) return rejectedFiles();
      counter += 1;
      const gist: FakeGistRecord = {
        id: `gist${counter}`,
        description: typeof body?.description === "string" ? body.description : "",
        files: new Map([...files].filter((entry): entry is [string, string] => entry[1] !== null)),
      };
      gists.set(gist.id, gist);
      return Response.json(toJson(gist, true), { status: 201 });
    }
    if (method === "PATCH" && path.startsWith("/gists/")) {
      const gist = gists.get(path.slice("/gists/".length));
      if (!gist) return new Response(null, { status: 404 });
      const files = parseGistFiles(body?.files);
      if (!files) return rejectedFiles();
      for (const [name, content] of files) {
        if (content === null) gist.files.delete(name);
        else gist.files.set(name, content);
      }
      return Response.json(toJson(gist, true));
    }
    if (method === "GET" && path === "/gists?per_page=100") {
      return Response.json([...gists.values()].map((gist) => toJson(gist, false)));
    }
    if (method === "GET" && path.startsWith("/gists/")) {
      const gist = gists.get(path.slice("/gists/".length));
      if (!gist) return new Response(null, { status: 404 });
      return Response.json(toJson(gist, true));
    }
    return new Response(null, { status: 404 });
  };

  return {
    fetchImpl,
    requests,
    gists,
    setFailure: (next: { status: number; headers?: Record<string, string> } | null) => {
      failure = next;
    },
    setNetworkError: (next: Error | null) => {
      networkError = next;
    },
    setGate: (next: Promise<void> | null) => {
      gate = next;
    },
    gistFile: (gistId: string, fileName: string) => gists.get(gistId)?.files.get(fileName),
    // 测试里访问 gist 前都应已经建成功；缺失直接抛错，比返回 undefined 让断言空转更可靠。
    onlyGist: () => {
      const [gist] = [...gists.values()];
      if (!gist) throw new Error("测试期望已创建 gist，但实际不存在");
      return gist;
    },
  };
}

/**
 * 隔离两层路径：
 * - `homeDir` 决定子智能体自身存储（agents 目录 / agents-state.json）；
 * - `setDataBaseDir` 决定同步元数据与备份（跟随设置里的数据存储路径）。
 * 两者都必须指向临时目录，否则测试会写进真实 `~/.zcode`。
 */
async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "zcode-subagent-sync-"));
  setDataBaseDir(home);
  try {
    return await run(home);
  } finally {
    setDataBaseDir(null);
    await rm(home, { recursive: true, force: true });
  }
}

async function writeLocalAgent(home: string, name: string, content: string): Promise<void> {
  const agentsRoot = await resolveUserSubagentRoot({ homeDir: home });
  await mkdir(agentsRoot, { recursive: true });
  await writeFile(join(agentsRoot, `${name}.md`), content, "utf-8");
}

/** 真实环境里 agents-state.json 一定存在（迁移会建它），备份完整性判定依赖这一点。 */
async function writeLocalState(home: string, state: Record<string, unknown> = {}): Promise<void> {
  const stateFile = await resolveSubagentStateFile({ homeDir: home });
  await mkdir(join(stateFile, ".."), { recursive: true });
  await writeFile(stateFile, JSON.stringify(state), "utf-8");
}

async function readLocalAgent(home: string, name: string): Promise<string> {
  return readFile(join(await resolveUserSubagentRoot({ homeDir: home }), `${name}.md`), "utf-8");
}

/** 项目级 agent 落在 `<workspace>/.zcode/agents`。 */
async function writeWorkspaceAgent(
  workspacePath: string,
  name: string,
  content: string,
): Promise<void> {
  const agentsRoot = resolveWorkspaceSubagentRoot(workspacePath);
  await mkdir(agentsRoot, { recursive: true });
  await writeFile(join(agentsRoot, `${name}.md`), content, "utf-8");
}

async function readWorkspaceAgent(workspacePath: string, name: string): Promise<string> {
  return readFile(join(resolveWorkspaceSubagentRoot(workspacePath), `${name}.md`), "utf-8");
}

function createService(
  home: string,
  github: ReturnType<typeof createFakeGithub>,
  token: string | null = "gho_token",
) {
  return createSubagentsService({
    homeDir: home,
    credentialService: {
      load: async (key: string) => (key === GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY ? token : null),
      // config-sync 的凭据端口已放宽为 load/save/delete；本测试只关心旧 key 读取。
      save: async () => {},
      delete: async () => {},
    },
    fetchImpl: github.fetchImpl,
  });
}

function expectError<T>(result: T | { status: "error"; error: ConfigSyncError }): ConfigSyncError {
  assert.ok(
    typeof result === "object" &&
      result !== null &&
      "status" in result &&
      result.status === "error",
    `期望错误结果，实际：${JSON.stringify(result)}`,
  );
  return (result as { status: "error"; error: ConfigSyncError }).error;
}

test("未登录：不发任何网络请求", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeLocalAgent(home, "reviewer", agentMarkdown("reviewer"));
    const service = createService(home, github, null);

    const error = expectError(await service.syncConfigToGist());
    assert.equal(error.code, "not_authenticated");
    assert.equal(github.requests.length, 0);
    const status = await service.getConfigSyncStatus();
    assert.equal(status.connected, false);
    assert.equal(status.localItemCount, 1);
  });
});

test("首次上传：创建私有 gist，revision=1，写回元数据", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeLocalAgent(home, "reviewer", agentMarkdown("reviewer"));
    await writeLocalAgent(home, "diagnostician", agentMarkdown("diagnostician"));
    const service = createService(home, github);

    const result = await service.syncConfigToGist();
    assert.equal(result.status, "ok");
    assert.ok(result.status === "ok");
    assert.equal(result.itemCount, 2);
    assert.equal(result.remoteRevision, 1);

    const createRequest = github.requests.find((request) => request.method === "POST");
    assert.equal(createRequest?.path, "/gists");
    assert.equal(createRequest?.body?.public, false);
    assert.equal(createRequest?.body?.description, GIST_DESCRIPTION);
    assert.deepEqual(Object.keys(createRequest?.body?.files ?? {}).sort(), [
      "agent.diagnostician.md",
      "agent.reviewer.md",
      "manifest.json",
      "state.json",
    ]);
    assert.equal(
      github.gistFile(github.onlyGist().id, "manifest.json")?.includes('"revision": 1'),
      true,
    );

    const status = await service.getConfigSyncStatus();
    assert.equal(status.connected, true);
    assert.equal(status.lastRemoteRevision, 1);
    assert.equal(status.localChangedSinceLastSync, false);
    assert.equal(status.gistIdShort, github.onlyGist().id.slice(0, 8));
  });
});

test("本地未变化再上传：返回 unchanged 且零网络请求", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeLocalAgent(home, "reviewer", agentMarkdown("reviewer"));
    const service = createService(home, github);
    await service.syncConfigToGist();
    const requestsAfterFirstUpload = github.requests.length;

    const result = await service.syncConfigToGist();
    assert.equal(result.status, "unchanged");
    assert.equal(github.requests.length, requestsAfterFirstUpload);
  });
});

test("本地改动再上传：PATCH 同一 gist，revision+1，远端已删的 agent 传 null", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeLocalAgent(home, "reviewer", agentMarkdown("reviewer"));
    await writeLocalAgent(home, "gone", agentMarkdown("gone"));
    const service = createService(home, github);
    const first = await service.syncConfigToGist();
    assert.equal(first.status, "ok");

    await rm(join(await resolveUserSubagentRoot({ homeDir: home }), "gone.md"));
    await writeLocalAgent(home, "reviewer", agentMarkdown("reviewer", "Updated body."));

    const second = await service.syncConfigToGist();
    assert.equal(second.status, "ok");
    assert.ok(second.status === "ok");
    assert.equal(second.remoteRevision, 2);
    const patch = github.requests.filter((request) => request.method === "PATCH").at(-1);
    assert.equal(patch?.path, `/gists/${github.onlyGist().id}`);
    const files = patch?.body?.files as Record<string, { content: string } | null>;
    assert.equal(files["agent.gone.md"], null);
    assert.match(files["agent.reviewer.md"]?.content ?? "", /Updated body\./);
    assert.equal(github.onlyGist().files.has("agent.gone.md"), false);
  });
});

test("新机器无元数据：按 description 发现 gist，预览为全 add，应用后本地出现文件", async () => {
  const github = createFakeGithub();
  await withHome(async (homeA) => {
    await writeLocalAgent(homeA, "reviewer", agentMarkdown("reviewer"));
    await createService(homeA, github).syncConfigToGist();
  });
  await withHome(async (homeB) => {
    const service = createService(homeB, github);
    const plan = await service.previewConfigFromGist();
    assert.equal(plan.status, "ok");
    assert.ok(plan.status === "ok");
    assert.deepEqual(
      plan.entries.map((entry) => [entry.name, entry.kind]),
      [["reviewer", "add"]],
    );

    const applied = await service.applyConfigFromGist({
      strategy: "merge",
      expectedRemoteRevision: plan.remoteRevision,
    });
    assert.equal(applied.status, "ok");
    assert.ok(applied.status === "ok");
    assert.deepEqual(applied.applied, { added: 1, updated: 0, removed: 0, kept: 0 });
    assert.match(await readLocalAgent(homeB, "reviewer"), /name: reviewer/);
  });
});

test("merge 下载：覆盖同名、保留本地独有；replace 需要显式确认", async () => {
  const github = createFakeGithub();
  await withHome(async (homeA) => {
    await writeLocalAgent(homeA, "shared", agentMarkdown("shared", "Remote body."));
    await createService(homeA, github).syncConfigToGist();
  });
  await withHome(async (homeB) => {
    await writeLocalAgent(homeB, "shared", agentMarkdown("shared", "Local body."));
    await writeLocalAgent(homeB, "local-only", agentMarkdown("local-only"));
    const service = createService(homeB, github);

    const plan = await service.previewConfigFromGist();
    assert.ok(plan.status === "ok");
    assert.deepEqual(
      plan.entries.map((entry) => [entry.name, entry.kind]),
      [
        ["local-only", "localOnly"],
        ["shared", "update"],
      ],
    );

    // replace 缺确认：拒绝且本地零变更。
    const rejected = expectError(
      await service.applyConfigFromGist({
        strategy: "replace",
        expectedRemoteRevision: plan.remoteRevision,
      }),
    );
    assert.equal(rejected.code, "unknown");
    assert.match(await readLocalAgent(homeB, "shared"), /Local body\./);
    assert.match(await readLocalAgent(homeB, "local-only"), /name: local-only/);

    const merged = await service.applyConfigFromGist({
      strategy: "merge",
      expectedRemoteRevision: plan.remoteRevision,
    });
    assert.ok(merged.status === "ok");
    assert.deepEqual(merged.applied, { added: 0, updated: 1, removed: 0, kept: 1 });
    assert.match(await readLocalAgent(homeB, "shared"), /Remote body\./);
    assert.match(await readLocalAgent(homeB, "local-only"), /name: local-only/);

    const replaced = await service.applyConfigFromGist({
      strategy: "replace",
      expectedRemoteRevision: plan.remoteRevision,
      confirmReplace: true,
    });
    assert.ok(replaced.status === "ok");
    assert.deepEqual(replaced.applied, { added: 0, updated: 0, removed: 1, kept: 0 });
    await assert.rejects(readLocalAgent(homeB, "local-only"));
  });
});

test("远端 schemaVersion 不受支持：预览即失败，本地零变更", async () => {
  const github = createFakeGithub();
  await withHome(async (home) => {
    await writeLocalAgent(home, "reviewer", agentMarkdown("reviewer"));
    const service = createService(home, github);
    await service.syncConfigToGist();

    const gist = github.onlyGist();
    const manifest = JSON.parse(gist.files.get("manifest.json") ?? "{}") as Record<string, unknown>;
    gist.files.set("manifest.json", JSON.stringify({ ...manifest, schemaVersion: 2 }));

    const error = expectError(await service.previewConfigFromGist());
    assert.equal(error.code, "remote_invalid");
    assert.match(await readLocalAgent(home, "reviewer"), /name: reviewer/);
  });
});

test("远端 md 不可解析：预览即失败", async () => {
  const github = createFakeGithub();
  await withHome(async (home) => {
    await writeLocalAgent(home, "reviewer", agentMarkdown("reviewer"));
    const service = createService(home, github);
    await service.syncConfigToGist();

    const gist = github.onlyGist();
    const content = "没有 frontmatter 的正文";
    const manifest = JSON.parse(gist.files.get("manifest.json") ?? "{}") as {
      items: { name: string; fileName: string; sha256: string; bytes: number }[];
    };
    gist.files.set("agent.reviewer.md", content);
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    manifest.items = manifest.items.map((entry) => ({ ...entry, sha256, bytes: content.length }));
    gist.files.set("manifest.json", JSON.stringify(manifest));

    const error = expectError(await service.previewConfigFromGist());
    assert.equal(error.code, "remote_invalid");
    assert.match(error.message, /agent\.reviewer\.md/);
  });
});

test("revision 与预览不一致：conflict，本地零变更", async () => {
  const github = createFakeGithub();
  await withHome(async (homeA) => {
    await writeLocalAgent(homeA, "shared", agentMarkdown("shared", "Remote body."));
    await createService(homeA, github).syncConfigToGist();
  });
  await withHome(async (homeB) => {
    await writeLocalAgent(homeB, "shared", agentMarkdown("shared", "Local body."));
    const service = createService(homeB, github);
    const error = expectError(
      await service.applyConfigFromGist({ strategy: "merge", expectedRemoteRevision: 999 }),
    );
    assert.equal(error.code, "conflict");
    assert.match(await readLocalAgent(homeB, "shared"), /Local body\./);
  });
});

test("并发：上传进行中再下载返回 busy，且只发出一次 gist 请求", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeLocalAgent(home, "reviewer", agentMarkdown("reviewer"));
    const service = createService(home, github);
    let release = () => {};
    github.setGate(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );

    const upload = service.syncConfigToGist();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const error = expectError(await service.previewConfigFromGist());
    assert.equal(error.code, "busy");
    assert.equal(github.requests.length, 1);

    release();
    assert.equal((await upload).status, "ok");
  });
});

test("网络失败：错误码为 network，文案带 cause 链 code", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeLocalAgent(home, "reviewer", agentMarkdown("reviewer"));
    const service = createService(home, github);
    github.setNetworkError(
      new Error("fetch failed", { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }),
    );

    const error = expectError(await service.syncConfigToGist());
    assert.equal(error.code, "network");
    assert.match(error.message, /UND_ERR_CONNECT_TIMEOUT/);
  });
});

test("401 / 403 缺权限 / 限流：映射到对应错误码且不删凭据", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeLocalAgent(home, "reviewer", agentMarkdown("reviewer"));
    const service = createService(home, github);

    github.setFailure({ status: 401 });
    assert.equal(expectError(await service.syncConfigToGist()).code, "unauthorized");
    // 凭据仍在：token 失效的清理入口只有 GithubAuthService。
    assert.equal((await service.getConfigSyncStatus()).connected, true);

    github.setFailure({ status: 403, headers: { "x-accepted-oauth-scopes": "gist" } });
    const scopeError = expectError(await service.syncConfigToGist());
    assert.equal(scopeError.code, "insufficient_scope");
    assert.match(scopeError.message, /gist/);

    github.setFailure({
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "retry-after": "42" },
    });
    const rateError = expectError(await service.syncConfigToGist());
    assert.equal(rateError.code, "rate_limited");
    assert.match(rateError.message, /42/);
  });
});

test("疑似密钥：先返回 secret_warning 且不回命中值，确认后才上传", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await writeLocalAgent(home, "leaky", agentMarkdown("leaky", `token: ${secret}`));
    const service = createService(home, github);

    const warning = expectError(await service.syncConfigToGist());
    assert.equal(warning.code, "secret_warning");
    assert.equal(github.requests.length, 0);
    assert.deepEqual(warning.secretWarnings, [
      { fileName: "agent.leaky.md", line: 5, pattern: "github_token" },
    ]);
    assert.equal(JSON.stringify(warning).includes(secret), false);

    const confirmed = await service.syncConfigToGist({ confirmSecretUpload: true });
    assert.equal(confirmed.status, "ok");
  });
});

test("嵌套目录与旧版 state 字段：不进快照，且被显式报出", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeLocalAgent(home, "reviewer", agentMarkdown("reviewer"));
    const agentsRoot = await resolveUserSubagentRoot({ homeDir: home });
    await mkdir(join(agentsRoot, "nested"), { recursive: true });
    await writeFile(join(agentsRoot, "nested", "inner.md"), agentMarkdown("inner"), "utf-8");
    const stateFile = await resolveSubagentStateFile({ homeDir: home });
    await mkdir(join(stateFile, ".."), { recursive: true });
    await writeFile(
      stateFile,
      JSON.stringify({
        disabledAgentIds: ["user:user:reviewer"],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
        builtInModelOverrides: { Explore: { providerId: "zai", modelId: "legacy" } },
      }),
      "utf-8",
    );

    const service = createService(home, github);
    const status = await service.getConfigSyncStatus();
    assert.equal(status.localItemCount, 1);
    assert.deepEqual(status.skippedLocalFiles, ["nested/inner.md"]);

    await service.syncConfigToGist();
    const uploadedState = github.gistFile(github.onlyGist().id, "state.json") ?? "";
    assert.match(uploadedState, /user:user:reviewer/);
    assert.equal(uploadedState.includes("builtInModelOverrides"), false);
    // 本地 state 文件里的旧版回滚字段必须原样保留（同步只合并三个精选字段）。
    assert.match(await readFile(stateFile, "utf-8"), /builtInModelOverrides/);
  });
});

test("下载应用后状态与远端一致，且再次下载为 up_to_date", async () => {
  const github = createFakeGithub();
  await withHome(async (homeA) => {
    await writeLocalAgent(homeA, "reviewer", agentMarkdown("reviewer"));
    await createService(homeA, github).syncConfigToGist();
  });
  await withHome(async (homeB) => {
    const service = createService(homeB, github);
    const plan = await service.previewConfigFromGist();
    assert.ok(plan.status === "ok");
    const applied = await service.applyConfigFromGist({
      strategy: "merge",
      expectedRemoteRevision: plan.remoteRevision,
    });
    assert.ok(applied.status === "ok");
    assert.ok(applied.backupDir);

    const again = await service.applyConfigFromGist({
      strategy: "merge",
      expectedRemoteRevision: plan.remoteRevision,
    });
    assert.equal(again.status, "up_to_date");
    const status = await service.getConfigSyncStatus();
    assert.equal(status.localChangedSinceLastSync, false);
  });
});

test("下载后可列出备份并整份还原；还原前会再备份当前状态，且不改同步元数据", async () => {
  const github = createFakeGithub();
  await withHome(async (homeA) => {
    await writeLocalAgent(homeA, "shared", agentMarkdown("shared", "Remote body."));
    await createService(homeA, github).syncConfigToGist();
  });
  await withHome(async (homeB) => {
    await writeLocalAgent(homeB, "shared", agentMarkdown("shared", "Local body."));
    await writeLocalState(homeB);
    const service = createService(homeB, github);

    const plan = await service.previewConfigFromGist();
    assert.ok(plan.status === "ok");
    const applied = await service.applyConfigFromGist({
      strategy: "merge",
      expectedRemoteRevision: plan.remoteRevision,
    });
    assert.ok(applied.status === "ok");

    // 备份落在「设置里的数据存储路径」下（`{dataBaseDir}/.zcode/v2`），1 份 = 应用前那次。
    const backups = await service.listConfigSyncBackups();
    assert.equal(backups.backupRoot, join(homeB, ".zcode", "v2", "subagents-config-sync-backup"));
    assert.equal(backups.backups.length, 1);
    assert.equal(backups.backups[0]?.itemCount, 1);
    assert.match(await readLocalAgent(homeB, "shared"), /Remote body\./);

    const restored = await service.restoreConfigSyncBackup({
      backupDir: backups.backups[0]!.backupDir,
    });
    assert.ok(restored.status === "ok");
    assert.equal(restored.itemCount, 1);
    // 本地回到下载前，并且多出一份「还原前」的安全备份。
    assert.match(await readLocalAgent(homeB, "shared"), /Local body\./);
    assert.equal((await service.listConfigSyncBackups()).backups.length, 2);

    // 元数据没被改写：本地与上次同步不一致 → 状态行会提示「本地有未上传的修改」。
    const status = await service.getConfigSyncStatus();
    assert.equal(status.localChangedSinceLastSync, true);
    assert.equal(status.backupCount, 2);
  });
});

test("还原只接受已知备份：任意路径被拒且本地零变更", async () => {
  await withHome(async (home) => {
    await writeLocalAgent(home, "reviewer", agentMarkdown("reviewer"));
    await writeLocalState(home);
    const service = createService(home, createFakeGithub());
    const error = expectError(
      await service.restoreConfigSyncBackup({ backupDir: join(home, "..", "etc") }),
    );
    assert.equal(error.code, "unknown");
    assert.match(await readLocalAgent(home, "reviewer"), /name: reviewer/);
    assert.equal((await service.listConfigSyncBackups()).backups.length, 0);
  });
});

test("项目级上传：gist 描述带项目名，远端只有该项目的 agent 且没有 state.json", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    const workspacePath = join(home, "my-project");
    await writeWorkspaceAgent(workspacePath, "reviewer", agentMarkdown("reviewer"));
    await writeLocalAgent(home, "user-agent", agentMarkdown("user-agent"));

    const service = createService(home, github);
    const result = await service.syncConfigToGist({ workspacePath });
    assert.equal(result.status, "ok");
    assert.ok(result.status === "ok");
    assert.equal(result.itemCount, 1);

    const gist = github.onlyGist();
    assert.equal(gist?.description, `${GIST_DESCRIPTION}:my-project`);
    assert.equal(gist?.files.has("agent.reviewer.md"), true);
    assert.equal(gist?.files.has("agent.user-agent.md"), false);
    // 工作区级没有 state 额外通道。
    assert.equal(gist?.files.has("state.json"), false);
    assert.equal(gist?.files.has("manifest.json"), true);
  });
});

test("状态行的作用域标签：工作区级带项目名，用户级不带", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    const workspacePath = join(home, "my-project");
    await writeWorkspaceAgent(workspacePath, "reviewer", agentMarkdown("reviewer"));

    const service = createService(home, github);
    // 标签由服务按收到的 workspacePath 推导，调用方不必自己取目录名。
    assert.equal((await service.getConfigSyncStatus({ workspacePath })).scopeLabel, "my-project");
    // 用户级没有作用域可回显，字段整个不出现（而不是空串），UI 才不会渲染出空的「项目：」。
    assert.equal("scopeLabel" in (await service.getConfigSyncStatus()), false);
  });
});

test("两个项目各自一份 gist，描述按项目名区分", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    const projectA = join(home, "project-a");
    const projectB = join(home, "project-b");
    await writeWorkspaceAgent(projectA, "alpha", agentMarkdown("alpha"));
    await writeWorkspaceAgent(projectB, "beta", agentMarkdown("beta"));

    const service = createService(home, github);
    assert.equal((await service.syncConfigToGist({ workspacePath: projectA })).status, "ok");
    assert.equal((await service.syncConfigToGist({ workspacePath: projectB })).status, "ok");

    assert.equal(github.gists.size, 2);
    assert.deepEqual(
      [...github.gists.values()].map((gist) => gist.description).sort(),
      [`${GIST_DESCRIPTION}:project-a`, `${GIST_DESCRIPTION}:project-b`],
    );
  });
});

test("项目级下载：写进项目目录，且不碰用户级 agents-state.json", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    const sourcePath = join(home, "source-project");
    await writeWorkspaceAgent(sourcePath, "reviewer", agentMarkdown("reviewer"));
    await writeLocalState(home, { disabledAgentIds: ["keep-me"] });
    assert.equal((await createService(home, github).syncConfigToGist({ workspacePath: sourcePath })).status, "ok");

    // 另一个目录但同名（模拟换机器打开同一个项目）：靠 label 找回同一份 gist。
    const targetPath = join(home, "target", "source-project");
    await mkdir(targetPath, { recursive: true });
    const service = createService(home, github);
    const plan = await service.previewConfigFromGist({ workspacePath: targetPath });
    assert.ok(plan.status === "ok");
    assert.deepEqual(
      plan.entries.map((entry) => [entry.name, entry.kind]),
      [["reviewer", "add"]],
    );
    // 项目级没有 state，变更摘要为空。
    assert.deepEqual(plan.stateChange, {
      disabledAdded: [],
      disabledRemoved: [],
      overrideKeysChanged: [],
    });

    const applied = await service.applyConfigFromGist({
      strategy: "merge",
      expectedRemoteRevision: plan.remoteRevision,
      workspacePath: targetPath,
    });
    assert.equal(applied.status, "ok");
    assert.match(await readWorkspaceAgent(targetPath, "reviewer"), /name: reviewer/);

    const state = JSON.parse(
      await readFile(await resolveSubagentStateFile({ homeDir: home }), "utf-8"),
    ) as { disabledAgentIds?: string[] };
    assert.deepEqual(state.disabledAgentIds, ["keep-me"]);
  });
});

test("项目级备份与用户级备份分目录，列表按作用域隔离", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    const workspacePath = join(home, "my-project");
    await writeWorkspaceAgent(workspacePath, "reviewer", agentMarkdown("reviewer"));
    const service = createService(home, github);
    assert.equal((await service.syncConfigToGist({ workspacePath })).status, "ok");

    // 本地改一份再下载：应用前会先备份，验证下载确实会改动项目里的文件。
    await writeWorkspaceAgent(workspacePath, "reviewer", agentMarkdown("reviewer", "local edit"));
    const plan = await service.previewConfigFromGist({ workspacePath });
    assert.ok(plan.status === "ok");
    assert.equal(
      (
        await service.applyConfigFromGist({
          strategy: "merge",
          expectedRemoteRevision: plan.remoteRevision,
          workspacePath,
        })
      ).status,
      "ok",
    );
    assert.doesNotMatch(await readWorkspaceAgent(workspacePath, "reviewer"), /local edit/);

    const workspaceBackups = await service.listConfigSyncBackups({ workspacePath });
    assert.equal(workspaceBackups.backups.length, 1);
    assert.equal(
      workspaceBackups.backupRoot.endsWith(join("subagents-config-sync-backup", "ws-my-project")),
      true,
    );

    const userBackups = await service.listConfigSyncBackups();
    assert.equal(userBackups.backups.length, 0);
  });
});
