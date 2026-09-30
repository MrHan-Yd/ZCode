import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { compareSemverVersions, getForceUpdateMinimalVersionFromConfig } from "@zcode/shared";
import {
  FORCE_UPDATE_MARKER_ASSET_NAME,
  resolveForceUpdateManualUpdateUrl,
  resolveForceUpdateMarkerUrl,
  resolveForceUpdateRequirementFromMarker,
} from "../src/main/forceUpdateMarker.js";

const CURRENT_VERSION = "3.15.0";

function readRepoFile(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../${relativePath}`, import.meta.url)), "utf8");
}

test("强更标记与手动升级都指向 GitHub Release", () => {
  assert.equal(
    resolveForceUpdateMarkerUrl(),
    "https://github.com/MrHan-Yd/ZCode/releases/latest/download/force-update.json",
  );
  assert.equal(
    resolveForceUpdateManualUpdateUrl(),
    "https://github.com/MrHan-Yd/ZCode/releases/latest",
  );
});

test("标记里的最低版本高于当前版本时判定为需要强更", () => {
  const requirement = resolveForceUpdateRequirementFromMarker(
    { forceUpdate: { minimalVersion: "3.16.0" } },
    CURRENT_VERSION,
  );

  assert.deepEqual(requirement, { currentVersion: CURRENT_VERSION, minimalVersion: "3.16.0" });
});

test("空标记、空最低版本、相等或更低版本都不拉闸", () => {
  const cases: unknown[] = [
    null,
    undefined,
    "not-json-object",
    {},
    { forceUpdate: null },
    { forceUpdate: {} },
    { forceUpdate: { minimalVersion: "" } },
    { forceUpdate: { minimalVersion: "   " } },
    { forceUpdate: { minimalVersion: 316 } },
    { forceUpdate: { minimalVersion: CURRENT_VERSION } },
    { forceUpdate: { minimalVersion: "3.14.3" } },
  ];

  for (const marker of cases) {
    assert.equal(
      resolveForceUpdateRequirementFromMarker(marker, CURRENT_VERSION),
      null,
      `marker=${JSON.stringify(marker) ?? String(marker)} 不应触发强更`,
    );
  }
});

test("仓库根的 force-update.json 是可解析的合法标记", () => {
  const raw = readRepoFile("force-update.json");
  const marker: unknown = JSON.parse(raw);

  // 声明可以是不拉闸（空字符串），但一旦填了版本就必须是能参与 semver 比较的版本号，
  // 否则 resolveForceUpdateRequirement 永远返回 null，门禁会静默失效。
  const minimalVersion = getForceUpdateMinimalVersionFromConfig(marker);
  if (minimalVersion !== undefined) {
    assert.notEqual(compareSemverVersions(minimalVersion, CURRENT_VERSION), null);
  }
});

test("发版流水线把根目录的标记投递成 Release 资产", () => {
  const workflow = readRepoFile(".github/workflows/release-desktop.yml");

  assert.ok(
    workflow.includes(`cp force-update.json release-assets/${FORCE_UPDATE_MARKER_ASSET_NAME}`),
    "release job 需要把仓库根 force-update.json 复制成同名 Release 资产",
  );
  assert.ok(
    workflow.includes(`release-assets/${FORCE_UPDATE_MARKER_ASSET_NAME}`),
    "Release 资产清单需要包含强更标记",
  );
});
