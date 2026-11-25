import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { selectDesktopRegressionGroups } from "./test-desktop-regressions.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const files = (args) => selectDesktopRegressionGroups(args).flatMap((group) => group.files);

function runList(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["scripts/test-desktop-regressions.mjs", ...args, "--list"],
      { cwd: root, windowsHide: true, env: process.env },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

test("默认清单保留 headless 回归但不自动启动 About 真实桌面采样", () => {
  const selected = files([]);
  assert.ok(selected.includes("packages/ui/test/contextUsageSubagents.browser.test.ts"));
  assert.ok(selected.includes("packages/ui/test/statusPanelSendAutoOpen.browser.test.ts"));
  assert.ok(selected.includes("packages/desktop/test/aboutDialog.test.ts"));
  assert.ok(selected.includes("packages/desktop/test/desktopFrameSampler.test.ts"));
  assert.equal(selected.includes("packages/desktop/test/aboutDialog.browser.test.ts"), false);
  assert.equal(new Set(selected).size, selected.length);
});

test("Git suite 包含图谱服务、单行筛选与浏览器回归，不运行原生 About", () => {
  const selected = files(["--suite=git"]);
  for (const path of [
    "packages/services/test/gitCommitGraphFilters.test.ts",
    "packages/services/test/gitCommitGraphSafety.test.ts",
    "packages/ui/test/gitGraphFilters.test.ts",
    "packages/ui/test/gitGraphFilters.browser.test.ts",
  ])
    assert.ok(selected.includes(path));
  assert.equal(
    selected.some((path) => path.includes("aboutDialog")),
    false,
  );
  assert.equal(new Set(selected).size, selected.length);
});

test("Context 功能只选择上下文回归，多个 suite 并集不重复执行", () => {
  assert.deepEqual(files(["--suite", "context"]), [
    "packages/ui/test/contextUsageSubagents.browser.test.ts",
  ]);
  const combined = files(["--suite=about", "--suite", "context", "--suite=about"]);
  assert.ok(combined.includes("packages/ui/test/aboutDialogHost.test.ts"));
  assert.ok(combined.includes("packages/ui/test/contextUsageSubagents.browser.test.ts"));
  assert.equal(new Set(combined).size, combined.length);
  assert.equal(combined.includes("packages/desktop/test/aboutDialog.browser.test.ts"), false);
});

test("原生采样只能显式选择且保留原有断言与类型工程", () => {
  const selected = selectDesktopRegressionGroups(["--suite", "about", "--native"]);
  assert.ok(
    selected.some(
      (group) =>
        group.project === "packages/desktop/tsconfig.upstream-test.json" &&
        group.files.includes("packages/desktop/test/aboutDialog.browser.test.ts"),
    ),
  );
  const all = files(["--native"]);
  assert.ok(all.includes("packages/desktop/test/aboutDialog.browser.test.ts"));
  assert.equal(new Set(all).size, all.length);
});

test("功能并集与默认清单一致，未知或空参数必须失败", () => {
  assert.deepEqual(
    files([
      "--suite=about",
      "--suite=performance",
      "--suite=context",
      "--suite=git",
      "--suite=status",
    ]),
    files([]),
  );
  for (const args of [["--suite"], ["--suite="], ["--suite=unknown"], ["--ignore-errors"]])
    assert.throws(() => selectDesktopRegressionGroups(args));
});

test("清单模式只列出选中测试，不启动 fixture 或测试进程", async () => {
  const result = await runList(["--suite=context"]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /packages\/ui\/test\/contextUsageSubagents\.browser\.test\.ts/u);
  assert.doesNotMatch(result.stdout, /About|electron|[✔✖]/u);
});
