import type { CustomPublishOptions } from "builder-util-runtime";
import type { ElectronReleaseChannel } from "@zcode/shared";
import type { AppUpdater } from "electron-updater";
import { GitHubProvider } from "electron-updater/out/providers/GitHubProvider.js";
import type { ProviderRuntimeOptions } from "electron-updater/out/providers/Provider.js";

/**
 * 自建更新源的仓库坐标。electron-updater 的内置 GitHub provider 会自行请求
 * `/releases/latest`、`/releases.atom` 与 `<tag>/latest*.yml`，这里只需要 owner/repo。
 */
export const GITHUB_UPDATE_REPOSITORY = {
  owner: "MrHan-Yd",
  repo: "ZCode",
} as const;

/** 通道 → GitHub provider 的 channel 名，对应 Release 资产里的 `<channel>.yml` 元数据文件。 */
const GITHUB_UPDATE_CHANNEL_NAMES: Record<ElectronReleaseChannel, string> = {
  stable: "latest",
  preview: "preview",
};

// 基类返回的 GithubUpdateInfo 未从 electron-updater 公开导出，用基类签名推导。
type GitHubReleaseUpdateInfo = Awaited<ReturnType<GitHubProvider["getLatestVersion"]>>;

interface GitHubReleaseUpdateProviderOptions extends CustomPublishOptions {
  readonly owner?: string | null;
  readonly repo?: string | null;
  readonly resolveReleaseChannel?: () => ElectronReleaseChannel | Promise<ElectronReleaseChannel>;
}

function applyReleaseChannelToUpdater(updater: AppUpdater, channel: ElectronReleaseChannel): void {
  updater.allowPrerelease = channel === "preview";
  updater.channel = GITHUB_UPDATE_CHANNEL_NAMES[channel];
  // channel setter 会顺带把 allowDowngrade 置为 true：仓库里存在比当前安装版本更低的
  // Release 时，那会被判定成「可用更新」。这里显式还原，保持只接受更高版本的既有语义。
  updater.allowDowngrade = false;
}

export class GitHubReleaseUpdateProvider extends GitHubProvider {
  private readonly targetUpdater: AppUpdater;
  private readonly resolveReleaseChannelCallback:
    | (() => ElectronReleaseChannel | Promise<ElectronReleaseChannel>)
    | undefined;

  constructor(
    options: GitHubReleaseUpdateProviderOptions,
    updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(
      {
        provider: "github",
        owner: options.owner ?? GITHUB_UPDATE_REPOSITORY.owner,
        repo: options.repo ?? GITHUB_UPDATE_REPOSITORY.repo,
      },
      updater,
      runtimeOptions,
    );
    this.targetUpdater = updater;
    this.resolveReleaseChannelCallback = options.resolveReleaseChannel;
  }

  override async getLatestVersion(): Promise<GitHubReleaseUpdateInfo> {
    const channel = (await this.resolveReleaseChannelCallback?.()) ?? "stable";
    // 通道必须在 super.getLatestVersion() 之前落到 updater：GitHub provider 是在该方法内部
    // 读 updater.channel / allowPrerelease 决定取哪个 channel 文件的，晚设置不生效。
    applyReleaseChannelToUpdater(this.targetUpdater, channel);

    const info = await super.getLatestVersion();
    return {
      ...info,
      // preview/stable 切换时旧请求可能晚于新请求返回。electron-updater 的 update-available
      // 事件不带请求通道，main 进程无法识别过期结果，这里把本次请求通道随 UpdateInfo 带回去。
      zcodeReleaseChannel: channel,
    } as GitHubReleaseUpdateInfo;
  }
}
