import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createConfigSyncMetadataStore } from "../src/config-sync/metadata.js";
import { USER_CONFIG_SYNC_SCOPE, type ConfigSyncScope } from "../src/config-sync/scope.js";

/**
 * 元数据是「一份文件、按作用域分片」：用户级与项目级各自记住自己的 gist。
 * 这里覆盖分片隔离、v1 迁移与同文件并发写。
 */

const WORKSPACE_SCOPE: ConfigSyncScope = { kind: "workspace", label: "my-project" };

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-config-sync-metadata-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readEnvelope(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf-8")) as Record<string, unknown>;
}

test("没有元数据文件时按空记录处理", async () => {
  await withTempDir(async (dir) => {
    const store = createConfigSyncMetadataStore(async () => join(dir, "sync.json"));
    assert.deepEqual(await store.read(), {});
  });
});

test("写入后能读回，磁盘上是 v2 信封", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "sync.json");
    const store = createConfigSyncMetadataStore(async () => filePath, USER_CONFIG_SYNC_SCOPE);

    await store.write({ gistId: "gist-user", lastRemoteRevision: 2, lastSyncedAt: 1_700_000 });
    assert.deepEqual(await store.read(), {
      gistId: "gist-user",
      lastRemoteRevision: 2,
      lastSyncedAt: 1_700_000,
    });

    const envelope = await readEnvelope(filePath);
    assert.equal(envelope.schemaVersion, 2);
    assert.deepEqual(envelope.user, {
      gistId: "gist-user",
      lastRemoteRevision: 2,
      lastSyncedAt: 1_700_000,
    });
  });
});

test("两个作用域互不覆盖：写项目级不动用户级记录", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "sync.json");
    const userStore = createConfigSyncMetadataStore(async () => filePath, USER_CONFIG_SYNC_SCOPE);
    const workspaceStore = createConfigSyncMetadataStore(async () => filePath, WORKSPACE_SCOPE);

    await userStore.write({ gistId: "gist-user", lastRemoteRevision: 1 });
    await workspaceStore.write({ gistId: "gist-workspace", lastRemoteRevision: 7 });

    assert.deepEqual(await userStore.read(), { gistId: "gist-user", lastRemoteRevision: 1 });
    assert.deepEqual(await workspaceStore.read(), {
      gistId: "gist-workspace",
      lastRemoteRevision: 7,
    });

    const envelope = await readEnvelope(filePath);
    assert.deepEqual(envelope.user, { gistId: "gist-user", lastRemoteRevision: 1 });
    assert.deepEqual(envelope.workspaces, {
      "my-project": { gistId: "gist-workspace", lastRemoteRevision: 7 },
    });
  });
});

test("同名 label 的另一个项目共用同一片记录（已知取舍）", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "sync.json");
    const store = createConfigSyncMetadataStore(async () => filePath, WORKSPACE_SCOPE);
    await store.write({ gistId: "gist-shared" });

    // 另一个目录但同名 → 同一个作用域键，读到的是同一份记录。
    const otherStore = createConfigSyncMetadataStore(async () => filePath, {
      kind: "workspace",
      label: "my-project",
    });
    assert.deepEqual(await otherStore.read(), { gistId: "gist-shared" });
  });
});

test("v1 扁平格式按用户级记录读，并在下一次写入时落成 v2", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "sync.json");
    await writeFile(
      filePath,
      `${JSON.stringify(
        { schemaVersion: 1, gistId: "gist-legacy", lastRemoteRevision: 3, lastSyncedAt: 42 },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const userStore = createConfigSyncMetadataStore(async () => filePath, USER_CONFIG_SYNC_SCOPE);
    assert.deepEqual(await userStore.read(), {
      gistId: "gist-legacy",
      lastRemoteRevision: 3,
      lastSyncedAt: 42,
    });

    // 项目级在 v1 里没有对应记录，读成空。
    const workspaceStore = createConfigSyncMetadataStore(async () => filePath, WORKSPACE_SCOPE);
    assert.deepEqual(await workspaceStore.read(), {});

    await workspaceStore.write({ gistId: "gist-workspace" });
    const envelope = await readEnvelope(filePath);
    assert.equal(envelope.schemaVersion, 2);
    // 迁移不能丢掉旧的用户级 gist。
    assert.deepEqual(envelope.user, {
      gistId: "gist-legacy",
      lastRemoteRevision: 3,
      lastSyncedAt: 42,
    });
    assert.deepEqual(envelope.workspaces, { "my-project": { gistId: "gist-workspace" } });
  });
});

test("无法解析的元数据按不存在处理，不抛错", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "sync.json");
    await writeFile(filePath, "{ not json", "utf-8");
    const store = createConfigSyncMetadataStore(async () => filePath);
    assert.deepEqual(await store.read(), {});

    await writeFile(filePath, JSON.stringify({ schemaVersion: 99, user: { gistId: "x" } }), "utf-8");
    assert.deepEqual(await store.read(), {});
  });
});

test("两个作用域并发写同一文件时不丢更新", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "sync.json");
    const userStore = createConfigSyncMetadataStore(async () => filePath, USER_CONFIG_SYNC_SCOPE);
    const workspaceStore = createConfigSyncMetadataStore(async () => filePath, WORKSPACE_SCOPE);

    // 元数据写入发生在写队列之外，两个作用域共用一份文件：并发读改写必须串行，否则后写的会覆盖前一片。
    await Promise.all([
      userStore.write({ gistId: "gist-user" }),
      workspaceStore.write({ gistId: "gist-workspace" }),
    ]);

    assert.deepEqual(await userStore.read(), { gistId: "gist-user" });
    assert.deepEqual(await workspaceStore.read(), { gistId: "gist-workspace" });
  });
});
