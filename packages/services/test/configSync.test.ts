import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfigSyncBackup, isKnownBackupDir } from "../src/config-sync/backup.js";
import {
  buildRemoteFiles,
  canonicalJson,
  computeFingerprint,
  CONFIG_SYNC_MANIFEST_FILE_NAME,
  findOversizedItem,
  parseManifest,
  parseRemoteFiles,
  sha256Hex,
} from "../src/config-sync/manifest.js";
import { buildPlan, countPlanEntries, resolveApplySet } from "../src/config-sync/plan.js";
import { scanSecrets } from "../src/config-sync/secretScan.js";
import type { ConfigSyncItem, ConfigSyncProfile } from "../src/config-sync/types.js";

/** 测试用 profile：条目文件名 `item.<name>.json`，内容必须是合法 JSON 对象。 */
const PROFILE: ConfigSyncProfile = {
  fileNameFor: (name) => (name.includes("/") ? null : `item.${name}.json`),
  nameFromFileName: (fileName) => {
    if (!fileName.startsWith("item.") || !fileName.endsWith(".json")) return null;
    const name = fileName.slice("item.".length, -".json".length);
    return name.includes("/") ? null : name;
  },
  isValidContent: (_fileName, content) => {
    try {
      return typeof JSON.parse(content) === "object" && JSON.parse(content) !== null;
    } catch {
      return false;
    }
  },
  extraFileNames: ["extra.json"],
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};

function item(name: string, value: unknown = { name }): ConfigSyncItem {
  return { name, content: canonicalJson(value) };
}

/** 构造一份与 buildRemoteFiles 产出一致的远端 gist files。 */
function remoteFiles(
  items: readonly ConfigSyncItem[],
  options: {
    revision?: number;
    extras?: readonly { fileName: string; content: string }[];
    extraFiles?: Record<string, unknown>;
  } = {},
) {
  const built = buildRemoteFiles(PROFILE, {
    items,
    extras: options.extras ?? [],
    revision: options.revision ?? 1,
    updatedAt: "2026-10-17T00:00:00.000Z",
    previousFileNames: [],
  });
  assert.ok(built);
  const files: Record<string, unknown> = {};
  for (const [name, content] of Object.entries(built.files)) {
    files[name] = content === null ? null : { content, truncated: false };
  }
  return { files: { ...files, ...options.extraFiles }, manifest: built.manifest };
}

test("canonicalJson 键排序：对象顺序不同也产出同一份文本", () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: 2, c: 3 } }),
    canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
  );
  assert.equal(canonicalJson({ a: 1 }).endsWith("\n"), true);
});

test("指纹与条目顺序无关，内容或额外通道变化都会改变指纹", () => {
  const a = item("a");
  const b = item("b");
  assert.equal(computeFingerprint([a, b], []), computeFingerprint([b, a], []));
  assert.notEqual(
    computeFingerprint([a, b], []),
    computeFingerprint([a, item("b", { name: "b2" })], []),
  );
  assert.notEqual(
    computeFingerprint([a, b], []),
    computeFingerprint([a, b], [{ fileName: "extra.json", content: "{}" }]),
  );
});

test("manifest 校验：schemaVersion 必须为 1，且拒绝未知字段", () => {
  const { manifest } = remoteFiles([item("a")]);
  assert.ok(parseManifest(manifest));
  assert.equal(parseManifest({ ...manifest, schemaVersion: 2 }), null);
  assert.equal(parseManifest({ ...manifest, extra: true }), null);
  assert.equal(parseManifest({ ...manifest, items: [{ name: "a" }] }), null);
});

test("远端解析：校验 sha256、必填文件、额外通道与内容可加载性", () => {
  const { files } = remoteFiles([item("a")], {
    extras: [{ fileName: "extra.json", content: canonicalJson({ disabled: ["x"] }) }],
  });
  const parsed = parseRemoteFiles(PROFILE, files);
  assert.equal(parsed.status, "ok");
  assert.ok(parsed.status === "ok");
  assert.deepEqual(
    parsed.items.map((entry) => entry.name),
    ["a"],
  );
  assert.equal(parsed.extras.get("extra.json"), canonicalJson({ disabled: ["x"] }));

  // 内容被篡改：sha256 不一致。
  assert.equal(
    parseRemoteFiles(PROFILE, { ...files, "item.a.json": { content: "{}", truncated: false } })
      .status,
    "invalid",
  );
  // 缺条目文件。
  const missing = { ...files };
  delete (missing as Record<string, unknown>)["item.a.json"];
  assert.equal(parseRemoteFiles(PROFILE, missing).status, "invalid");
  // 缺 manifest。
  assert.equal(parseRemoteFiles(PROFILE, {}).status, "invalid");
  // 额外通道被 manifest 声明为未知文件。
  const unknownExtra = JSON.parse(
    (files[CONFIG_SYNC_MANIFEST_FILE_NAME] as { content: string }).content,
  ) as {
    extras: { fileName: string; sha256: string }[];
  };
  unknownExtra.extras = [{ fileName: "other.json", sha256: sha256Hex("{}") }];
  assert.equal(
    parseRemoteFiles(PROFILE, {
      ...files,
      "other.json": { content: "{}", truncated: false },
      [CONFIG_SYNC_MANIFEST_FILE_NAME]: {
        content: `${JSON.stringify(unknownExtra)}\n`,
        truncated: false,
      },
    }).status,
    "invalid",
  );
});

test("远端解析：内容无法被本功能加载时按 remote_invalid 拒绝", () => {
  const content = "不是 JSON";
  const { files } = remoteFiles([item("a")]);
  const manifest = JSON.parse(
    (files[CONFIG_SYNC_MANIFEST_FILE_NAME] as { content: string }).content,
  ) as {
    items: { name: string; fileName: string; sha256: string; bytes: number }[];
  };
  manifest.items = manifest.items.map((entry) => ({
    ...entry,
    sha256: sha256Hex(content),
    bytes: content.length,
  }));
  const parsed = parseRemoteFiles(PROFILE, {
    ...files,
    "item.a.json": { content, truncated: false },
    [CONFIG_SYNC_MANIFEST_FILE_NAME]: {
      content: `${JSON.stringify(manifest)}\n`,
      truncated: false,
    },
  });
  assert.equal(parsed.status, "invalid");
  assert.ok(parsed.status !== "ok");
  assert.match(parsed.message, /item\.a\.json/);
});

test("远端解析：manifest 未登记的文件进 skipped，不当作失败", () => {
  const { files } = remoteFiles([item("a")], {
    extraFiles: { "notes.md": { content: "手工说明", truncated: false } },
  });
  const parsed = parseRemoteFiles(PROFILE, files);
  assert.ok(parsed.status === "ok");
  assert.deepEqual(parsed.skipped, [{ fileName: "notes.md", reason: "unknown_file" }]);
});

test("上传文件集合：镜像远端，已删除的条目文件传 null", () => {
  const kept = item("keep");
  const built = buildRemoteFiles(PROFILE, {
    items: [kept],
    extras: [{ fileName: "extra.json", content: "{}" }],
    revision: 4,
    updatedAt: "2026-10-17T00:00:00.000Z",
    previousFileNames: ["manifest.json", "extra.json", "item.keep.json", "item.gone.json"],
  });
  assert.ok(built);
  assert.equal(built.files["item.gone.json"], null);
  assert.equal(built.files["item.keep.json"], kept.content);
  assert.equal(built.files["extra.json"], "{}");
  assert.equal(built.manifest.revision, 4);
  assert.deepEqual(
    built.manifest.extras.map((extra) => extra.fileName),
    ["extra.json"],
  );
});

test("名称无法映射到远端文件名：整体失败而不是静默丢条目", () => {
  assert.equal(
    buildRemoteFiles(PROFILE, {
      items: [item("bad/name")],
      extras: [],
      revision: 1,
      updatedAt: "2026-10-17T00:00:00.000Z",
      previousFileNames: [],
    }),
    null,
  );
});

test("大小上限：单文件或总量超限时点名条目", () => {
  assert.equal(findOversizedItem(PROFILE, [item("ok")]), null);
  assert.equal(findOversizedItem(PROFILE, [item("huge", "x".repeat(600 * 1024))]), "huge");
});

test("计划与写盘集合：add/update/same/localOnly，merge 保留本地独有项、replace 删除", () => {
  const { manifest } = remoteFiles([item("same"), item("new")]);
  const remoteItems = [item("same"), item("new")];
  const plan = buildPlan({
    localItems: [item("same"), item("local")],
    remoteItems,
    localFingerprint: "fp-2",
    manifest,
    gistId: "0123456789abcdef",
    gistUrl: "https://gist.github.com/0123456789abcdef",
    skipped: [],
    lastLocalFingerprint: "fp-1",
  });
  assert.deepEqual(
    plan.entries.map((entry) => [entry.name, entry.kind]),
    [
      ["local", "localOnly"],
      ["new", "add"],
      ["same", "same"],
    ],
  );
  assert.equal(plan.localChangedSinceLastSync, true);
  assert.equal(plan.gistIdShort, "01234567");
  assert.deepEqual(countPlanEntries(plan.entries), { add: 1, update: 0, same: 1, localOnly: 1 });

  const merged = resolveApplySet({ entries: plan.entries, remoteItems, strategy: "merge" });
  assert.deepEqual(
    merged.writes.map((write) => write.name),
    ["new"],
  );
  assert.deepEqual(merged.removals, []);
  assert.equal(merged.kept, 1);
  assert.equal(merged.added, 1);
  assert.equal(merged.updated, 0);

  const replaced = resolveApplySet({ entries: plan.entries, remoteItems, strategy: "replace" });
  assert.deepEqual(replaced.removals, ["local"]);
  assert.equal(replaced.kept, 0);
});

test("计划：本地未改动时 localChangedSinceLastSync 为 false", () => {
  const { manifest } = remoteFiles([item("same")]);
  const plan = buildPlan({
    localItems: [item("same")],
    remoteItems: [item("same")],
    localFingerprint: "fp",
    manifest,
    gistId: "abcdefgh",
    gistUrl: "https://gist.github.com/abcdefgh",
    skipped: [],
    lastLocalFingerprint: "fp",
  });
  assert.equal(plan.localChangedSinceLastSync, false);
  assert.deepEqual(
    plan.entries.map((entry) => entry.kind),
    ["same"],
  );
});

test("密钥扫描：只报文件名/行号/规则名，不回命中值", () => {
  const content = ["# agent", "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ok"].join("\n");
  const warnings = scanSecrets("leaky.md", content);
  assert.equal(warnings.length, 1);
  assert.deepEqual(warnings[0], { fileName: "leaky.md", line: 2, pattern: "github_token" });
  assert.equal(JSON.stringify(warnings).includes("ghp_abcdefghijklmnopqrstuvwxyz"), false);
  assert.deepEqual(scanSecrets("clean.md", "nothing to see"), []);
});

test("备份：list 只列完整备份并按时间倒序，restore 覆盖目录与文件两种目标", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-config-sync-backup-"));
  try {
    const agentsDir = join(dir, "agents");
    const stateFile = join(dir, "agents-state.json");
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, "a.md"), "A", "utf-8");
    await writeFile(stateFile, "STATE", "utf-8");

    const backup = createConfigSyncBackup({
      rootDir: async () => join(dir, "backups"),
      entries: async () => [
        { source: agentsDir, name: "agents" },
        { source: stateFile, name: "agents-state.json" },
      ],
    });

    const first = await backup.create();
    await writeFile(join(agentsDir, "a.md"), "A2", "utf-8");
    await writeFile(stateFile, "STATE2", "utf-8");
    const second = await backup.create();

    // 坏备份（缺声明条目）不展示。
    await mkdir(join(dir, "backups", "1"), { recursive: true });
    const list = await backup.list();
    assert.deepEqual(
      list.backups.map((entry) => entry.backupDir),
      [second, first],
    );
    assert.equal(list.backupRoot, join(dir, "backups"));

    // 还原到第一份：目录与文件都被整份覆盖。
    assert.equal(await backup.restore(first), true);
    assert.equal(await readFile(join(agentsDir, "a.md"), "utf-8"), "A");
    assert.equal(await readFile(stateFile, "utf-8"), "STATE");
    // 第二份备份仍在，可再还原回来。
    assert.equal(await backup.restore(second), true);
    assert.equal(await readFile(join(agentsDir, "a.md"), "utf-8"), "A2");

    // 只接受真实存在的完整备份。
    assert.equal(await isKnownBackupDir(backup, join(dir, "backups", "1")), false);
    assert.equal(await isKnownBackupDir(backup, second), true);
    assert.equal(await isKnownBackupDir(backup, "/tmp/whatever"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("备份保留策略：超出份数上限与超过 30 天的都会被清理", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-config-sync-prune-"));
  try {
    const stateFile = join(dir, "state.json");
    await writeFile(stateFile, "S", "utf-8");
    const rootDir = join(dir, "backups");
    const entries = async () => [{ source: stateFile, name: "state.json" }];

    // 预置一份「31 天前」的备份。
    const oldDir = join(rootDir, String(Date.now() - 31 * 24 * 60 * 60 * 1000));
    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, "state.json"), "OLD", "utf-8");

    const backup = createConfigSyncBackup({ rootDir: async () => rootDir, entries, maxBackups: 2 });
    await backup.create();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await backup.create();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await backup.create();

    const { backups } = await backup.list();
    assert.equal(backups.length, 2);
    assert.equal(
      backups.some((entry) => entry.backupDir === oldDir),
      false,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
