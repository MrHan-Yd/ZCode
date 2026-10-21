import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
  PROMPT_LIBRARY_LIMITS,
  type PromptLibraryFileV1,
  type PromptTemplate,
} from "@zcode/shared";
import { buildRemoteFiles, sha256Hex } from "../src/config-sync/manifest.js";
import { GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY } from "../src/github/githubAuth.js";
import { setDataBaseDir } from "../src/paths.js";
import {
  PROMPT_LIBRARY_CONFIG_GIST_DESCRIPTION,
  PROMPT_LIBRARY_CONFIG_PROFILE,
  PROMPT_LIBRARY_SYNC_FILE_NAME,
  PROMPT_LIBRARY_SYNC_ITEM_NAME,
  createPromptLibraryConfigSync,
  mergePromptLibraryFiles,
  serializePromptLibraryFileForSync,
} from "../src/prompt-library/promptLibraryConfigSync.js";
import { createPromptLibraryService } from "../src/prompt-library/promptLibraryService.js";

/**
 * 提示词库 GitHub 同步测试（specs/prompt-library.md §14.2 / §14.3 / §14.6）。
 *
 * - 纯逻辑：稳定序列化、merge、profile。
 * - 编排：复用 config-sync 的 fake GitHub fetch；元数据与备份通过 setDataBaseDir 指向临时目录，
 *   提示词库文件通过 filePath 注入，绝不写真实 ~/.zcode。
 */

const SYNC_METADATA_FILE_NAME = "prompt-library-sync-metadata.json";

function createTemplate(id: string, overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id,
    title: `title-${id}`,
    content: `content-${id}`,
    tags: [],
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function createFile(items: PromptTemplate[], updatedAt = 1): PromptLibraryFileV1 {
  return { version: 1, updatedAt, items };
}

interface FakeGist {
  readonly id: string;
  description: string;
  readonly files: Map<string, string>;
}

interface RecordedRequest {
  method: string;
  path: string;
  body?: Record<string, unknown>;
}

/** 按真实 GitHub 契约解析 `files`：值必须是 `{ content }` 或 `null`（删除）。 */
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
  const requests: RecordedRequest[] = [];
  let counter = 0;
  let failure: { status: number; headers?: Record<string, string> } | null = null;

  const toJson = (gist: FakeGist, withContent: boolean) => ({
    id: gist.id,
    html_url: `https://gist.github.com/${gist.id}`,
    description: gist.description,
    updated_at: "2026-10-21T00:00:00.000Z",
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
    if (failure) {
      return new Response(null, { status: failure.status, headers: failure.headers ?? {} });
    }
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
    setFailure: (next: { status: number; headers?: Record<string, string> } | null) => {
      failure = next;
    },
    /** 直接放一份远端 gist，绕过上传流程，用于 preview/apply。 */
    seedGist(files: Map<string, string>, id: string): FakeGist {
      const gist: FakeGist = {
        id,
        description: PROMPT_LIBRARY_CONFIG_GIST_DESCRIPTION,
        files,
      };
      gists.set(id, gist);
      return gist;
    },
    onlyGist: () => [...gists.values()][0],
  };
}

/** 用 config-sync 自己的 buildRemoteFiles 构造远端文件，确保 manifest/sha256 与契约一致。 */
function buildRemotePromptGist(file: PromptLibraryFileV1, revision: number): Map<string, string> {
  const built = buildRemoteFiles(PROMPT_LIBRARY_CONFIG_PROFILE, {
    items: [
      { name: PROMPT_LIBRARY_SYNC_ITEM_NAME, content: serializePromptLibraryFileForSync(file) },
    ],
    extras: [],
    revision,
    updatedAt: "2026-10-21T00:00:00.000Z",
    previousFileNames: [],
  });
  assert.ok(built);
  return new Map(
    Object.entries(built.files).flatMap(([name, entry]) =>
      entry === null ? [] : [[name, entry.content] as const],
    ),
  );
}

async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-prompt-library-sync-"));
  // 同步元数据与备份根目录都从 getAppConfigDir() 派生，改数据根目录即可隔离。
  setDataBaseDir(home);
  try {
    await run(home);
  } finally {
    setDataBaseDir(null);
    await rm(home, { recursive: true, force: true });
  }
}

function libraryPath(home: string): string {
  return join(home, ".zcode", "v2", "prompt-library.json");
}

async function writeLibraryFile(
  filePath: string,
  items: PromptTemplate[],
  updatedAt = 1,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(createFile(items, updatedAt), null, 2), "utf-8");
}

async function readLibraryFile(filePath: string): Promise<PromptLibraryFileV1> {
  return JSON.parse(await readFile(filePath, "utf-8")) as PromptLibraryFileV1;
}

async function writeSyncMetadata(home: string, record: Record<string, unknown>): Promise<void> {
  const dir = join(home, ".zcode", "v2");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, SYNC_METADATA_FILE_NAME),
    JSON.stringify({ schemaVersion: 2, user: record }, null, 2),
    "utf-8",
  );
}

function createCredentials(token: string | null) {
  return {
    load: async (key: string) => (key === GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY ? token : null),
  };
}

function createService(params: {
  home: string;
  github?: ReturnType<typeof createFakeGithub>;
  token?: string | null;
  withCredentials?: boolean;
}) {
  const github = params.github ?? createFakeGithub();
  return {
    github,
    service: createPromptLibraryService({
      filePath: libraryPath(params.home),
      now: () => 1_700_000_000_000,
      ...(params.withCredentials === false
        ? {}
        : { credentialService: createCredentials(params.token ?? "gho_token") }),
      fetchImpl: github.fetchImpl,
    }),
  };
}

// ---------------------------------------------------------------------------
// 1. 稳定序列化
// ---------------------------------------------------------------------------

test("serializePromptLibraryFileForSync：items 按 id 排序、缩进与末尾换行稳定", () => {
  const file = createFile(
    [
      createTemplate("pl_c", { title: "C" }),
      createTemplate("pl_a", { title: "A" }),
      createTemplate("pl_b", { title: "B" }),
    ],
    42,
  );

  const text = serializePromptLibraryFileForSync(file);
  const parsed = JSON.parse(text) as PromptLibraryFileV1;

  assert.equal(parsed.version, 1);
  assert.equal(parsed.updatedAt, 42);
  assert.deepEqual(
    parsed.items.map((item) => item.id),
    ["pl_a", "pl_b", "pl_c"],
  );
  assert.ok(text.endsWith("\n"));
  assert.ok(text.includes('\n  "version": 1'));
  assert.ok(text.includes('\n  "updatedAt": 42'));

  // 同一内容（含 item 顺序不同）必须产出完全相同的文本，作为指纹与 diff 的基础。
  assert.equal(serializePromptLibraryFileForSync(file), text);
  assert.equal(
    serializePromptLibraryFileForSync({ ...file, items: [...file.items].reverse() }),
    text,
  );
});

// ---------------------------------------------------------------------------
// 2. merge
// ---------------------------------------------------------------------------

test("mergePromptLibraryFiles：同 id 远端优先，本地独有保留，结果按 id 排序", () => {
  const local = createFile(
    [createTemplate("pl_2", { title: "本地二" }), createTemplate("pl_1", { title: "本地一" })],
    10,
  );
  const remote = createFile(
    [createTemplate("pl_1", { title: "远端一" }), createTemplate("pl_3", { title: "远端三" })],
    20,
  );

  const merged = mergePromptLibraryFiles(local, remote);
  assert.deepEqual(
    merged.items.map((item) => item.id),
    ["pl_1", "pl_2", "pl_3"],
  );
  const byId = new Map(merged.items.map((item) => [item.id, item]));
  assert.equal(byId.get("pl_1")?.title, "远端一");
  assert.equal(byId.get("pl_2")?.title, "本地二");
  assert.equal(byId.get("pl_3")?.title, "远端三");
  assert.equal(merged.updatedAt, 20);
  assert.equal(merged.version, 1);
});

test("mergePromptLibraryFiles：跨端 alias 大小写冲突时保留远端 alias、清空本地 alias 且不丢条目", () => {
  const local = createFile([createTemplate("pl_local", { title: "本地独有", alias: "REVIEW" })]);
  const remote = createFile([createTemplate("pl_remote", { title: "远端条目", alias: "review" })]);

  const merged = mergePromptLibraryFiles(local, remote);
  const byId = new Map(merged.items.map((item) => [item.id, item]));

  assert.equal(merged.items.length, 2);
  assert.equal(byId.get("pl_remote")?.alias, "review");
  assert.equal(byId.get("pl_local")?.alias, undefined);
  // 条目本身必须保留，不能被删掉。
  assert.equal(byId.get("pl_local")?.title, "本地独有");
  assert.equal(byId.get("pl_local")?.content, "content-pl_local");
});

test("mergePromptLibraryFiles：远端内部重复 alias 收敛为仅首个保留", () => {
  const remote = createFile([
    createTemplate("pl_r1", { alias: "dup" }),
    createTemplate("pl_r2", { alias: "DUP" }),
  ]);

  const merged = mergePromptLibraryFiles(createFile([]), remote);
  const byId = new Map(merged.items.map((item) => [item.id, item]));

  assert.equal(merged.items.length, 2);
  assert.equal(byId.get("pl_r1")?.alias, "dup");
  assert.equal(byId.get("pl_r2")?.alias, undefined);
  const aliases = merged.items
    .map((item) => item.alias?.toLowerCase())
    .filter((alias): alias is string => alias !== undefined);
  assert.deepEqual(aliases, ["dup"]);
});

// ---------------------------------------------------------------------------
// 3. profile
// ---------------------------------------------------------------------------

test("PROMPT_LIBRARY_CONFIG_PROFILE：文件名双向映射、内容校验与无额外通道", () => {
  assert.equal(PROMPT_LIBRARY_CONFIG_PROFILE.fileNameFor("prompts"), "prompts.json");
  assert.equal(PROMPT_LIBRARY_CONFIG_PROFILE.fileNameFor("other"), null);
  assert.equal(PROMPT_LIBRARY_CONFIG_PROFILE.nameFromFileName("prompts.json"), "prompts");
  assert.equal(PROMPT_LIBRARY_CONFIG_PROFILE.nameFromFileName("manifest.json"), null);
  assert.deepEqual([...PROMPT_LIBRARY_CONFIG_PROFILE.extraFileNames], []);
  assert.equal(PROMPT_LIBRARY_CONFIG_PROFILE.isValidExtraContent, undefined);
  assert.equal(PROMPT_LIBRARY_CONFIG_PROFILE.maxFileBytes, PROMPT_LIBRARY_LIMITS.maxFileBytes);
  assert.equal(PROMPT_LIBRARY_CONFIG_PROFILE.maxTotalBytes, PROMPT_LIBRARY_LIMITS.maxFileBytes);

  const valid = serializePromptLibraryFileForSync(createFile([createTemplate("pl_1")]));
  assert.equal(PROMPT_LIBRARY_CONFIG_PROFILE.isValidContent("prompts.json", valid), true);
  // 文件名不匹配时即便内容合法也不认。
  assert.equal(PROMPT_LIBRARY_CONFIG_PROFILE.isValidContent("other.json", valid), false);
  assert.equal(PROMPT_LIBRARY_CONFIG_PROFILE.isValidContent("prompts.json", "{"), false);
  assert.equal(
    PROMPT_LIBRARY_CONFIG_PROFILE.isValidContent(
      "prompts.json",
      JSON.stringify({ version: 1, updatedAt: 1, items: [{ id: "x" }] }),
    ),
    false,
  );
  assert.equal(
    PROMPT_LIBRARY_CONFIG_PROFILE.isValidContent(
      "prompts.json",
      JSON.stringify({ version: 2, updatedAt: 1, items: [] }),
    ),
    false,
  );
});

// ---------------------------------------------------------------------------
// 4. createPromptLibraryConfigSync / service 同步入口
// ---------------------------------------------------------------------------

test("getSyncStatus：未注入 credentialService 时 connected=false", async () => {
  await withTempHome(async (home) => {
    const filePath = libraryPath(home);
    await writeLibraryFile(filePath, [createTemplate("pl_1")]);

    const { service } = createService({ home, withCredentials: false });
    const status = await service.getSyncStatus!();

    assert.equal(status.connected, false);
    assert.equal(status.localItemCount, 1);
    assert.equal(status.localChangedSinceLastSync, false);
    assert.equal(status.backupCount, 0);
    assert.equal(status.gistIdShort, undefined);
  });
});

test("上传：POST /gists 收到 prompts.json 与 manifest，返回 gist id；重复上传不发请求", async () => {
  await withTempHome(async (home) => {
    const filePath = libraryPath(home);
    await writeLibraryFile(filePath, [
      createTemplate("pl_2", { title: "乙" }),
      createTemplate("pl_1", { title: "甲" }),
    ]);

    const { service, github } = createService({ home });
    const result = await service.uploadToGithub!();

    if (result.status === "error") {
      assert.fail(`期望成功，实际 ${result.error.code}: ${result.error.message}`);
    }
    assert.equal(result.gistIdShort, "gist1");
    assert.equal(result.remoteRevision, 1);
    // 整库是一个同步条目（不是每条提示词一个 item）。
    assert.equal(result.itemCount, 1);

    const post = github.requests.find((request) => request.method === "POST");
    assert.ok(post);
    const body = post.body as {
      description: string;
      public: boolean;
      files: Record<string, { content: string }>;
    };
    assert.equal(body.description, PROMPT_LIBRARY_CONFIG_GIST_DESCRIPTION);
    assert.equal(body.public, false);
    assert.deepEqual(Object.keys(body.files).sort(), [
      "manifest.json",
      PROMPT_LIBRARY_SYNC_FILE_NAME,
    ]);

    const promptsContent = body.files[PROMPT_LIBRARY_SYNC_FILE_NAME]?.content ?? "";
    const uploaded = JSON.parse(promptsContent) as PromptLibraryFileV1;
    assert.deepEqual(
      uploaded.items.map((item) => item.id),
      ["pl_1", "pl_2"],
    );
    assert.ok(promptsContent.endsWith("\n"));

    const manifestContent = body.files["manifest.json"]?.content ?? "";
    const manifest = JSON.parse(manifestContent) as {
      revision: number;
      items: { name: string; fileName: string; sha256: string }[];
    };
    assert.equal(manifest.revision, 1);
    assert.equal(manifest.items.length, 1);
    assert.equal(manifest.items[0]?.name, PROMPT_LIBRARY_SYNC_ITEM_NAME);
    assert.equal(manifest.items[0]?.fileName, PROMPT_LIBRARY_SYNC_FILE_NAME);
    assert.equal(manifest.items[0]?.sha256, sha256Hex(promptsContent));

    // 内容未变化的第二次上传：unchanged 且零网络请求。
    const requestCount = github.requests.length;
    const second = await service.uploadToGithub!();
    assert.equal(second.status, "unchanged");
    assert.equal(github.requests.length, requestCount);
  });
});

test("上传疑似密钥：返回 secret_warning 且不调用 POST，确认后才上传", async () => {
  await withTempHome(async (home) => {
    const filePath = libraryPath(home);
    await writeLibraryFile(filePath, [
      createTemplate("pl_secret", { content: "key=AKIAABCDEFGHIJKLMNOP" }),
    ]);

    const { service, github } = createService({ home });
    const result = await service.uploadToGithub!();

    assert.equal(result.status, "error");
    if (result.status !== "error") return;
    assert.equal(result.error.code, "secret_warning");
    assert.ok(
      result.error.secretWarnings?.some(
        (warning) =>
          warning.fileName === PROMPT_LIBRARY_SYNC_FILE_NAME &&
          warning.pattern === "aws_access_key_id",
      ),
    );
    assert.equal(
      github.requests.some((request) => request.method === "POST"),
      false,
    );

    const confirmed = await service.uploadToGithub!({ confirmSecretUpload: true });
    assert.equal(confirmed.status, "ok");
    assert.equal(
      github.requests.some((request) => request.method === "POST"),
      true,
    );
  });
});

test("previewDownload：GET 指定 gist，识别 1 个条目与 revision", async () => {
  await withTempHome(async (home) => {
    const filePath = libraryPath(home);
    await writeLibraryFile(filePath, [createTemplate("pl_local", { title: "本地" })]);

    const github = createFakeGithub();
    github.seedGist(
      buildRemotePromptGist(createFile([createTemplate("pl_remote", { title: "远端" })], 50), 3),
      "gist_remote",
    );
    await writeSyncMetadata(home, { gistId: "gist_remote", lastRemoteRevision: 3 });

    const { service } = createService({ home, github });
    const plan = await service.previewDownload!();

    if (plan.status === "error") {
      assert.fail(`期望成功，实际 ${plan.error.code}: ${plan.error.message}`);
    }
    assert.equal(plan.remoteRevision, 3);
    assert.equal(plan.gistIdShort, "gist_rem");
    assert.equal(plan.gistUrl, "https://gist.github.com/gist_remote");
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.entries[0]?.name, PROMPT_LIBRARY_SYNC_ITEM_NAME);
    assert.equal(plan.entries[0]?.kind, "update");
    assert.ok(
      github.requests.some(
        (request) => request.method === "GET" && request.path === "/gists/gist_remote",
      ),
    );
  });
});

test("applyDownload merge：同 id 远端覆盖、本地独有保留、远端新增合并", async () => {
  await withTempHome(async (home) => {
    const filePath = libraryPath(home);
    await writeLibraryFile(
      filePath,
      [
        createTemplate("pl_1", { title: "本地同 id", content: "local" }),
        createTemplate("pl_local", { title: "本地独有" }),
      ],
      10,
    );

    const github = createFakeGithub();
    github.seedGist(
      buildRemotePromptGist(
        createFile(
          [
            createTemplate("pl_1", { title: "远端同 id", content: "remote" }),
            createTemplate("pl_remote", { title: "远端新增" }),
          ],
          20,
        ),
        4,
      ),
      "gist_remote",
    );
    await writeSyncMetadata(home, { gistId: "gist_remote", lastRemoteRevision: 3 });

    const { service } = createService({ home, github });
    const result = await service.applyDownload!({
      strategy: "merge",
      expectedRemoteRevision: 4,
    });

    if (result.status === "error") {
      assert.fail(`期望成功，实际 ${result.error.code}: ${result.error.message}`);
    }
    assert.equal(result.remoteRevision, 4);

    const merged = await readLibraryFile(filePath);
    assert.deepEqual(
      merged.items.map((item) => item.id),
      ["pl_1", "pl_local", "pl_remote"],
    );
    const byId = new Map(merged.items.map((item) => [item.id, item]));
    assert.equal(byId.get("pl_1")?.title, "远端同 id");
    assert.equal(byId.get("pl_1")?.content, "remote");
    assert.equal(byId.get("pl_local")?.title, "本地独有");
    assert.equal(byId.get("pl_remote")?.title, "远端新增");
    assert.equal(merged.updatedAt, 20);
  });
});

test("applyDownload replace：需显式确认；镜像后本地与远端完全一致", async () => {
  await withTempHome(async (home) => {
    const filePath = libraryPath(home);
    await writeLibraryFile(
      filePath,
      [
        createTemplate("pl_1", { title: "本地同 id", content: "local" }),
        createTemplate("pl_local", { title: "本地独有" }),
      ],
      10,
    );

    const github = createFakeGithub();
    const remoteFile = createFile(
      [
        createTemplate("pl_1", { title: "远端同 id", content: "remote" }),
        createTemplate("pl_remote", { title: "远端新增" }),
      ],
      20,
    );
    github.seedGist(buildRemotePromptGist(remoteFile, 5), "gist_remote");
    await writeSyncMetadata(home, { gistId: "gist_remote", lastRemoteRevision: 4 });

    const { service } = createService({ home, github });

    const unconfirmed = await service.applyDownload!({
      strategy: "replace",
      expectedRemoteRevision: 5,
    });
    assert.equal(unconfirmed.status, "error");

    const result = await service.applyDownload!({
      strategy: "replace",
      expectedRemoteRevision: 5,
      confirmReplace: true,
    });
    if (result.status === "error") {
      assert.fail(`期望成功，实际 ${result.error.code}: ${result.error.message}`);
    }

    const applied = await readLibraryFile(filePath);
    assert.deepEqual(
      applied.items.map((item) => item.id),
      ["pl_1", "pl_remote"],
    );
    const remoteSnapshot = await readLibraryFile(filePath);
    assert.deepEqual(remoteSnapshot.items, remoteFile.items);
    assert.equal(
      applied.items.some((item) => item.id === "pl_local"),
      false,
    );
  });
});

test("本地库损坏：upload/preview/apply 返回 local_invalid 且不覆盖本地文件", async () => {
  await withTempHome(async (home) => {
    const filePath = libraryPath(home);
    await mkdir(dirname(filePath), { recursive: true });
    const corruptContent = "{ broken json";
    await writeFile(filePath, corruptContent, "utf-8");

    const { service, github } = createService({ home });

    const upload = await service.uploadToGithub!();
    assert.equal(upload.status, "error");
    if (upload.status === "error") assert.equal(upload.error.code, "local_invalid");

    const preview = await service.previewDownload!();
    assert.equal(preview.status, "error");
    if (preview.status === "error") assert.equal(preview.error.code, "local_invalid");

    const apply = await service.applyDownload!({
      strategy: "merge",
      expectedRemoteRevision: 1,
    });
    assert.equal(apply.status, "error");
    if (apply.status === "error") assert.equal(apply.error.code, "local_invalid");

    // 只读检查在联网之前，网络层一次都不应被调用。
    assert.equal(github.requests.length, 0);
    assert.equal(await readFile(filePath, "utf-8"), corruptContent);
  });
});

test("本地库 version: 2：upload/preview/apply 返回 local_invalid 且不写盘", async () => {
  await withTempHome(async (home) => {
    const filePath = libraryPath(home);
    await mkdir(dirname(filePath), { recursive: true });
    const futureContent = JSON.stringify(
      { version: 2, updatedAt: 1, items: [createTemplate("pl_future")] },
      null,
      2,
    );
    await writeFile(filePath, futureContent, "utf-8");

    const { service, github } = createService({ home });

    for (const result of [
      await service.uploadToGithub!(),
      await service.previewDownload!(),
      await service.applyDownload!({ strategy: "merge", expectedRemoteRevision: 1 }),
    ]) {
      assert.equal(result.status, "error");
      if (result.status === "error") assert.equal(result.error.code, "local_invalid");
    }

    assert.equal(github.requests.length, 0);
    assert.equal(await readFile(filePath, "utf-8"), futureContent);
  });
});

test("备份：listSyncBackups 能列出，restoreSyncBackup 能还原到下载前状态", async () => {
  await withTempHome(async (home) => {
    const filePath = libraryPath(home);
    await writeLibraryFile(filePath, [createTemplate("pl_local", { title: "本地原样" })], 10);

    const github = createFakeGithub();
    github.seedGist(
      buildRemotePromptGist(
        createFile([createTemplate("pl_remote", { title: "远端新增" })], 20),
        2,
      ),
      "gist_remote",
    );
    await writeSyncMetadata(home, { gistId: "gist_remote", lastRemoteRevision: 1 });

    const { service } = createService({ home, github });
    const applied = await service.applyDownload!({
      strategy: "merge",
      expectedRemoteRevision: 2,
    });
    if (applied.status === "error") {
      assert.fail(`期望成功，实际 ${applied.error.code}: ${applied.error.message}`);
    }

    const afterApply = await readLibraryFile(filePath);
    assert.deepEqual(
      afterApply.items.map((item) => item.id),
      ["pl_local", "pl_remote"],
    );

    const backups = await service.listSyncBackups!();
    assert.equal(backups.backups.length, 1);
    assert.equal(backups.backups[0]?.itemCount, 1);
    assert.ok(backups.backupRoot.startsWith(home));
    const backupDir = backups.backups[0]?.backupDir;
    assert.ok(backupDir);

    // 安全备份目录名是 Date.now()；错开一毫秒，避免与源备份目录同名。
    await sleep(10);

    const restored = await service.restoreSyncBackup!({ backupDir });
    if (restored.status === "error") {
      assert.fail(`期望成功，实际 ${restored.error.code}: ${restored.error.message}`);
    }
    assert.equal(restored.itemCount, 1);

    const afterRestore = await readLibraryFile(filePath);
    assert.deepEqual(
      afterRestore.items.map((item) => item.id),
      ["pl_local"],
    );
    assert.equal(afterRestore.items[0]?.title, "本地原样");
  });
});

// ---------------------------------------------------------------------------
// 5. createPromptLibraryConfigSync 直接构造（内存 access）
// ---------------------------------------------------------------------------

test("createPromptLibraryConfigSync：快照上传使用 access.read 的稳定序列化", async () => {
  await withTempHome(async (_home) => {
    let current = createFile([createTemplate("pl_b"), createTemplate("pl_a")]);
    const access = {
      read: async () => ({ file: current, readOnly: false }),
      update: async (mutate: (file: PromptLibraryFileV1) => PromptLibraryFileV1) => {
        current = mutate(current);
      },
      restore: async (file: PromptLibraryFileV1) => {
        current = file;
        return true;
      },
      filePath: () => join(tmpdir(), "zcode-prompt-library-sync-unused", "prompt-library.json"),
    };

    const github = createFakeGithub();
    const sync = createPromptLibraryConfigSync({
      access,
      credentialService: createCredentials("gho_token"),
      fetchImpl: github.fetchImpl,
      now: () => 1,
    });

    const result = await sync.upload();
    assert.equal(result.status, "ok");
    const post = github.requests.find((request) => request.method === "POST");
    assert.ok(post);
    const files = (post.body as { files: Record<string, { content: string }> }).files;
    const uploaded = JSON.parse(
      files[PROMPT_LIBRARY_SYNC_FILE_NAME]?.content ?? "",
    ) as PromptLibraryFileV1;
    assert.deepEqual(
      uploaded.items.map((item) => item.id),
      ["pl_a", "pl_b"],
    );
  });
});

// ---------------------------------------------------------------------------
// 6. 合并后超过 500 条（spec §14.2：无法合并返回 local_invalid，不写盘）
// ---------------------------------------------------------------------------

test("applyDownload merge 超过 500 条：按 spec §14.2 应返回 local_invalid 且不写盘", async () => {
  await withTempHome(async (home) => {
    const filePath = libraryPath(home);
    const localItems = Array.from({ length: 400 }, (_, index) =>
      createTemplate(`pl_local_${String(index).padStart(4, "0")}`),
    );
    const remoteItems = Array.from({ length: 400 }, (_, index) =>
      createTemplate(`pl_remote_${String(index).padStart(4, "0")}`),
    );
    await writeLibraryFile(filePath, localItems, 10);

    const github = createFakeGithub();
    github.seedGist(buildRemotePromptGist(createFile(remoteItems, 20), 1), "gist_remote");
    await writeSyncMetadata(home, { gistId: "gist_remote" });

    const { service } = createService({ home, github });
    const before = await readFile(filePath, "utf-8");
    const result = await service.applyDownload!({
      strategy: "merge",
      expectedRemoteRevision: 1,
    });

    // 先验证「不写盘」：失败路径必须回滚到下载前状态。
    assert.equal(await readFile(filePath, "utf-8"), before);
    assert.equal(result.status, "error");
    if (result.status === "error") {
      assert.equal(result.error.code, "local_invalid");
    }
  });
});
