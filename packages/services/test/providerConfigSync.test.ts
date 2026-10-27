import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parsePersonalModelConfigRules, parsePersonalProviderConfigMap } from "@zcode/provider";
import {
  createNodePersonalProviderConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import { sha256Hex } from "../src/config-sync/manifest.js";
import type { ConfigSyncError } from "../src/config-sync/types.js";
import { GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY } from "../src/github/githubAuth.js";
import { createProviderConfigSync } from "../src/model-provider/providerConfigSync.js";

/**
 * 模型设置同步的服务层测试：读写走真实的 `NodePersonalProviderConfigRepository`（临时目录里的
 * `provider_config.json`），远端用假 gist。
 */

const GIST_DESCRIPTION = "zcode-provider-config-sync";

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

  const toJson = (gist: FakeGist, withContent: boolean) => ({
    id: gist.id,
    html_url: `https://gist.github.com/${gist.id}`,
    description: gist.description,
    updated_at: "2026-10-18T00:00:00.000Z",
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
    setFile: (name: string, content: string) => {
      const gist = [...gists.values()][0];
      if (gist) gist.files.set(name, content);
    },
  };
}

type Repository = ReturnType<typeof createNodePersonalProviderConfigRepository>;

interface Context {
  readonly dataDir: string;
  readonly configPath: string;
  readonly repository: Repository;
}

async function withContext<T>(run: (ctx: Context) => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), "zcode-provider-sync-"));
  const configPath = join(dataDir, PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  const repository = createNodePersonalProviderConfigRepository({
    filePath: configPath,
    pollingIntervalMs: false,
  });
  try {
    return await run({ dataDir, configPath, repository });
  } finally {
    repository.dispose();
    await rm(dataDir, { recursive: true, force: true });
  }
}

function apiKeyProvider(baseUrl: string, apiKey: string, extra: Record<string, unknown> = {}) {
  return {
    group: "standard-personal",
    access: { type: "api-key", apiKey },
    api: { type: "openai-chat-completions", baseUrl },
    ...extra,
  };
}

async function seedProviders(
  repository: Repository,
  providerRules: readonly Record<string, unknown>[],
  providerOrder?: readonly string[],
  modelRules: readonly Record<string, unknown>[] = [],
): Promise<void> {
  await repository.update(() => ({
    providers: parsePersonalProviderConfigMap({ providerRules: [...providerRules] }),
    models: parsePersonalModelConfigRules({
      providerModelRules: [...modelRules],
      manualProviderModelRules: [],
    }),
    ...(providerOrder ? { providerOrder: [...providerOrder] } : {}),
  }));
}

async function readFileModelRuleCount(configPath: string): Promise<number> {
  const parsed = JSON.parse(await readFile(configPath, "utf-8")) as {
    config?: { modelConfigRules?: { providerModelRules?: unknown[] } };
  };
  return parsed.config?.modelConfigRules?.providerModelRules?.length ?? 0;
}

function createSync(
  github: ReturnType<typeof createFakeGithub>,
  ctx: Context,
  token: string | null = "gho_token",
) {
  return createProviderConfigSync({
    readLayer: () => ctx.repository.read(),
    updateLayer: (transform) => ctx.repository.update(transform),
    userConfigPath: async () => ctx.configPath,
    dataDir: async () => ctx.dataDir,
    credentialService: {
      load: async (key: string) => (key === GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY ? token : null),
      // config-sync 的凭据端口已放宽为 load/save/delete；本测试只关心旧 key 读取。
      save: async () => {},
      delete: async () => {},
    },
    fetchImpl: github.fetchImpl,
    enqueueWrite: (run) => run(),
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

async function readFileProviders(
  configPath: string,
): Promise<Record<string, Record<string, unknown>>> {
  const parsed = JSON.parse(await readFile(configPath, "utf-8")) as {
    config?: {
      providerConfigRules?: { providerRules?: { providerId: string; config: unknown }[] };
    };
  };
  const rules = parsed.config?.providerConfigRules?.providerRules ?? [];
  return Object.fromEntries(
    rules.map((rule) => [rule.providerId, rule.config as Record<string, unknown>]),
  );
}

test("未登录：不发任何网络请求", async () => {
  await withContext(async (ctx) => {
    const github = createFakeGithub();
    await seedProviders(ctx.repository, [
      { providerId: "alpha", config: apiKeyProvider("https://alpha.example.com", "sk-alpha") },
    ]);
    const sync = createSync(github, ctx, null);

    assert.equal(expectError(await sync.upload()).code, "not_authenticated");
    assert.equal(github.requests.length, 0);
    const status = await sync.getStatus();
    assert.equal(status.connected, false);
    assert.equal(status.localItemCount, 1);
  });
});

test("上传：条目不含 API Key，文件名转义 `:`，额外通道写出顺序与模型规则", async () => {
  await withContext(async (ctx) => {
    const github = createFakeGithub();
    await seedProviders(
      ctx.repository,
      [
        {
          providerId: "alpha",
          providerName: "Alpha",
          config: apiKeyProvider("https://alpha.example.com", "sk-alpha"),
        },
        {
          providerId: "vendor:beta",
          config: apiKeyProvider("https://beta.example.com", "sk-beta"),
        },
      ],
      ["alpha", "vendor:beta"],
    );
    const sync = createSync(github, ctx);

    const result = await sync.upload();
    assert.ok(result.status === "ok");
    assert.equal(result.itemCount, 2);
    assert.equal(result.remoteRevision, 1);

    const createRequest = github.requests.find((request) => request.method === "POST");
    assert.equal(createRequest?.body?.public, false);
    assert.equal(createRequest?.body?.description, GIST_DESCRIPTION);
    const files = (createRequest?.body?.files ?? {}) as Record<string, { content: string }>;
    assert.deepEqual(Object.keys(files).sort(), [
      "manifest.json",
      "provider.alpha.json",
      "provider.vendor%3abeta.json",
      "settings.json",
    ]);
    for (const [name, entry] of Object.entries(files)) {
      assert.equal(entry.content.includes("sk-alpha"), false, `${name} 不应含 apiKey`);
      assert.equal(entry.content.includes("sk-beta"), false, `${name} 不应含 apiKey`);
    }
    const settingsEntry = files["settings.json"];
    assert.ok(settingsEntry, "请求体应包含 settings.json");
    const settings = JSON.parse(settingsEntry.content) as { providerOrder: string[] };
    assert.deepEqual(settings.providerOrder, ["alpha", "vendor:beta"]);
  });
});

test("本地未变化再上传：返回 unchanged，零网络请求", async () => {
  await withContext(async (ctx) => {
    const github = createFakeGithub();
    await seedProviders(ctx.repository, [
      { providerId: "alpha", config: apiKeyProvider("https://alpha.example.com", "sk-alpha") },
    ]);
    const sync = createSync(github, ctx);
    assert.ok((await sync.upload()).status === "ok");

    const requestsBefore = github.requests.length;
    const second = await sync.upload();
    assert.ok(second.status === "unchanged");
    assert.equal(github.requests.length, requestsBefore);
  });
});

test("merge 下载：远端覆盖同名供应商、保留本地独有项，且补回本机 API Key", async () => {
  await withContext(async (ctx) => {
    const github = createFakeGithub();
    await seedProviders(ctx.repository, [
      { providerId: "alpha", config: apiKeyProvider("https://alpha.example.com", "sk-alpha") },
    ]);
    const sync = createSync(github, ctx);
    assert.ok((await sync.upload()).status === "ok");

    // 本机改了 alpha 的 endpoint、又新增了本地独有的 beta。
    await seedProviders(
      ctx.repository,
      [
        { providerId: "alpha", config: apiKeyProvider("https://changed.example.com", "sk-alpha") },
        { providerId: "beta", config: apiKeyProvider("https://beta.example.com", "sk-beta") },
      ],
      ["alpha", "beta"],
    );

    const preview = await sync.preview();
    assert.ok(preview.status === "ok");
    assert.deepEqual(
      preview.entries.map((entry) => [entry.name, entry.kind]),
      [
        ["alpha", "update"],
        ["beta", "localOnly"],
      ],
    );

    const applied = await sync.apply({
      strategy: "merge",
      expectedRemoteRevision: preview.remoteRevision,
    });
    assert.ok(applied.status === "ok");
    assert.deepEqual(applied.applied, { added: 0, updated: 1, removed: 0, kept: 1 });

    const providers = await readFileProviders(ctx.configPath);
    assert.deepEqual(Object.keys(providers).sort(), ["alpha", "beta"]);
    // 远端 endpoint 覆盖本机改动，本机 API Key 保留。
    assert.equal(
      (providers.alpha?.api as Record<string, unknown>)?.baseUrl,
      "https://alpha.example.com",
    );
    assert.equal((providers.alpha?.access as Record<string, unknown>)?.apiKey, "sk-alpha");
    assert.equal((providers.beta?.access as Record<string, unknown>)?.apiKey, "sk-beta");
  });
});

test("replace 下载：删除本地独有供应商、保留共有供应商的本机 API Key，且必须显式确认", async () => {
  await withContext(async (ctx) => {
    const github = createFakeGithub();
    await seedProviders(ctx.repository, [
      { providerId: "alpha", config: apiKeyProvider("https://alpha.example.com", "sk-alpha") },
    ]);
    const sync = createSync(github, ctx);
    assert.ok((await sync.upload()).status === "ok");

    await seedProviders(
      ctx.repository,
      [
        { providerId: "alpha", config: apiKeyProvider("https://alpha.example.com", "sk-alpha") },
        { providerId: "beta", config: apiKeyProvider("https://beta.example.com", "sk-beta") },
      ],
      ["alpha", "beta"],
    );

    const preview = await sync.preview();
    assert.ok(preview.status === "ok");
    assert.equal(
      expectError(
        await sync.apply({ strategy: "replace", expectedRemoteRevision: preview.remoteRevision }),
      ).code,
      "unknown",
    );
    assert.deepEqual(Object.keys(await readFileProviders(ctx.configPath)).sort(), [
      "alpha",
      "beta",
    ]);

    const applied = await sync.apply({
      strategy: "replace",
      expectedRemoteRevision: preview.remoteRevision,
      confirmReplace: true,
    });
    assert.ok(applied.status === "ok");
    assert.deepEqual(applied.applied, { added: 0, updated: 0, removed: 1, kept: 0 });

    const providers = await readFileProviders(ctx.configPath);
    assert.deepEqual(Object.keys(providers), ["alpha"]);
    assert.equal((providers.alpha?.access as Record<string, unknown>)?.apiKey, "sk-alpha");
  });
});

test("远端条目非法：拒绝写入，本地零变更", async () => {
  await withContext(async (ctx) => {
    const github = createFakeGithub();
    await seedProviders(ctx.repository, [
      { providerId: "alpha", config: apiKeyProvider("https://alpha.example.com", "sk-alpha") },
    ]);
    const sync = createSync(github, ctx);
    assert.ok((await sync.upload()).status === "ok");
    const before = await readFile(ctx.configPath, "utf-8");

    github.setFile("provider.alpha.json", '{"providerId":"alpha"}');
    assert.equal(expectError(await sync.preview()).code, "remote_invalid");
    assert.equal(await readFile(ctx.configPath, "utf-8"), before);
  });
});

test("api.headers 里含疑似密钥：先返回 secret_warning 且不含命中值，确认后才上传", async () => {
  await withContext(async (ctx) => {
    const github = createFakeGithub();
    const secret = `ghp_${"a".repeat(24)}`;
    await seedProviders(ctx.repository, [
      {
        providerId: "alpha",
        config: apiKeyProvider("https://alpha.example.com", "sk-alpha", {
          api: {
            type: "openai-chat-completions",
            baseUrl: "https://alpha.example.com",
            headers: { authorization: `Bearer ${secret}` },
          },
        }),
      },
    ]);
    const sync = createSync(github, ctx);

    const warned = expectError(await sync.upload());
    assert.equal(warned.code, "secret_warning");
    assert.equal(warned.secretWarnings?.length, 1);
    assert.equal(JSON.stringify(warned).includes(secret), false);
    assert.equal(github.requests.length, 0);

    assert.ok((await sync.upload({ confirmSecretUpload: true })).status === "ok");
  });
});

test("从备份还原：把本机配置退回应用前状态，并留下安全备份", async () => {
  await withContext(async (ctx) => {
    const github = createFakeGithub();
    await seedProviders(ctx.repository, [
      { providerId: "alpha", config: apiKeyProvider("https://alpha.example.com", "sk-alpha") },
    ]);
    const sync = createSync(github, ctx);
    assert.ok((await sync.upload()).status === "ok");

    await seedProviders(ctx.repository, [
      { providerId: "alpha", config: apiKeyProvider("https://changed.example.com", "sk-alpha") },
    ]);
    const preview = await sync.preview();
    assert.ok(preview.status === "ok");
    const applied = await sync.apply({
      strategy: "merge",
      expectedRemoteRevision: preview.remoteRevision,
    });
    assert.ok(applied.status === "ok");
    assert.equal(
      ((await readFileProviders(ctx.configPath)).alpha?.api as Record<string, unknown>)?.baseUrl,
      "https://alpha.example.com",
    );

    const backups = await sync.listBackups();
    assert.equal(backups.backups.length, 1);
    assert.equal(backups.backups[0]?.itemCount, 1);

    const restored = await sync.restore({ backupDir: backups.backups[0]!.backupDir });
    assert.ok(restored.status === "ok");
    assert.equal(
      ((await readFileProviders(ctx.configPath)).alpha?.api as Record<string, unknown>)?.baseUrl,
      "https://changed.example.com",
    );

    // 任意路径不能被当成备份。
    assert.equal(
      expectError(await sync.restore({ backupDir: join(ctx.dataDir, "nope") })).code,
      "unknown",
    );
  });
});

test("merge 下载幂等：连续下载不会让模型规则重复追加，也不会因同键冲突失败", async () => {
  await withContext(async (ctx) => {
    const github = createFakeGithub();
    const alphaRule = {
      providerId: "alpha",
      config: apiKeyProvider("https://a.example.com", "sk-a"),
    };
    await seedProviders(
      ctx.repository,
      [alphaRule],
      ["alpha"],
      [{ providerId: "local-only", modelId: "x", config: { enabled: true } }],
    );
    const sync = createSync(github, ctx);
    assert.ok((await sync.upload()).status === "ok");

    // 本机随后新增一条模型规则（远端仍只有 local-only/x），下载时 extras 与远端不同，会触发写入。
    await seedProviders(
      ctx.repository,
      [alphaRule],
      ["alpha"],
      [
        { providerId: "local-only", modelId: "x", config: { enabled: true } },
        { providerId: "p2", modelId: "m2", config: { enabled: true } },
      ],
    );

    for (let round = 1; round <= 2; round += 1) {
      const preview = await sync.preview();
      assert.ok(preview.status === "ok");
      const applied = await sync.apply({
        strategy: "merge",
        expectedRemoteRevision: preview.remoteRevision,
      });
      assert.ok(
        applied.status === "ok",
        `第 ${round} 次 merge 下载失败：${JSON.stringify(applied)}`,
      );
      assert.equal(
        await readFileModelRuleCount(ctx.configPath),
        2,
        `第 ${round} 次 merge 下载后规则数应保持 2（旧实现会重复追加远端规则）`,
      );
    }
  });
});

test("远端 settings.json 语义非法（校验和正确）：预览即报 remote_invalid，本地零变更", async () => {
  await withContext(async (ctx) => {
    const github = createFakeGithub();
    await seedProviders(ctx.repository, [
      { providerId: "alpha", config: apiKeyProvider("https://alpha.example.com", "sk-alpha") },
    ]);
    const sync = createSync(github, ctx);
    assert.ok((await sync.upload()).status === "ok");
    const before = await readFile(ctx.configPath, "utf-8");

    // 构造「sha256 与 manifest 记录一致、但语义非法」的 settings.json：核心只校验 sha256，
    // 语义必须由 profile 拦下来，否则要到写盘阶段才失败、错误码退化成 unknown。
    const gist = github.onlyGist();
    assert.ok(gist);
    const manifest = JSON.parse(gist.files.get("manifest.json") ?? "{}") as {
      extras: { fileName: string; sha256: string }[];
    };
    assert.ok(manifest.extras[0]);
    const badSettings = '{"providerOrder":["alpha"],"modelConfigRules":"不是规则对象"}';
    manifest.extras[0].sha256 = sha256Hex(badSettings);
    github.setFile("settings.json", badSettings);
    github.setFile("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

    assert.equal(expectError(await sync.preview()).code, "remote_invalid");
    assert.equal(await readFile(ctx.configPath, "utf-8"), before);
  });
});

test("还原走仓库写入路径：备份内容非法时拒绝还原，不把非法内容写成生效配置", async () => {
  await withContext(async (ctx) => {
    const github = createFakeGithub();
    await seedProviders(ctx.repository, [
      { providerId: "alpha", config: apiKeyProvider("https://alpha.example.com", "sk-alpha") },
    ]);
    const sync = createSync(github, ctx);
    assert.ok((await sync.upload()).status === "ok");
    const before = await readFile(ctx.configPath, "utf-8");

    // 手工造一份「目录完整、但内容非法」的备份：直接 cp 会把它变成生效配置。
    // 目录名必须与安全备份的时间戳错开，否则会撞进同一个目录被覆盖。
    const backupDir = join(ctx.dataDir, "provider-config-sync-backup", String(Date.now() - 60_000));
    await mkdir(backupDir, { recursive: true });
    await writeFile(
      join(backupDir, PERSONAL_PROVIDER_CONFIG_FILE_NAME),
      "{ 这不是合法的 provider_config.json",
      "utf-8",
    );

    assert.equal(expectError(await sync.restore({ backupDir })).code, "unknown");
    assert.equal(await readFile(ctx.configPath, "utf-8"), before);
    assert.deepEqual(Object.keys(await readFileProviders(ctx.configPath)), ["alpha"]);
  });
});
