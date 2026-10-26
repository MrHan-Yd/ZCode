import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { getCliNodeCompileCacheDir, setDataBaseDir } from "../src/paths.js";

test("CLI 编译缓存目录跟随数据根", () => {
  setDataBaseDir("/tmp/zcode-compile-cache-base");
  try {
    assert.equal(
      getCliNodeCompileCacheDir(),
      join("/tmp/zcode-compile-cache-base", ".zcode", "cli", "node-compile-cache"),
    );
  } finally {
    setDataBaseDir(null);
  }
});
