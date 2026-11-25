import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { extractPrebuiltArchive } from "./prebuilt-binary-extract.mjs";
import { selectDesktopRegressionGroups } from "./test-desktop-regressions.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const workflow = parse(await readFile(join(ROOT, ".github/workflows/release-desktop.yml"), "utf8"));
const RELEASE_REF = "${{ github.event.inputs.tag || github.ref }}";
const ACTION_VERSIONS = {
  "actions/checkout": "v7.0.1",
  "pnpm/action-setup": "v6.1.1",
  "actions/setup-node": "v7.1.0",
  "actions/upload-artifact": "v7.0.2",
  "actions/download-artifact": "v8.0.2",
  "softprops/action-gh-release": "v3.0.4",
};
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

function runPowerShell(command, env = process.env) {
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    {
      encoding: "utf8",
      env,
    },
  );
  if (result.error) throw result.error;
  return result;
}

test("手动重跑和普通标签构建均显式绑定同一源码标签", () => {
  for (const job of [workflow.jobs.build, workflow.jobs.release]) {
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout?.with?.ref, RELEASE_REF);
  }
  assert.equal(
    workflow.concurrency.group,
    "release-desktop-${{ github.event.inputs.tag || github.ref_name }}",
  );
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.equal(workflow.jobs.release.needs, "build");
});

test("官方 Action 使用 Node24 版本，项目 Node 与 pnpm 不改", () => {
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (!step.uses) continue;
      const [action, version] = step.uses.split("@");
      assert.ok(ACTION_VERSIONS[action], `Unverified release Action: ${action}`);
      assert.equal(version, ACTION_VERSIONS[action]);
    }
  }
  const node = workflow.jobs.build.steps.find((step) =>
    step.uses?.startsWith("actions/setup-node@"),
  );
  const pnpm = workflow.jobs.build.steps.find((step) =>
    step.uses?.startsWith("pnpm/action-setup@"),
  );
  assert.equal(node.with["node-version"], "24.14.0");
  assert.equal(pnpm.with.version, "10.33.2");
  assert.equal(workflow.jobs.build.defaults.run.shell, "bash");
});

test("发行回归在安装后、打包前执行，旧标签明确记录跳过", () => {
  const steps = workflow.jobs.build.steps;
  const tests = steps.findIndex((step) => step.id === "release-regressions");
  const install = steps.findIndex((step) => step.name === "安装依赖");
  const bootstrap = steps.findIndex((step) => step.name?.startsWith("初始化"));
  assert.ok(tests > install && tests < bootstrap);
  assert.match(steps[tests].run, /pnpm test:release/u);
  assert.match(steps[tests].run, /test:release/u);
  assert.match(steps[tests].run, /notice/u);
});

test("提交前门禁执行同一发行回归入口", async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.match(manifest.scripts["test:release"], /release-desktop-ci\.test\.mjs/u);
  assert.match(manifest.scripts["test:release"], /native-search-tools\.test\.mjs/u);
  assert.match(manifest.scripts["verify:pre-push"], /pnpm (?:run )?test:release/u);
});

test("桌面回归按所选文件串行执行，原生屏幕采样只在显式入口运行", async () => {
  const runner = await readFile(join(ROOT, "scripts/test-desktop-regressions.mjs"), "utf8");
  assert.match(runner, /"--test-concurrency=1"/u);
  assert.match(runner, /"--experimental-test-module-mocks"/u);
  assert.match(runner, /for \(const group of selectedGroups\)/u);
  assert.match(runner, /TSX_TSCONFIG_PATH: join\(root, group\.project\)/u);
  const selected = selectDesktopRegressionGroups().flatMap((group) => group.files);
  for (const file of [
    "gitCommitMessageModel.browser.test.ts",
    "gitToolsPanelAlignment.browser.test.ts",
    "sessionPerformanceStats.browser.test.ts",
    "statusPanelSendAutoOpen.browser.test.ts",
    "contextUsageSubagents.browser.test.ts",
    "desktopFrameSampler.test.ts",
  ])
    assert.ok(
      selected.some((path) => path.endsWith(file)),
      `默认回归不得漏掉 ${file}`,
    );
  assert.equal(
    selected.some((path) => path.endsWith("aboutDialog.browser.test.ts")),
    false,
  );
  const native = selectDesktopRegressionGroups(["--suite", "about", "--native"]).flatMap(
    (group) => group.files,
  );
  assert.ok(native.some((path) => path.endsWith("aboutDialog.browser.test.ts")));
  const manifest = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
  assert.match(manifest.scripts["test:desktop-native"], /--suite about --native/u);
  assert.doesNotMatch(manifest.scripts["verify:pre-push"], /test:desktop-native|--native/u);
  assert.match(runner, /if \(code !== 0\)/u);
});

test("GitHub Actions 依赖更新只创建维护 PR，不定时发布", async () => {
  const config = parse(await readFile(join(ROOT, ".github/dependabot.yml"), "utf8"));
  const actions = config.updates.find((update) => update["package-ecosystem"] === "github-actions");
  assert.equal(actions.directory, "/");
  assert.equal(actions.schedule.interval, "weekly");
  assert.equal(workflow.on.schedule, undefined);
});

test("Windows 模块环境准备先于安装与构建，并显式导出 PSModulePath", () => {
  const steps = workflow.jobs.build.steps;
  const index = steps.findIndex((step) => step.id === "windows-powershell");
  assert.ok(index >= 0);
  const setup = steps[index];
  assert.equal(setup.if, "runner.os == 'Windows'");
  assert.equal(setup.shell, "powershell");
  assert.match(setup.run, /\$ErrorActionPreference\s*=\s*'Stop'/u);
  assert.match(setup.run, /\$env:PSModulePath\s*=\s*Join-Path\s+\$PSHOME\s+'Modules'/u);
  assert.match(setup.run, /Import-Module Microsoft\.PowerShell\.Archive -ErrorAction Stop/u);
  assert.match(setup.run, /PSModulePath=.*\$env:GITHUB_ENV/u);
  assert.ok(index < steps.findIndex((step) => step.name === "安装依赖"));
  assert.ok(index < steps.findIndex((step) => step.name?.startsWith("初始化")));
});

test(
  "污染模块环境可复现解压错误，CI 准备后原解压器恢复",
  { skip: process.platform !== "win32" },
  async () => {
    const setup = workflow.jobs.build.steps.find((step) => step.id === "windows-powershell");
    assert.ok(setup, "missing Windows PowerShell setup");
    const directory = await mkdtemp(join(tmpdir(), "zcode-release-ci-test-"));
    const priorEnvironment = { ...process.env };
    try {
      const archive = join(directory, "fixture 中文 ' archive.zip");
      const source = join(directory, "source", "nested");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "fixture.exe"), "fixture-binary");
      const created = runPowerShell(
        `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${quote(dirname(source))}, ${quote(archive)})`,
      );
      assert.equal(created.status, 0, created.stderr);
      const moduleDirectory = join(directory, "polluted", "Microsoft.PowerShell.Archive");
      await mkdir(moduleDirectory, { recursive: true });
      await writeFile(
        join(moduleDirectory, "Microsoft.PowerShell.Archive.psm1"),
        "function Expand-Archive { Write-Error 'fixture.incompatibleArchiveModule' }; Export-ModuleMember -Function Expand-Archive",
      );
      const polluted = { ...process.env, PSModulePath: dirname(moduleDirectory) };
      for (const key of Object.keys(polluted)) {
        if (key.toLowerCase() === "psmodulepath" && key !== "PSModulePath") delete polluted[key];
      }
      const oldAttempt = runPowerShell(
        `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(join(directory, "old-extract"))} -Force`,
        polluted,
      );
      assert.match(oldAttempt.stderr, /fixture\.incompatibleArchiveModule/u);
      const envFile = join(directory, "github-env");
      const prepared = runPowerShell(setup.run, { ...polluted, GITHUB_ENV: envFile });
      assert.equal(prepared.status, 0, prepared.stderr);
      const modules = (await readFile(envFile, "utf8"))
        .replace(/^\uFEFF/u, "")
        .match(/^PSModulePath=(.+)$/mu)?.[1]
        ?.trim();
      assert.ok(modules);
      for (const key of Object.keys(process.env))
        if (key.toLowerCase() === "psmodulepath") delete process.env[key];
      process.env.PSModulePath = modules;
      const extracted = join(directory, "fixed extract 中文 '");
      await extractPrebuiltArchive({
        archivePath: archive,
        archiveExt: "zip",
        extractDir: extracted,
        cwd: directory,
      });
      assert.equal(
        await readFile(join(extracted, "nested", "fixture.exe"), "utf8"),
        "fixture-binary",
      );
    } finally {
      for (const key of Object.keys(process.env))
        if (key.toLowerCase() === "psmodulepath") delete process.env[key];
      for (const [key, value] of Object.entries(priorEnvironment))
        if (key.toLowerCase() === "psmodulepath") process.env[key] = value;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
