import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { copyDataDirectory } from "../src/paths.js";

/**
 * 数据根搬迁的回归护栏。原先 copyDataDirectory 只复制 .zcode/v2，记忆留在旧根，
 * 于是运行时按新根写入、设置页按新根读取，而旧记忆"存在但不生效"。
 * 见 specs/memory-data-root-continuity.md。
 */
async function withTempRoots(
  run: (oldRoot: string, newRoot: string) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "zcode-datadir-"));
  try {
    await run(join(base, "old"), join(base, "new"));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

function memoryFilePath(root: string, projectKey: string): string {
  return join(root, ".zcode", "cli", "memories", "projects", projectKey, "memory", "MEMORY.md");
}

/**
 * v2 是既有迁移的硬前提：`copyDataDirectory` 对 `<old>/.zcode/v2` 直接 cp，
 * 源不存在会 ENOENT（沿用改动前语义，本次不动）。真实环境里 setting.json 就住在 v2 下，
 * 所以它总是存在；测试需要显式造出来。
 */
async function seedV2(root: string): Promise<void> {
  await mkdir(join(root, ".zcode", "v2"), { recursive: true });
}

test("数据目录迁移：复制 .zcode/v2 且不带 setting.json 及其原子写入中间态", async () => {
  await withTempRoots(async (oldRoot, newRoot) => {
    await mkdir(join(oldRoot, ".zcode", "v2"), { recursive: true });
    await writeFile(join(oldRoot, ".zcode", "v2", "app.json"), '{"a":1}');
    await writeFile(join(oldRoot, ".zcode", "v2", "setting.json"), "{}");
    await writeFile(join(oldRoot, ".zcode", "v2", "setting.json.lock"), "");

    await copyDataDirectory(oldRoot, newRoot);

    assert.equal(await readFile(join(newRoot, ".zcode", "v2", "app.json"), "utf-8"), '{"a":1}');
    assert.equal(existsSync(join(newRoot, ".zcode", "v2", "setting.json")), false);
    assert.equal(existsSync(join(newRoot, ".zcode", "v2", "setting.json.lock")), false);
  });
});

test("数据目录迁移：记忆随数据根一起搬走", async () => {
  await withTempRoots(async (oldRoot, newRoot) => {
    await seedV2(oldRoot);
    const source = memoryFilePath(oldRoot, "zcode-6d6cfff4d1c472d5");
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, "- 一条记忆\n");

    await copyDataDirectory(oldRoot, newRoot);

    assert.equal(
      await readFile(memoryFilePath(newRoot, "zcode-6d6cfff4d1c472d5"), "utf-8"),
      "- 一条记忆\n",
    );
  });
});

test("数据目录迁移：目标已存在的记忆文件不被覆盖", async () => {
  await withTempRoots(async (oldRoot, newRoot) => {
    await seedV2(oldRoot);
    const source = memoryFilePath(oldRoot, "proj-abc123");
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, "旧根内容\n");

    const target = memoryFilePath(newRoot, "proj-abc123");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "新根已有内容\n");

    await copyDataDirectory(oldRoot, newRoot);

    assert.equal(await readFile(target, "utf-8"), "新根已有内容\n");
  });
});

test("数据目录迁移：源目录没有记忆时不失败", async () => {
  await withTempRoots(async (oldRoot, newRoot) => {
    await seedV2(oldRoot);
    await writeFile(join(oldRoot, ".zcode", "v2", "app.json"), "{}");

    await copyDataDirectory(oldRoot, newRoot);

    assert.equal(existsSync(join(newRoot, ".zcode", "cli", "memories")), false);
  });
});
