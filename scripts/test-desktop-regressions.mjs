import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const suiteNames = new Set(["about", "performance", "context", "git", "status"]);
const groups = [
  {
    project: "apps/zcode-cli/packages/adapters/tsconfig.upstream-test.json",
    files: [
      {
        path: "apps/zcode-cli/packages/adapters/test/sessionPerformance.test.ts",
        suite: "performance",
      },
    ],
  },
  {
    project: "apps/zcode-cli/packages/bootstrap/tsconfig.subagent-test.json",
    files: [
      {
        path: "apps/zcode-cli/packages/bootstrap/test/sessionPerformance.test.ts",
        suite: "performance",
      },
      {
        path: "apps/zcode-cli/packages/bootstrap/test/sessionPerformanceBatch.test.ts",
        suite: "performance",
      },
      {
        path: "apps/zcode-cli/packages/bootstrap/test/gitCommitMessageGeneration.test.ts",
        suite: "git",
      },
    ],
  },
  {
    project: "packages/ui/tsconfig.json",
    files: [
      { path: "packages/ui/test/aboutDialogHost.test.ts", suite: "about" },
      { path: "packages/ui/test/liveOutputTokens.test.ts", suite: "performance" },
      { path: "packages/ui/test/sessionPerformanceStats.test.ts", suite: "performance" },
      { path: "packages/ui/test/subagentSpeeds.test.ts", suite: "performance" },
      { path: "packages/ui/test/sessionPerformanceStats.browser.test.ts", suite: "performance" },
      { path: "packages/ui/test/contextUsageSubagents.browser.test.ts", suite: "context" },
      { path: "packages/ui/test/composerModelSelectionPort.test.ts", suite: "git" },
      { path: "packages/ui/test/gitCommitMessageModel.browser.test.ts", suite: "git" },
      { path: "packages/ui/test/gitToolsPanelAlignment.browser.test.ts", suite: "git" },
      { path: "packages/ui/test/statusPanelOverlayStore.test.ts", suite: "status" },
      { path: "packages/ui/test/statusPanelSendAutoOpen.test.ts", suite: "status" },
      { path: "packages/ui/test/statusPanelSendAutoOpen.browser.test.ts", suite: "status" },
    ],
  },
  {
    project: "packages/desktop/tsconfig.upstream-test.json",
    files: [
      { path: "packages/desktop/test/aboutDialog.test.ts", suite: "about" },
      { path: "packages/desktop/test/aboutDialogBridge.test.ts", suite: "about" },
      { path: "packages/desktop/test/desktopFrameSampler.test.ts", suite: "about" },
      { path: "packages/desktop/test/aboutDialog.browser.test.ts", suite: "about", native: true },
    ],
  },
];

export function selectDesktopRegressionGroups(args = []) {
  const selectedSuites = new Set();
  let native = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--native") {
      native = true;
    } else if (arg === "--list") {
      continue;
    } else if (arg === "--suite" || arg.startsWith("--suite=")) {
      const suite = arg === "--suite" ? args[++index] : arg.slice("--suite=".length);
      if (!suiteNames.has(suite)) {
        throw new Error(
          `Unknown desktop regression suite: ${suite ?? "(missing)"}. Expected ${[...suiteNames].join(", ")}`,
        );
      }
      selectedSuites.add(suite);
    } else {
      throw new Error(`Unknown desktop regression option: ${arg}`);
    }
  }
  return groups
    .map((group) => ({
      project: group.project,
      files: group.files
        .filter(
          (file) =>
            (native || !file.native) &&
            (selectedSuites.size === 0 || selectedSuites.has(file.suite)),
        )
        .map((file) => file.path),
    }))
    .filter((group) => group.files.length > 0);
}

async function runDesktopRegressions(args) {
  const selectedGroups = selectDesktopRegressionGroups(args);
  if (args.includes("--list")) {
    for (const group of selectedGroups) {
      process.stdout.write(
        `${group.project}\n${group.files.map((file) => `  ${file}`).join("\n")}\n`,
      );
    }
    return;
  }
  if (
    selectedGroups.some((group) =>
      group.files.includes("packages/desktop/test/aboutDialog.browser.test.ts"),
    )
  ) {
    process.stdout.write(
      "[desktop-regressions] Native About test opens real windows and uses foreground screen sampling. Keep the fixture unobscured.\n",
    );
  }
  for (const group of selectedGroups) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        // 多个 Vite/Chrome 冷启动会让首个交互用例超时；所选文件仍串行执行，不放宽场景超时。
        [
          "--import",
          "tsx",
          "--experimental-test-module-mocks",
          "--test",
          "--test-concurrency=1",
          ...group.files,
        ],
        {
          cwd: root,
          stdio: "inherit",
          windowsHide: true,
          env: { ...process.env, TSX_TSCONFIG_PATH: join(root, group.project) },
        },
      );
      child.once("error", reject);
      child.once("exit", (status, signal) =>
        signal
          ? reject(new Error(`Desktop regressions stopped by ${signal}`))
          : resolve(status ?? 1),
      );
    });
    if (code !== 0) {
      process.exitCode = Number(code);
      break;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runDesktopRegressions(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
