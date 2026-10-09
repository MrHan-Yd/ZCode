import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { getMemoryCliStorageRoot } from "../src/app/paths.js";

/**
 * 记忆根必须与设置页同根。回归护栏：曾经 memory.cliStorageRoot 直接取 CLI 自己的
 * storage.dir（默认 ~/.zcode），不认 ZCODE_DATA_BASE_DIR，导致数据根搬家后 agent 把新记忆
 * 写进旧根，而设置页按 <dataBaseDir> 读，两端永久分叉。见 specs/memory-data-root-continuity.md。
 */
const LOCAL_CLI_STORAGE_ROOT = join("C:", "Users", "me", ".zcode", "cli");

test("记忆根：设置了数据根时跟随 <dataBaseDir>/.zcode/cli", () => {
  const dataBaseDir = join("D:", "ZCode", "data");

  assert.equal(
    getMemoryCliStorageRoot(LOCAL_CLI_STORAGE_ROOT, { ZCODE_DATA_BASE_DIR: dataBaseDir }),
    join(dataBaseDir, ".zcode", "cli"),
  );
});

test("记忆根：与设置页 catalog 解析到同一个 projects 目录", () => {
  const dataBaseDir = join("D:", "ZCode", "data");
  const memoryCliStorageRoot = getMemoryCliStorageRoot(LOCAL_CLI_STORAGE_ROOT, {
    ZCODE_DATA_BASE_DIR: dataBaseDir,
  });

  // memoryService 的当前生效根：getZCodeDataRootDir() + "/cli/memories/projects"。
  assert.equal(
    join(memoryCliStorageRoot, "memories", "projects"),
    join(dataBaseDir, ".zcode", "cli", "memories", "projects"),
  );
});

test("记忆根：未设置或空白数据根时保持 CLI 本地 storage.dir 行为", () => {
  assert.equal(getMemoryCliStorageRoot(LOCAL_CLI_STORAGE_ROOT, {}), LOCAL_CLI_STORAGE_ROOT);
  assert.equal(
    getMemoryCliStorageRoot(LOCAL_CLI_STORAGE_ROOT, { ZCODE_DATA_BASE_DIR: "   " }),
    LOCAL_CLI_STORAGE_ROOT,
  );
});

test("记忆根：只覆盖记忆，不改动传入的 storage.dir 本身", () => {
  const dataBaseDir = join("D:", "ZCode", "data");
  const argument = LOCAL_CLI_STORAGE_ROOT;

  getMemoryCliStorageRoot(argument, { ZCODE_DATA_BASE_DIR: dataBaseDir });

  assert.equal(argument, LOCAL_CLI_STORAGE_ROOT);
});
