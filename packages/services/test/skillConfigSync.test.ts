import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY } from "../src/github/githubAuth.js";
import { setDataBaseDir } from "../src/paths.js";
import { createSkillSyncService } from "../src/skill-sync/skillSyncService.js";
import {
  isValidSkillSyncItemName,
  skillSyncItemFileName,
  skillSyncItemNameFromFileName,
} from "../src/skill-sync/skillConfigSyncModel.js";

/**
 * 技能 ↔ GitHub 私有 gist 同步：HOME 决定 skills 根，setDataBaseDir 决定元数据/备份位置，
 * 两层都要隔离，避免测试碰到真实用户目录。
 */

const GIST_DESCRIPTION = "zcode-skill-config-sync";

interface FakeGist {
  readonly id: string;
  description: string;
  readonly files: Map<string, string>;
}

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
    const record = entry as { content?: unknown };
    if (Object.keys(record).length !== 1 || typeof record.content !== "string") return null;
    files.set(name, record.content);
  }
  return files;
}

function createFakeGithub() {
  const gists = new Map<string, FakeGist>();
  const requests: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  let counter = 0;

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

    if (method === "POST" && path === "/gists") {
      const files = parseGistFiles(body?.files);
      if (!files) return new Response(null, { status: 422 });
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
      if (!files) return new Response(null, { status: 422 });
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
      return gist ? Response.json(toJson(gist, true)) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  };

  return { fetchImpl, requests, gists };
}

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "zcode-skill-sync-"));
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

function createService(github: ReturnType<typeof createFakeGithub>, token: string | null = "gho") {
  return createSkillSyncService({
    credentialService: {
      load: async (key: string) => (key === GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY ? token : null),
    },
    fetchImpl: github.fetchImpl,
  });
}

type SyncError = { status: "error"; error: { code: string; message: string } };

function expectError<T>(result: T | SyncError): SyncError["error"] {
  assert.ok(
    typeof result === "object" &&
      result !== null &&
      "status" in result &&
      result.status === "error",
    `期望错误结果，实际：${JSON.stringify(result)}`,
  );
  return (result as SyncError).error;
}

async function writeSkill(
  home: string,
  root: ".zcode" | ".agents",
  directoryName: string,
  files: Record<string, string | Uint8Array>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = join(home, root, "skills", directoryName, relativePath);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
}

const ALPHA_SKILL = "---\nname: alpha\ndescription: Alpha skill\n---\nUse alpha.\n";
const BETA_SKILL = "---\nname: beta\ndescription: Beta skill\n---\nUse beta.\n";

test("未登录：不发网络请求，状态行仍能读出本地文件数", async () => {
  await withHome(async (home) => {
    await writeSkill(home, ".zcode", "alpha", { "SKILL.md": ALPHA_SKILL });
    const github = createFakeGithub();
    const service = createService(github, null);

    assert.equal(expectError(await service.syncConfigToGist()).code, "not_authenticated");
    assert.equal(github.requests.length, 0);
    const status = await service.getConfigSyncStatus();
    assert.equal(status.connected, false);
    assert.equal(status.localItemCount, 1);
  });
});

test("上传 / 未变化 / 新机器下载：文本与二进制都逐字节往返", async () => {
  const github = createFakeGithub();
  const binary = Buffer.from([0, 1, 2, 255, 10]);

  await withHome(async (home) => {
    await writeSkill(home, ".zcode", "alpha", {
      "SKILL.md": ALPHA_SKILL,
      "scripts/run.py": "print('hi')\n",
    });
    await writeSkill(home, ".zcode", "alpha", { "assets/logo.bin": binary });
    await writeSkill(home, ".agents", "beta", { "SKILL.md": BETA_SKILL });

    const service = createService(github);
    const result = await service.syncConfigToGist();
    assert.ok(result.status === "ok");
    assert.equal(result.itemCount, 4);
    assert.equal(result.remoteRevision, 1);

    const gist = [...github.gists.values()][0];
    assert.equal(gist.description, GIST_DESCRIPTION);
    assert.ok(gist.files.has("manifest.json"));
    assert.equal(gist.files.get("skill.alpha%2fSKILL.md"), ALPHA_SKILL);
    assert.equal(gist.files.get("skill.alpha%2fscripts%2frun.py"), "print('hi')\n");
    assert.ok(gist.files.get("skill.alpha%2fassets%2flogo.bin")?.includes("$zcodeSkillSync"));
    assert.equal(gist.files.get("skill.beta%2fSKILL.md"), BETA_SKILL);

    // 本地未变化：不再发任何请求。
    const requestCount = github.requests.length;
    const again = await service.syncConfigToGist();
    assert.ok(again.status === "unchanged");
    assert.equal(github.requests.length, requestCount);

    // 新机器：按 description 发现 gist，预览 → 应用。
    const freshHome = await mkdtemp(join(tmpdir(), "zcode-skill-sync-b-"));
    const previousHome = process.env.HOME;
    const previousBaseDir = process.env.ZCODE_DATA_BASE_DIR;
    try {
      process.env.HOME = freshHome;
      setDataBaseDir(freshHome);
      const freshService = createService(github);
      const plan = await freshService.previewConfigFromGist();
      assert.ok(plan.status === "ok");
      assert.equal(plan.entries.filter((entry) => entry.kind === "add").length, 4);

      const applied = await freshService.applyConfigFromGist({
        strategy: "merge",
        expectedRemoteRevision: plan.remoteRevision,
      });
      assert.ok(applied.status === "ok");
      assert.equal(applied.applied.added, 4);

      assert.equal(
        await readFile(join(freshHome, ".zcode", "skills", "alpha", "SKILL.md"), "utf-8"),
        ALPHA_SKILL,
      );
      assert.equal(
        await readFile(join(freshHome, ".zcode", "skills", "alpha", "scripts", "run.py"), "utf-8"),
        "print('hi')\n",
      );
      const restoredBinary = await readFile(
        join(freshHome, ".zcode", "skills", "alpha", "assets", "logo.bin"),
      );
      assert.deepEqual([...restoredBinary], [...binary]);
      assert.equal(
        await readFile(join(freshHome, ".zcode", "skills", "beta", "SKILL.md"), "utf-8"),
        BETA_SKILL,
      );
    } finally {
      setDataBaseDir(previousBaseDir ?? null);
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await rm(freshHome, { recursive: true, force: true });
    }
  });
});

test("replace 下载会删除本地独有文件，merge 保留", async () => {
  const github = createFakeGithub();
  await withHome(async (home) => {
    await writeSkill(home, ".zcode", "alpha", { "SKILL.md": ALPHA_SKILL });
    const service = createService(github);
    assert.ok((await service.syncConfigToGist()).status === "ok");
  });

  await withHome(async (home) => {
    await writeSkill(home, ".zcode", "alpha", {
      "SKILL.md": ALPHA_SKILL,
      "local-only.md": "keep me\n",
    });
    const service = createService(github);
    const plan = await service.previewConfigFromGist();
    assert.ok(plan.status === "ok");
    assert.ok(
      plan.entries.some(
        (entry) => entry.name === "alpha/local-only.md" && entry.kind === "localOnly",
      ),
    );

    const merged = await service.applyConfigFromGist({
      strategy: "merge",
      expectedRemoteRevision: plan.remoteRevision,
    });
    // merge 下没有远端变更可写，只保留本地独有文件（up_to_date 不产生备份）。
    assert.ok(merged.status === "ok" || merged.status === "up_to_date");
    assert.equal(merged.applied.kept, 1);
    assert.equal(
      await readFile(join(home, ".zcode", "skills", "alpha", "local-only.md"), "utf-8"),
      "keep me\n",
    );

    const replacePlan = await service.previewConfigFromGist();
    assert.ok(replacePlan.status === "ok");
    const replaced = await service.applyConfigFromGist({
      strategy: "replace",
      expectedRemoteRevision: replacePlan.remoteRevision,
      confirmReplace: true,
    });
    assert.ok(replaced.status === "ok");
    assert.equal(replaced.applied.removed, 1);
    await assert.rejects(
      readFile(join(home, ".zcode", "skills", "alpha", "local-only.md"), "utf-8"),
    );
  });
});

test("条目名映射可逆，拒绝路径穿越", () => {
  assert.equal(skillSyncItemFileName("alpha/scripts/run.py"), "skill.alpha%2fscripts%2frun.py");
  assert.equal(
    skillSyncItemNameFromFileName("skill.alpha%2fscripts%2frun.py"),
    "alpha/scripts/run.py",
  );
  assert.equal(skillSyncItemNameFromFileName("manifest.json"), null);
  assert.equal(isValidSkillSyncItemName("alpha/../etc/passwd"), false);
  assert.equal(isValidSkillSyncItemName("/etc/passwd"), false);
  assert.equal(isValidSkillSyncItemName("C:/Windows/system32"), false);
  assert.equal(isValidSkillSyncItemName("alpha\\SKILL.md"), false);
  assert.equal(isValidSkillSyncItemName("alpha/SKILL.md"), true);
});
