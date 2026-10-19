import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY } from "../src/github/githubAuth.js";
import { createMcpSyncService } from "../src/mcp-sync/mcpSyncService.js";
import { setDataBaseDir } from "../src/paths.js";

/**
 * MCP 配置同步的服务层测试：MCP 用户目录由 HOME 决定（服务内部即按 HOME 解析路径），
 * 因此这里临时改写 HOME，把 `~/.zcode/cli/config.json` 与 `~/.agents/mcp.json` 放进临时目录。
 */

const GIST_DESCRIPTION = "zcode-mcp-config-sync";

function serverConfig(url: string, extra: Record<string, unknown> = {}) {
  return { command: "npx", args: ["-y", url], ...extra };
}

interface FakeGist {
  readonly id: string;
  description: string;
  readonly files: Map<string, string>;
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

function createFakeGithub() {
  const gists = new Map<string, FakeGist>();
  const requests: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let counter = 0;
  let failure: { status: number; headers?: Record<string, string> } | null = null;

  const toJson = (gist: FakeGist, withContent: boolean) => ({
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
    if (failure)
      return new Response(null, { status: failure.status, headers: failure.headers ?? {} });
    if (method === "POST" && path === "/gists") {
      const files = parseGistFiles(body?.files);
      if (!files) return rejectedFiles();
      counter += 1;
      const gist: FakeGist = {
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
    onlyGist: () => [...gists.values()][0],
    setFailure: (next: { status: number; headers?: Record<string, string> } | null) => {
      failure = next;
    },
  };
}

/**
 * 隔离两层路径：`HOME` 决定 MCP 用户配置位置，`setDataBaseDir` 决定同步元数据与备份位置
 * （跟随设置里的数据存储路径）。两者都要指向临时目录，否则测试会写进真实 `~/.zcode`。
 */
async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "zcode-mcp-sync-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  setDataBaseDir(home);
  try {
    return await run(home);
  } finally {
    setDataBaseDir(null);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  }
}

async function writeZcodeServers(home: string, servers: Record<string, unknown>): Promise<string> {
  const filePath = join(home, ".zcode", "cli", "config.json");
  await mkdir(join(home, ".zcode", "cli"), { recursive: true });
  await writeFile(filePath, JSON.stringify({ mcp: { servers } }, null, 2), "utf-8");
  return filePath;
}

async function writeAgentsServers(home: string, servers: Record<string, unknown>): Promise<void> {
  await mkdir(join(home, ".agents"), { recursive: true });
  await writeFile(
    join(home, ".agents", "mcp.json"),
    JSON.stringify({ mcpServers: servers }),
    "utf-8",
  );
}

async function readZcodeServers(home: string): Promise<Record<string, Record<string, unknown>>> {
  const raw = await readFile(join(home, ".zcode", "cli", "config.json"), "utf-8");
  const parsed = JSON.parse(raw) as { mcp?: { servers?: Record<string, Record<string, unknown>> } };
  return parsed.mcp?.servers ?? {};
}

function createService(
  github: ReturnType<typeof createFakeGithub>,
  token: string | null = "gho_token",
) {
  return createMcpSyncService({
    credentialService: {
      load: async (key: string) => (key === GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY ? token : null),
    },
    fetchImpl: github.fetchImpl,
  });
}

function expectError<T>(result: T | { status: "error"; error: { code: string; message: string } }) {
  assert.ok(
    typeof result === "object" &&
      result !== null &&
      "status" in result &&
      result.status === "error",
    `期望错误结果，实际：${JSON.stringify(result)}`,
  );
  return (result as { status: "error"; error: { code: string; message: string } }).error;
}

test("未登录：不发任何网络请求", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeZcodeServers(home, { alpha: serverConfig("alpha") });
    const service = createService(github, null);

    assert.equal(expectError(await service.syncConfigToGist()).code, "not_authenticated");
    assert.equal(github.requests.length, 0);
    const status = await service.getConfigSyncStatus();
    assert.equal(status.connected, false);
    assert.equal(status.localItemCount, 1);
  });
});

test("首次上传：创建私有 gist，文件名对含空格/中文的 server 名做转义", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeZcodeServers(home, {
      alpha: serverConfig("alpha"),
      "my server 中文": serverConfig("beta"),
    });
    const service = createService(github);

    const result = await service.syncConfigToGist();
    assert.equal(result.status, "ok");
    assert.ok(result.status === "ok");
    assert.equal(result.itemCount, 2);
    assert.equal(result.remoteRevision, 1);

    const createRequest = github.requests.find((request) => request.method === "POST");
    assert.equal(createRequest?.body?.public, false);
    assert.equal(createRequest?.body?.description, GIST_DESCRIPTION);
    // 只转义会破坏文件名语义的字符（`% \ / ` 与控制字符），空格与中文原样保留以便在 gist 里可读。
    assert.deepEqual(Object.keys(createRequest?.body?.files ?? {}).sort(), [
      "manifest.json",
      "server.alpha.json",
      "server.my server 中文.json",
    ]);
    const uploaded = JSON.parse(github.onlyGist().files.get("server.alpha.json") ?? "{}") as Record<
      string,
      unknown
    >;
    // enabled 归一化后写进配置对象（与既有文件约定一致）。
    assert.equal(uploaded.enabled, true);
    assert.equal(uploaded.command, "npx");
  });
});

test("本地未变化再上传：unchanged 且零网络请求；改配置后 revision+1 并删除远端多余 server", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeZcodeServers(home, {
      alpha: serverConfig("alpha"),
      gone: serverConfig("gone"),
    });
    const service = createService(github);
    await service.syncConfigToGist();
    const afterFirst = github.requests.length;
    assert.equal((await service.syncConfigToGist()).status, "unchanged");
    assert.equal(github.requests.length, afterFirst);

    // 删掉一个、改一个。
    await writeZcodeServers(home, {
      alpha: serverConfig("alpha", { env: { TOKEN: "x" } }),
    });
    const second = await service.syncConfigToGist();
    assert.ok(second.status === "ok");
    assert.equal(second.remoteRevision, 2);
    const patch = github.requests.filter((request) => request.method === "PATCH").at(-1);
    const files = patch?.body?.files as Record<string, { content: string } | null>;
    assert.equal(files["server.gone.json"], null);
    assert.equal(github.onlyGist().files.has("server.gone.json"), false);
  });
});

test("从 agents 目录回退读取：上传包含这些 server，写回后不丢失", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeAgentsServers(home, { fromAgents: serverConfig("agents") });
    const service = createService(github);

    assert.equal((await service.getConfigSyncStatus()).localItemCount, 1);
    const plan = await service.previewConfigFromGist();
    assert.equal(expectError(plan).code, "not_found");
    assert.equal((await service.syncConfigToGist()).status, "ok");
    assert.equal(github.onlyGist().files.has("server.fromAgents.json"), true);
  });
});

test("merge 下载：远端覆盖同名、本地独有保留；replace 需显式确认", async () => {
  const github = createFakeGithub();
  await withHome(async (homeA) => {
    await writeZcodeServers(homeA, {
      shared: serverConfig("remote", { env: { FROM: "remote" } }),
    });
    await createService(github).syncConfigToGist();
  });
  await withHome(async (homeB) => {
    await writeZcodeServers(homeB, {
      shared: serverConfig("local"),
      "local-only": serverConfig("local-only"),
    });
    const service = createService(homeB === "" ? github : github);

    const plan = await service.previewConfigFromGist();
    assert.ok(plan.status === "ok");
    assert.deepEqual(
      plan.entries.map((entry) => [entry.name, entry.kind]),
      [
        ["local-only", "localOnly"],
        ["shared", "update"],
      ],
    );

    assert.equal(
      expectError(
        await service.applyConfigFromGist({
          strategy: "replace",
          expectedRemoteRevision: plan.remoteRevision,
        }),
      ).code,
      "unknown",
    );
    assert.equal((await readZcodeServers(homeB)).shared.command, "npx");

    const merged = await service.applyConfigFromGist({
      strategy: "merge",
      expectedRemoteRevision: plan.remoteRevision,
    });
    assert.ok(merged.status === "ok");
    assert.deepEqual(merged.applied, { added: 0, updated: 1, removed: 0, kept: 1 });
    const afterMerge = await readZcodeServers(homeB);
    assert.deepEqual(afterMerge.shared.env, { FROM: "remote" });
    assert.ok(afterMerge["local-only"]);

    const replaced = await service.applyConfigFromGist({
      strategy: "replace",
      expectedRemoteRevision: plan.remoteRevision,
      confirmReplace: true,
    });
    assert.ok(replaced.status === "ok");
    assert.deepEqual(replaced.applied, { added: 0, updated: 0, removed: 1, kept: 0 });
    const afterReplace = await readZcodeServers(homeB);
    assert.equal(afterReplace["local-only"], undefined);
    assert.ok(afterReplace.shared);
  });
});

test("新机器无元数据：按 description 发现 gist 并全量下载", async () => {
  const github = createFakeGithub();
  await withHome(async (homeA) => {
    await writeZcodeServers(homeA, { alpha: serverConfig("alpha") });
    await createService(github).syncConfigToGist();
  });
  await withHome(async (homeB) => {
    const service = createService(github);
    const plan = await service.previewConfigFromGist();
    assert.ok(plan.status === "ok");
    assert.deepEqual(
      plan.entries.map((entry) => entry.kind),
      ["add"],
    );
    const applied = await service.applyConfigFromGist({
      strategy: "merge",
      expectedRemoteRevision: plan.remoteRevision,
    });
    assert.ok(applied.status === "ok");
    assert.deepEqual(applied.applied, { added: 1, updated: 0, removed: 0, kept: 0 });
    assert.equal((await readZcodeServers(homeB)).alpha.command, "npx");
    assert.ok(applied.backupDir);
  });
});

test("远端内容非法 / revision 不符：拒绝写入且本地零变更", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeZcodeServers(home, { alpha: serverConfig("alpha") });
    const service = createService(github);
    await service.syncConfigToGist();

    assert.equal(
      expectError(
        await service.applyConfigFromGist({ strategy: "merge", expectedRemoteRevision: 999 }),
      ).code,
      "conflict",
    );

    github.onlyGist().files.set("server.alpha.json", "不是 JSON");
    assert.equal(expectError(await service.previewConfigFromGist()).code, "remote_invalid");
    assert.equal((await readZcodeServers(home)).alpha.command, "npx");
  });
});

test("疑似密钥（env 里的 token）：先警告且不回命中值，确认后才上传", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await writeZcodeServers(home, { leaky: serverConfig("leaky", { env: { TOKEN: secret } }) });
    const service = createService(github);

    const warning = expectError(await service.syncConfigToGist());
    assert.equal(warning.code, "secret_warning");
    assert.equal(github.requests.length, 0);
    assert.equal(JSON.stringify(warning).includes(secret), false);
    assert.equal(warning.secretWarnings?.[0]?.fileName, "server.leaky.json");

    assert.equal((await service.syncConfigToGist({ confirmSecretUpload: true })).status, "ok");
  });
});

test("401：映射到 unauthorized 且不删凭据", async () => {
  await withHome(async (home) => {
    const github = createFakeGithub();
    await writeZcodeServers(home, { alpha: serverConfig("alpha") });
    const service = createService(github);
    github.setFailure({ status: 401 });
    assert.equal(expectError(await service.syncConfigToGist()).code, "unauthorized");
    assert.equal((await service.getConfigSyncStatus()).connected, true);
  });
});

test("下载后可列出备份并整份还原；还原前会再备份当前状态，且不改同步元数据", async () => {
  const github = createFakeGithub();
  await withHome(async (homeA) => {
    await writeZcodeServers(homeA, { shared: serverConfig("remote") });
    await createService(github).syncConfigToGist();
  });
  await withHome(async (homeB) => {
    await writeZcodeServers(homeB, { shared: serverConfig("local") });
    const service = createService(github);

    const plan = await service.previewConfigFromGist();
    assert.ok(plan.status === "ok");
    const applied = await service.applyConfigFromGist({
      strategy: "merge",
      expectedRemoteRevision: plan.remoteRevision,
    });
    assert.ok(applied.status === "ok");
    assert.equal((await readZcodeServers(homeB)).shared.args?.[1], "remote");

    // 备份落在数据存储路径下，1 份 = 应用前那次，条目数 = 1 个 server。
    const backups = await service.listConfigSyncBackups();
    assert.equal(backups.backupRoot, join(homeB, ".zcode", "v2", "mcp-config-sync-backup"));
    assert.equal(backups.backups.length, 1);
    assert.equal(backups.backups[0]?.itemCount, 1);

    const restored = await service.restoreConfigSyncBackup({
      backupDir: backups.backups[0]!.backupDir,
    });
    assert.ok(restored.status === "ok");
    assert.equal((await readZcodeServers(homeB)).shared.args?.[1], "local");
    assert.equal((await service.listConfigSyncBackups()).backups.length, 2);
    // 元数据未改写 → 状态行会提示本地有未上传的修改。
    assert.equal((await service.getConfigSyncStatus()).localChangedSinceLastSync, true);
  });
});

test("还原只接受已知备份：任意路径被拒且本地零变更", async () => {
  await withHome(async (home) => {
    await writeZcodeServers(home, { alpha: serverConfig("alpha") });
    const service = createService(createFakeGithub());
    const error = expectError(
      await service.restoreConfigSyncBackup({ backupDir: join(home, "..", "etc") }),
    );
    assert.equal(error.code, "unknown");
    assert.equal((await readZcodeServers(home)).alpha.command, "npx");
    assert.equal((await service.listConfigSyncBackups()).backups.length, 0);
  });
});
