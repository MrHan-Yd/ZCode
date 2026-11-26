import assert from "node:assert/strict";
import test from "node:test";
import { formatAgentProfilesForPrompt, normalizeAgentProfiles } from "../src/subagent/profile.js";
import { createBuiltInAgentProfiles } from "../src/subagent/builtin-agents.js";

test("经典模式缺省只暴露 general-purpose 与 Explore", () => {
  assert.deepEqual(
    normalizeAgentProfiles([]).map((profile) => profile.name),
    ["general-purpose", "Explore"],
  );
});

test("编排团队按 visibleNames 暴露专业角色，并默认保留通用子代理", () => {
  assert.deepEqual(
    normalizeAgentProfiles([], {
      visibleNames: ["general-purpose", "Explore", "tester"],
    }).map((profile) => profile.name),
    ["general-purpose", "Explore", "tester"],
  );
  assert.deepEqual(
    normalizeAgentProfiles([], { visibleNames: ["tester"] }).map((profile) => profile.name),
    ["general-purpose", "Explore", "tester"],
  );
  assert.deepEqual(
    normalizeAgentProfiles([], { visibleNames: [] }).map((profile) => profile.name),
    ["general-purpose", "Explore"],
  );
});

test("Agent 工具描述包含通用子代理与选中专业角色，其他专业角色仍隐藏", () => {
  const description = formatAgentProfilesForPrompt([], {
    visibleNames: ["tester"],
  });
  assert.ok(description?.includes("- general-purpose:"));
  assert.ok(description?.includes("- Explore:"));
  assert.ok(description?.includes("- tester:"));
  assert.equal(description?.includes("- reviewer:"), false);
  assert.equal(description?.includes("- architect:"), false);
  assert.equal(description?.includes("- frontend:"), false);
});

test("9 个内置 profile 的工具面与只读约束符合目录", () => {
  const profiles = createBuiltInAgentProfiles();
  assert.equal(profiles.length, 9);

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

  const bugFixer = byName.get("bug-fixer");
  assert.ok(bugFixer, "缺少内置角色: bug-fixer");
  assert.equal(bugFixer.tools?.join(","), "*", "bug-fixer 必须可写");
  assert.equal(bugFixer.maxTurns, 40);
  assert.ok(bugFixer.systemPrompt.includes("Reproduce first"), "bug-fixer 提示词必须要求先复现");
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
