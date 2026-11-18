import assert from "node:assert/strict";
import test from "node:test";
import {
  formatAgentProfilesForPrompt,
  normalizeAgentProfiles,
} from "../src/subagent/profile.js";
import { createBuiltInAgentProfiles } from "../src/subagent/builtin-agents.js";

test("经典模式缺省只暴露 general-purpose 与 Explore", () => {
  assert.deepEqual(
    normalizeAgentProfiles([]).map((profile) => profile.name),
    ["general-purpose", "Explore"],
  );
});

test("编排团队按 visibleNames 暴露，并始终补回 general-purpose 兜底", () => {
  assert.deepEqual(
    normalizeAgentProfiles([], {
      visibleNames: ["general-purpose", "Explore", "tester"],
    }).map((profile) => profile.name),
    ["general-purpose", "Explore", "tester"],
  );
  // 即使调用方漏了 general-purpose，也必须补回；否则 Agent 省略 subagent_type 时会找不到 profile。
  assert.deepEqual(
    normalizeAgentProfiles([], { visibleNames: ["tester"] }).map((profile) => profile.name),
    ["general-purpose", "tester"],
  );
});

test("Agent 工具描述只包含选中的角色", () => {
  const description = formatAgentProfilesForPrompt([], {
    visibleNames: ["general-purpose", "Explore", "tester"],
  });
  assert.ok(description?.includes("- tester:"));
  assert.equal(description?.includes("- architect:"), false);
  assert.equal(description?.includes("- frontend:"), false);
});

test("8 个内置 profile 的工具面与只读约束符合目录", () => {
  const profiles = createBuiltInAgentProfiles();
  assert.equal(profiles.length, 8);

  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  assert.equal(byName.get("general-purpose")?.tools?.join(","), "*");
  assert.equal(byName.get("Explore")?.systemPrompt, "");

  for (const name of ["architect", "ui-designer", "reviewer"] as const) {
    const profile = byName.get(name);
    assert.ok(profile, `缺少内置角色: ${name}`);
    assert.equal(profile.permissionMode, "plan", `${name} 必须是只读角色`);
    assert.equal(profile.tools?.includes("Write"), false, `${name} 不应有 Write`);
    assert.equal(profile.tools?.includes("Edit"), false, `${name} 不应有 Edit`);
  }

  assert.equal(byName.get("frontend")?.tools?.join(","), "*");
  assert.equal(byName.get("backend")?.tools?.join(","), "*");
  assert.equal(byName.get("tester")?.tools?.join(","), "*");
  assert.equal(byName.get("tester")?.maxTurns, 40);
});

test("内置角色的模型覆盖只影响对应角色", () => {
  const selection = { providerId: "test-provider", modelId: "test-model" };
  const profiles = normalizeAgentProfiles([], {
    visibleNames: ["general-purpose", "tester"],
    builtInModelSelectionOverrides: { tester: selection },
  });
  const byName = new Map(profiles.map((profile) => [profile.name, profile]));
  assert.equal(byName.get("tester")?.modelSelection?.modelId, "test-model");
  assert.equal(byName.get("general-purpose")?.modelSelection, undefined);
});
