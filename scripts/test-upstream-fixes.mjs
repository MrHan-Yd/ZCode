import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const groups = [
  "apps/zcode-cli/packages/core",
  "apps/zcode-cli/packages/adapters",
  "packages/services",
  "packages/desktop",
];

async function runTests(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Upstream tests stopped by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function runGroup(directory) {
  const testDirectory = join(root, directory, "test");
  const entries = await readdir(testDirectory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /^upstream.*\.test\.ts$/u.test(entry.name))
    .map((entry) => join(testDirectory, entry.name))
    .sort();
  if (files.length === 0) throw new Error(`No upstream regression tests in ${directory}`);

  process.stdout.write(`\n[upstream-fixes] ${directory}: ${files.length} test files\n`);
  return runTests(["--experimental-test-module-mocks", "--import", "tsx", "--test", ...files], {
    ...process.env,
    TSX_TSCONFIG_PATH: join(root, directory, "tsconfig.json"),
  });
}

let failed =
  (await runTests(["--test", join(root, "scripts/test-upstream-fixes.test.mjs")], process.env)) !==
  0;
for (const directory of groups) {
  try {
    if ((await runGroup(directory)) !== 0) failed = true;
  } catch (error) {
    failed = true;
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  }
}
process.exitCode = failed ? 1 : 0;
