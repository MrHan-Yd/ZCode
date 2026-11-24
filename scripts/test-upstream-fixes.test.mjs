import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const groups = [
  "apps/zcode-cli/packages/core",
  "apps/zcode-cli/packages/adapters",
  "packages/services",
  "packages/desktop",
];

async function json(path) {
  return JSON.parse(await readFile(join(root, path), "utf8"));
}

test("上游严重修复回归入口保留原门禁并纳入提交前验证", async () => {
  const manifest = await json("package.json");
  assert.equal(manifest.scripts["test:upstream-fixes"], "node scripts/test-upstream-fixes.mjs");
  assert.match(manifest.scripts["verify:pre-push"], /pnpm run test:upstream-fixes/u);
  assert.match(manifest.scripts["verify:pre-push"], /pnpm run test:release/u);
  assert.match(manifest.scripts.typecheck, /packages\/services\/tsconfig\.test\.json/u);
  assert.match(manifest.scripts.typecheck, /core\/tsconfig\.orchestration-test\.json/u);

  for (const group of groups.filter((group) => group !== "packages/services")) {
    assert.ok(manifest.scripts.typecheck.includes(`${group}/tsconfig.upstream-test.json`));
    const config = await json(`${group}/tsconfig.upstream-test.json`);
    assert.ok(config.include.includes("test/upstream*.test.ts"));
    assert.equal(config.compilerOptions.noEmit, true);
  }
});

test("回归运行器异步枚举所有正式修复测试并显式使用隔离 mock", async () => {
  const runner = await readFile(join(root, "scripts/test-upstream-fixes.mjs"), "utf8");
  assert.match(runner, /--experimental-test-module-mocks/u);
  assert.match(runner, /--import/u);
  assert.match(runner, /TSX_TSCONFIG_PATH/u);
  assert.match(runner, /process\.exitCode = failed \? 1 : 0/u);

  for (const group of groups) {
    assert.ok(runner.includes(group));
    const entries = await readdir(join(root, group, "test"));
    assert.ok(
      entries.some((name) => /^upstream.*\.test\.ts$/u.test(name)),
      `Missing formal regression tests in ${group}`,
    );
  }
});
