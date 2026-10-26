import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { NodeToolArtifactStore } from "../src/storage/index.js";

/**
 * artifact 目录索引的语义锁定：
 * 同一会话的读取只枚举目录一次；跨进程追加 / 删除 / 替换仍能正确解析。
 * 性能依据见 specs/cli-hot-path-performance.md 第 4 节。
 */

const SESSION_ID = "sess_artifact_index";

function artifactId(index: number): string {
  return `tool-result-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function artifactUri(sessionId: string, id: string): string {
  return `zcode-artifact://${sessionId}/${id}`;
}

async function createRoot(t: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-artifact-index-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function createStore(
  rootDir: string,
  hooks?: { listDirectory?: (path: string) => Promise<string[]> },
): NodeToolArtifactStore {
  return new NodeToolArtifactStore(
    {
      imageCacheRootDir: join(rootDir, "image-cache"),
      rootDir,
      videoCacheRootDir: join(rootDir, "video-cache"),
    },
    hooks,
  );
}

async function writeArtifact(
  sessionDir: string,
  toolCallId: string,
  id: string,
  extension: string,
  content: string,
): Promise<string> {
  const fileName = `${toolCallId}-${id}${extension}`;
  await writeFile(join(sessionDir, fileName), content, "utf8");
  return fileName;
}

test("同一会话的多个 artifact 只枚举一次目录，读和 stat 共用索引", async (t) => {
  const root = await createRoot(t);
  const sessionDir = join(root, SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  const expected = new Map<string, string>();
  for (let index = 0; index < 40; index += 1) {
    const id = artifactId(index);
    const content = JSON.stringify({ index });
    await writeArtifact(sessionDir, `call-${index}`, id, ".json", content);
    expected.set(id, content);
  }

  let listCalls = 0;
  const store = createStore(root, {
    listDirectory: async (path) => {
      listCalls += 1;
      return readdir(path);
    },
  });

  for (const [id, content] of expected) {
    const result = await store.readToolResultArtifact({ uri: artifactUri(SESSION_ID, id) });
    assert.equal(result.content, content);
    assert.equal(result.bytes, Buffer.byteLength(content, "utf8"));
  }

  const firstId = artifactId(0);
  const stat = await store.statToolResultArtifact({ uri: artifactUri(SESSION_ID, firstId) });
  assert.equal(stat.bytes, Buffer.byteLength(expected.get(firstId) ?? "", "utf8"));
  assert.equal(listCalls, 1);
});

test("索引建立后另一个进程追加的 artifact 仍可读到", async (t) => {
  const root = await createRoot(t);
  const sessionDir = join(root, SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  const firstId = artifactId(1);
  await writeArtifact(sessionDir, "call-1", firstId, ".json", "first");

  let listCalls = 0;
  const store = createStore(root, {
    listDirectory: async (path) => {
      listCalls += 1;
      return readdir(path);
    },
  });

  await store.readToolResultArtifact({ uri: artifactUri(SESSION_ID, firstId) });
  assert.equal(listCalls, 1);

  // 模拟另一个 CLI 进程在索引建立之后写入。
  const lateId = artifactId(2);
  await writeArtifact(sessionDir, "call-2", lateId, ".json", "late");
  const late = await store.readToolResultArtifact({ uri: artifactUri(SESSION_ID, lateId) });
  assert.equal(late.content, "late");
  assert.equal(listCalls, 2);
});

test("缓存的文件被删除后仍返回原来的 not found 错误", async (t) => {
  const root = await createRoot(t);
  const sessionDir = join(root, SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  const id = artifactId(3);
  const fileName = await writeArtifact(sessionDir, "call-3", id, ".json", "gone");

  let listCalls = 0;
  const store = createStore(root, {
    listDirectory: async (path) => {
      listCalls += 1;
      return readdir(path);
    },
  });

  await store.readToolResultArtifact({ uri: artifactUri(SESSION_ID, id) });
  assert.equal(listCalls, 1);

  await unlink(join(sessionDir, fileName));
  await assert.rejects(
    () => store.readToolResultArtifact({ uri: artifactUri(SESSION_ID, id) }),
    /Tool artifact not found/,
  );
  assert.equal(listCalls, 2);
});

test("文件被同 artifactId 的不同文件名替换时，ENOENT 后刷新并重试一次", async (t) => {
  const root = await createRoot(t);
  const sessionDir = join(root, SESSION_ID);
  await mkdir(sessionDir, { recursive: true });
  const id = artifactId(4);
  const oldFileName = await writeArtifact(sessionDir, "call-old", id, ".json", "old");

  let listCalls = 0;
  const store = createStore(root, {
    listDirectory: async (path) => {
      listCalls += 1;
      return readdir(path);
    },
  });

  const before = await store.readToolResultArtifact({ uri: artifactUri(SESSION_ID, id) });
  assert.equal(before.content, "old");
  assert.equal(listCalls, 1);

  // 另一个进程用同一个 artifactId、不同的文件名替换了内容。
  await unlink(join(sessionDir, oldFileName));
  await writeArtifact(sessionDir, "call-new", id, ".txt", "new");
  const after = await store.readToolResultArtifact({ uri: artifactUri(SESSION_ID, id) });
  assert.equal(after.content, "new");
  assert.equal(after.contentType, "text/plain");
  assert.equal(listCalls, 2);
});

test("目录索引缓存有上限，淘汰后按需重建", async (t) => {
  const root = await createRoot(t);
  const listCalls = new Map<string, number>();
  const store = createStore(root, {
    listDirectory: async (path) => {
      listCalls.set(path, (listCalls.get(path) ?? 0) + 1);
      return readdir(path);
    },
  });

  // 上限是 64（index.ts 的 ARTIFACT_DIRECTORY_INDEX_CACHE_LIMIT），多开两个确保第一个被淘汰。
  const sessionCount = 66;
  for (let index = 0; index < sessionCount; index += 1) {
    const sessionId = `${SESSION_ID}_${index}`;
    const sessionDir = join(root, sessionId);
    await mkdir(sessionDir, { recursive: true });
    const id = artifactId(index);
    await writeArtifact(sessionDir, `call-${index}`, id, ".json", "{}");
    await store.readToolResultArtifact({ uri: artifactUri(sessionId, id) });
  }

  const firstSession = `${SESSION_ID}_0`;
  const firstDir = join(root, firstSession);
  assert.equal(listCalls.get(firstDir), 1);

  await store.readToolResultArtifact({ uri: artifactUri(firstSession, artifactId(0)) });
  assert.equal(listCalls.get(firstDir), 2);
});
