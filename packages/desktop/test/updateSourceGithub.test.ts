import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { AppUpdater } from "electron-updater";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";
import {
  GitHubReleaseUpdateProvider,
  GITHUB_UPDATE_REPOSITORY,
} from "../src/main/githubReleaseUpdateProvider.js";

type FakeUpdater = {
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  channel: string | null;
};

const originalGetLatestVersion = GitHubProvider.prototype.getLatestVersion;

// 用桩替掉真实请求：本用例只验证通道如何落到 updater、以及 UpdateInfo 上带的通道标记。
GitHubProvider.prototype.getLatestVersion = (async () => ({
  tag: "v9.9.9",
  version: "9.9.9",
})) as typeof originalGetLatestVersion;

test.after(() => {
  GitHubProvider.prototype.getLatestVersion = originalGetLatestVersion;
});

function createProvider(resolveReleaseChannel: (() => Promise<"stable" | "preview">) | undefined): {
  provider: GitHubReleaseUpdateProvider;
  updater: FakeUpdater;
} {
  const updater: FakeUpdater = {
    // electron-updater 默认按当前版本是否带预发布标识初始化；这里给一个会被覆盖的初值。
    allowPrerelease: true,
    allowDowngrade: false,
    channel: null,
  };
  const provider = new GitHubReleaseUpdateProvider(
    {
      provider: "custom",
      owner: GITHUB_UPDATE_REPOSITORY.owner,
      repo: GITHUB_UPDATE_REPOSITORY.repo,
      ...(resolveReleaseChannel ? { resolveReleaseChannel } : {}),
    },
    updater as unknown as AppUpdater,
    {} as unknown as ProviderRuntimeOptions,
  );
  return { provider, updater };
}

test("稳定通道：落到 latest.yml，关闭预发布与降级", async () => {
  const { provider, updater } = createProvider(async () => "stable");

  const info = await provider.getLatestVersion();

  assert.equal(updater.channel, "latest");
  assert.equal(updater.allowPrerelease, false);
  // channel setter 会把 allowDowngrade 置为 true，必须被还原，否则更低版本会被当成可用更新。
  assert.equal(updater.allowDowngrade, false);
  assert.equal(info.zcodeReleaseChannel, "stable");
  assert.equal(info.version, "9.9.9");
});

test("预览通道：落到 preview.yml 并允许预发布版本", async () => {
  const { provider, updater } = createProvider(async () => "preview");

  const info = await provider.getLatestVersion();

  assert.equal(updater.channel, "preview");
  assert.equal(updater.allowPrerelease, true);
  assert.equal(updater.allowDowngrade, false);
  assert.equal(info.zcodeReleaseChannel, "preview");
});

test("未提供通道解析回调时按稳定通道处理", async () => {
  const { provider, updater } = createProvider(undefined);

  const info = await provider.getLatestVersion();

  assert.equal(updater.channel, "latest");
  assert.equal(updater.allowPrerelease, false);
  assert.equal(info.zcodeReleaseChannel, "stable");
});

test("发版配置与运行时更新源使用同一个仓库", () => {
  const configPath = fileURLToPath(new URL("../electron-builder.config.js", import.meta.url));
  const config = readFileSync(configPath, "utf8");

  assert.match(config, /provider:\s*"github"/);
  assert.ok(
    config.includes(`owner: "${GITHUB_UPDATE_REPOSITORY.owner}"`),
    "electron-builder.config.js 的 publish.owner 必须与 GITHUB_UPDATE_REPOSITORY.owner 一致",
  );
  assert.ok(
    config.includes(`repo: "${GITHUB_UPDATE_REPOSITORY.repo}"`),
    "electron-builder.config.js 的 publish.repo 必须与 GITHUB_UPDATE_REPOSITORY.repo 一致",
  );
});
