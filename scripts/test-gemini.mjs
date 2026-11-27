import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/**
 * Gemini 原生格式的正式回归清单。
 *
 * 只用显式文件列表，不扫描目录：临时复现脚本、fixtures 与 *Support 辅助文件
 * 永远不会被当成测试入口。每个分组使用自己的 tsconfig，保证 `@/` 等路径别名
 * 与服务/test 的 NodeNext 解析和仓库其它测试一致。
 *
 * 运行入口：`pnpm test:gemini`（手动或 CI 显式调用）。该命令不在 pre-push 门禁内，
 * 避免本地缺少 Chrome/网络夹具时阻塞推送；pre-push 仍执行 lint/架构/发行回归。
 */
const groups = [
  {
    name: "contracts",
    project: "apps/zcode-cli/packages/contracts/tsconfig.test.json",
    files: ["apps/zcode-cli/packages/contracts/test/modelAssistantContent.test.ts"],
  },
  {
    name: "adapters",
    project: "apps/zcode-cli/packages/adapters/tsconfig.upstream-test.json",
    files: [
      "apps/zcode-cli/packages/adapters/test/legacyProviderReplay.test.ts",
      "apps/zcode-cli/packages/adapters/test/geminiNativeWire.test.ts",
      "apps/zcode-cli/packages/adapters/test/geminiSignedReplay.test.ts",
      "apps/zcode-cli/packages/adapters/test/signatureRepairRetry.test.ts",
    ],
  },
  {
    name: "core",
    project: "apps/zcode-cli/packages/core/tsconfig.upstream-test.json",
    files: [
      "apps/zcode-cli/packages/core/test/geminiAssistantContentWarm.test.ts",
      "apps/zcode-cli/packages/core/test/geminiColdRestore.test.ts",
      "apps/zcode-cli/packages/core/test/geminiMemoryLoop.test.ts",
      "apps/zcode-cli/packages/core/test/geminiMidConversationSystem.test.ts",
      "apps/zcode-cli/packages/core/test/geminiProviderContentIndex.test.ts",
    ],
  },
  {
    name: "bootstrap",
    project: "apps/zcode-cli/packages/bootstrap/tsconfig.subagent-test.json",
    files: ["apps/zcode-cli/packages/bootstrap/test/geminiLegacyCliImport.test.ts"],
  },
  {
    name: "services",
    project: "packages/services/tsconfig.test.json",
    files: [
      "packages/services/test/builtinModelConfigRules.test.ts",
      "packages/services/test/geminiProviderApiFormat.test.ts",
    ],
  },
  {
    name: "shared",
    project: "packages/shared/tsconfig.json",
    files: ["packages/shared/src/gemini-provider-replay-boundary.test.ts"],
  },
  {
    name: "ui",
    project: "packages/ui/tsconfig.json",
    files: [
      "packages/ui/test/modelProviderApiFormat.test.ts",
      "packages/ui/test/modelProviderApiFormat.browser.test.ts",
    ],
  },
];

function listSelectedGroups(args) {
  if (args.includes("--list")) {
    for (const group of groups) {
      process.stdout.write(
        `${group.project}\n${group.files.map((file) => `  ${file}`).join("\n")}\n`,
      );
    }
  }
}

function assertFormalFiles() {
  for (const group of groups) {
    if (!existsSync(join(root, group.project))) {
      throw new Error(`[test-gemini] missing tsconfig: ${group.project}`);
    }
    for (const file of group.files) {
      if (!/\.test\.tsx?$/u.test(file)) {
        throw new Error(`[test-gemini] not a formal test file: ${file}`);
      }
      if (!existsSync(join(root, file))) {
        throw new Error(`[test-gemini] missing test file: ${file}`);
      }
    }
  }
}

function runGroup(group) {
  return new Promise((resolve, reject) => {
    process.stdout.write(
      `\n[test-gemini] ${group.name}: ${group.files.length} file(s) using ${group.project}\n`,
    );
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", ...group.files.map((file) => join(root, file))],
      {
        cwd: root,
        env: { ...process.env, TSX_TSCONFIG_PATH: join(root, group.project) },
        stdio: "inherit",
        windowsHide: true,
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`[test-gemini] ${group.name} stopped by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

listSelectedGroups(process.argv.slice(2));
if (!process.argv.includes("--list")) {
  assertFormalFiles();
  let failed = false;
  for (const group of groups) {
    if ((await runGroup(group)) !== 0) failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}
