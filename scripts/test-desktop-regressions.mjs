import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const groups = [
  {
    project: "apps/zcode-cli/packages/adapters/tsconfig.upstream-test.json",
    files: ["apps/zcode-cli/packages/adapters/test/sessionPerformance.test.ts"],
  },
  {
    project: "apps/zcode-cli/packages/bootstrap/tsconfig.subagent-test.json",
    files: [
      "apps/zcode-cli/packages/bootstrap/test/sessionPerformance.test.ts",
      "apps/zcode-cli/packages/bootstrap/test/sessionPerformanceBatch.test.ts",
      "apps/zcode-cli/packages/bootstrap/test/gitCommitMessageGeneration.test.ts",
    ],
  },
  {
    project: "packages/ui/tsconfig.json",
    files: [
      "packages/ui/test/aboutDialogHost.test.ts",
      "packages/ui/test/liveOutputTokens.test.ts",
      "packages/ui/test/sessionPerformanceStats.test.ts",
      "packages/ui/test/subagentSpeeds.test.ts",
      "packages/ui/test/sessionPerformanceStats.browser.test.ts",
      "packages/ui/test/composerModelSelectionPort.test.ts",
      "packages/ui/test/gitCommitMessageModel.browser.test.ts",
      "packages/ui/test/gitToolsPanelAlignment.browser.test.ts",
      "packages/ui/test/statusPanelOverlayStore.test.ts",
      "packages/ui/test/statusPanelSendAutoOpen.test.ts",
      "packages/ui/test/statusPanelSendAutoOpen.browser.test.ts",
    ],
  },
  {
    project: "packages/desktop/tsconfig.upstream-test.json",
    files: [
      "packages/desktop/test/aboutDialog.test.ts",
      "packages/desktop/test/aboutDialogBridge.test.ts",
      "packages/desktop/test/desktopFrameSampler.test.ts",
      "packages/desktop/test/aboutDialog.browser.test.ts",
    ],
  },
];

for (const group of groups) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      // 多个 Vite/Chrome 冷启动会让首个交互用例超时；串行运行全部文件，不放宽场景超时。
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
      signal ? reject(new Error(`Desktop regressions stopped by ${signal}`)) : resolve(status ?? 1),
    );
  });
  if (code !== 0) {
    process.exitCode = Number(code);
    break;
  }
}
