import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSummary } from "@zcode/shared";
import {
  ORCHESTRATION_TEAM_PRESETS,
  applyOrchestrationPreset,
  buildOrchestrationRoleViews,
  describeOrchestrationRoleModel,
  filterOrchestrationRoles,
  matchOrchestrationPreset,
  orchestrationTeamSizeNotice,
  toggleOrchestrationRole,
} from "../src/v4/composer/orchestrationTeamModel.js";

function builtInAgents(overrides: Partial<AgentSummary>[] = []): AgentSummary[] {
  return buildOrchestrationRoleViews([]).map((role, index) => ({
    id: `built-in:${role.name}`,
    name: role.name,
    description: role.description,
    systemPrompt: "",
    path: "",
    scope: "built-in",
    source: "built-in",
    enabled: true,
    readOnly: true,
    ...overrides[index],
  }));
}

test("roles come from the shared catalog with availability and model state", () => {
  const roles = buildOrchestrationRoleViews([]);
  assert.equal(roles.length, 8);
  assert.ok(roles.every((role) => role.available));
  const generalPurpose = roles.find((role) => role.name === "general-purpose");
  assert.equal(generalPurpose?.canWrite, true);
  assert.deepEqual(describeOrchestrationRoleModel(generalPurpose!), { kind: "inherit" });

  const withModel = buildOrchestrationRoleViews(
    builtInAgents([{ modelSelectionOverride: { providerId: "zai", modelId: "glm-5" } }]),
  )[0];
  assert.deepEqual(describeOrchestrationRoleModel(withModel), {
    kind: "model",
    modelId: "glm-5",
  });
});

test("unavailable roles cannot be added and general-purpose cannot be removed", () => {
  const roles = buildOrchestrationRoleViews(builtInAgents([{}, { enabled: false }]));
  const unavailable = toggleOrchestrationRole(["general-purpose"], "Explore", roles);
  assert.equal(unavailable.reason, "unavailable");

  const locked = toggleOrchestrationRole(["general-purpose"], "general-purpose", roles);
  assert.equal(locked.reason, "locked");
  assert.deepEqual(locked.team, ["general-purpose"]);
});

test("team toggles enforce the hard limit and keep at least one writable role", () => {
  const roles = buildOrchestrationRoleViews([]);
  const full = [
    "general-purpose",
    "Explore",
    "architect",
    "frontend",
    "backend",
    "ui-designer",
    "tester",
    "reviewer",
  ];
  const extraRole = {
    name: "extra",
    description: "Extra role",
    tags: [],
    canWrite: false,
    available: true,
  };
  const overLimit = toggleOrchestrationRole(full, "extra", [...roles, extraRole]);
  assert.equal(overLimit.reason, "hard_limit");

  // general-purpose 始终是执行兜底；移除其他可写角色仍允许，但团队不会被归一化成空。
  const readonlyHeavy = ["general-purpose", "tester", "Explore", "architect"];
  const removedTester = toggleOrchestrationRole(readonlyHeavy, "tester", roles);
  assert.ok(!removedTester.team.includes("tester"));
  assert.ok(removedTester.team.includes("general-purpose"));

  const added = toggleOrchestrationRole(["general-purpose"], "frontend", roles);
  assert.deepEqual(added.team, ["general-purpose", "frontend"]);
});

test("search matches name, description, and tags", () => {
  const roles = buildOrchestrationRoleViews([]);
  assert.deepEqual(
    filterOrchestrationRoles(roles, "安全").map((role) => role.name),
    ["reviewer"],
  );
  assert.ok(filterOrchestrationRoles(roles, "react").some((role) => role.name === "frontend"));
  assert.equal(filterOrchestrationRoles(roles, "no-such-role").length, 0);
});

test("presets apply available roles and match by exact team", () => {
  const roles = buildOrchestrationRoleViews([]);
  const recommended = ORCHESTRATION_TEAM_PRESETS[0]!;
  const team = applyOrchestrationPreset(recommended, roles);
  assert.deepEqual(team, ["general-purpose", "Explore", "tester"]);
  assert.equal(matchOrchestrationPreset(team), "recommended");
  assert.equal(matchOrchestrationPreset(["general-purpose"]), null);

  const unavailableExplore = buildOrchestrationRoleViews(builtInAgents([{}, { enabled: false }]));
  const filtered = applyOrchestrationPreset(recommended, unavailableExplore);
  assert.deepEqual(filtered, ["general-purpose", "tester"]);
});

test("size notice reflects soft and hard limits", () => {
  assert.equal(orchestrationTeamSizeNotice(["general-purpose"]), null);
  assert.equal(
    orchestrationTeamSizeNotice([
      "general-purpose",
      "Explore",
      "architect",
      "frontend",
      "backend",
      "ui-designer",
      "tester",
    ]),
    "soft",
  );
  assert.equal(
    orchestrationTeamSizeNotice([
      "general-purpose",
      "Explore",
      "architect",
      "frontend",
      "backend",
      "ui-designer",
      "tester",
      "reviewer",
    ]),
    "hard",
  );
});
