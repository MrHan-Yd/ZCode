import {
  getForceUpdateMinimalVersionFromConfig,
  resolveForceUpdateRequirement,
  type ForceUpdateRequirement,
} from "@zcode/shared";
import { GITHUB_UPDATE_REPOSITORY } from "./githubReleaseUpdateProvider.js";

/** 强更标记以 Release 资产形式发布，名称需与仓库根 force-update.json 及发版流水线保持一致。 */
export const FORCE_UPDATE_MARKER_ASSET_NAME = "force-update.json";

function buildGitHubReleaseUrl(pathname: string): string {
  const { owner, repo } = GITHUB_UPDATE_REPOSITORY;
  return `https://github.com/${owner}/${repo}${pathname}`;
}

/**
 * 强更标记取自「最新正式 Release」的资产。该 Release 没有这个资产、或仓库没有正式 Release 时
 * GitHub 返回 404，调用方按「读不到标记」放行，不把更新源故障升级成启动门禁。
 */
export function resolveForceUpdateMarkerUrl(): string {
  return buildGitHubReleaseUrl(`/releases/latest/download/${FORCE_UPDATE_MARKER_ASSET_NAME}`);
}

/** 手动升级入口：Release 列表页，与界面语言无关。 */
export function resolveForceUpdateManualUpdateUrl(): string {
  return buildGitHubReleaseUrl("/releases/latest");
}

/**
 * 标记文件沿用 client config 的 `forceUpdate` 段落结构：
 * `{ "forceUpdate": { "minimalVersion": "3.16.0" } }`。
 * 复用同一套字段解析与 semver 比较，避免出现第二套版本判定规则。
 */
export function resolveForceUpdateRequirementFromMarker(
  marker: unknown,
  currentVersion: string,
): ForceUpdateRequirement | null {
  return resolveForceUpdateRequirement({
    currentVersion,
    forceUpdate: {
      minimalVersion: getForceUpdateMinimalVersionFromConfig(marker) ?? "",
    },
  });
}
