import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_SUBAGENT_DEFINITIONS,
  ORCHESTRATION_DEFAULT_TEAM,
  type AgentSummary,
} from "@zcode/shared";
import {
  ORCHESTRATION_TEAM_PRESETS,
  applyOrchestrationPreset,
  buildOrchestrationRoleViews,
  describeOrchestrationRoleModel,
  filterOrchestrationRoles,
  getOrchestrationTeamLimits,
  hasSelectedOrchestrationRole,
  isOrchestrationSelectAllApplied,
  matchOrchestrationPreset,
  orchestrationTeamSizeNotice,
  resolveOrchestrationTeamOnEnable,
  toggleOrchestrationRole,
  toggleOrchestrationSelectAll,
} from "./orchestrationTeamModel.js";

const generic = ["general-purpose", "Explore"];
const specialistNames = ["architect", "frontend", "backend", "ui-designer", "tester", "reviewer"];

function builtInAgents(overrides: Record<string, Partial<AgentSummary>> = {}): AgentSummary[] {
  return BUILT_IN_SUBAGENT_DEFINITIONS.map((role) => ({
    id: `built-in:${role.name}`,
    name: role.name,
    description: role.description,
    systemPrompt: "",
    path: "",
    scope: "built-in",
    source: "built-in",
    enabled: true,
    readOnly: true,
    ...overrides[role.name],
  }));
}

test("团队只展示专业角色，保留可用性、模型与目录元数据", () => {
  const roles = buildOrchestrationRoleViews([]);
  assert.deepEqual(
    roles.map((role) => role.name),
    specialistNames,
  );
  assert.ok(roles.every((role) => role.available));
  const frontend = roles.find((role) => role.name === "frontend")!;
  assert.equal(frontend.canWrite, true);
  assert.deepEqual(describeOrchestrationRoleModel(frontend), { kind: "inherit" });
  const withModel = buildOrchestrationRoleViews(
    builtInAgents({
      frontend: { modelSelectionOverride: { providerId: "zai", modelId: "glm-5" } },
    }),
  ).find((role) => role.name === "frontend")!;
  assert.deepEqual(describeOrchestrationRoleModel(withModel), { kind: "model", modelId: "glm-5" });
});

test("通用角色不可手动切换，不可用专业角色不可添加", () => {
  const roles = buildOrchestrationRoleViews(builtInAgents({ backend: { enabled: false } }));
  for (const name of generic) {
    const result = toggleOrchestrationRole(["tester"], name, roles);
    assert.equal(result.reason, "locked");
    assert.deepEqual(result.team, [...generic, "tester"]);
  }
  assert.equal(toggleOrchestrationRole(generic, "backend", roles).reason, "unavailable");
});

test("专业角色可全部取消，通用执行与检索仍默认可用", () => {
  const roles = buildOrchestrationRoleViews([]);
  assert.deepEqual(toggleOrchestrationRole([...generic, "tester"], "tester", roles).team, generic);
  assert.deepEqual(toggleOrchestrationRole(generic, "frontend", roles).team, [
    ...generic,
    "frontend",
  ]);
});

test("搜索只匹配专业角色的名称、描述和标签", () => {
  const roles = buildOrchestrationRoleViews([]);
  assert.deepEqual(
    filterOrchestrationRoles(roles, "安全").map((role) => role.name),
    ["reviewer"],
  );
  assert.ok(filterOrchestrationRoles(roles, "react").some((role) => role.name === "frontend"));
  assert.equal(filterOrchestrationRoles(roles, "general-purpose").length, 0);
  assert.equal(filterOrchestrationRoles(roles, "no-such-role").length, 0);
});

test("预设仅保留全栈与精简，精简只选审阅且与共享默认一致", () => {
  assert.deepEqual(
    ORCHESTRATION_TEAM_PRESETS.map((preset) => preset.id),
    ["full-stack", "solo"],
  );
  const roles = buildOrchestrationRoleViews([]);
  const fullStack = ORCHESTRATION_TEAM_PRESETS.find((preset) => preset.id === "full-stack")!;
  const solo = ORCHESTRATION_TEAM_PRESETS.find((preset) => preset.id === "solo")!;
  assert.deepEqual(solo.roles, ["reviewer"]);
  const leanTeam = applyOrchestrationPreset(solo, roles);
  assert.deepEqual(leanTeam, [...generic, "reviewer"]);
  assert.deepEqual(leanTeam, ORCHESTRATION_DEFAULT_TEAM);
  const allTeam = applyOrchestrationPreset(fullStack, roles);
  assert.equal(allTeam.length, 8);
  assert.deepEqual(new Set(allTeam), new Set([...generic, ...specialistNames]));
  assert.equal(matchOrchestrationPreset(allTeam), "full-stack");
  assert.equal(matchOrchestrationPreset(["general-purpose", "reviewer"]), "solo");
  assert.equal(matchOrchestrationPreset(["tester", "reviewer"]), null);
  assert.equal(matchOrchestrationPreset(["tester"]), null);
  assert.equal(matchOrchestrationPreset(generic), null);
});

test("精简跳过不可用审阅，但目录未加载时不把选择清空", () => {
  const solo = ORCHESTRATION_TEAM_PRESETS.find((preset) => preset.id === "solo")!;
  const roles = buildOrchestrationRoleViews(builtInAgents({ reviewer: { enabled: false } }));
  assert.deepEqual(applyOrchestrationPreset(solo, roles), generic);
  assert.deepEqual(applyOrchestrationPreset(solo, []), [...generic, "reviewer"]);
});

test("全选包含所有可用专业角色且幂等，不包含不可用角色", () => {
  const fullStack = ORCHESTRATION_TEAM_PRESETS.find((preset) => preset.id === "full-stack")!;
  const roles = buildOrchestrationRoleViews(builtInAgents({ backend: { enabled: false } }));
  const team = applyOrchestrationPreset(fullStack, roles);
  assert.equal(team.includes("backend"), false);
  assert.deepEqual(
    new Set(team),
    new Set([...generic, ...specialistNames.filter((name) => name !== "backend")]),
  );
  assert.deepEqual(applyOrchestrationPreset(fullStack, roles), team);
});

test("全选切换以可用专业角色为准，再次点击清空专业选择", () => {
  const roles = buildOrchestrationRoleViews(builtInAgents({ backend: { enabled: false } }));
  const allAvailable = [...generic, ...specialistNames.filter((name) => name !== "backend")];
  assert.deepEqual(toggleOrchestrationSelectAll(generic, roles), allAvailable);
  assert.equal(isOrchestrationSelectAllApplied(allAvailable, roles), true);
  // 部分选择再点“全选”补齐全部可用角色，而不是清空。
  assert.deepEqual(toggleOrchestrationSelectAll([...generic, "tester"], roles), allAvailable);
  assert.deepEqual(toggleOrchestrationSelectAll(allAvailable, roles), generic);
  assert.equal(isOrchestrationSelectAllApplied(generic, roles), false);
});

test("开启判定只认专业角色，通用子代理不构成有效团队", () => {
  assert.equal(hasSelectedOrchestrationRole(generic), false);
  assert.equal(hasSelectedOrchestrationRole([]), false);
  assert.equal(hasSelectedOrchestrationRole([...generic, "tester"]), true);
});

test("首次开启或清空后重新开启补精简，不因全栈排首项而选全员", () => {
  const roles = buildOrchestrationRoleViews([]);
  for (const team of [[], generic]) {
    const resolved = resolveOrchestrationTeamOnEnable(team, roles);
    assert.deepEqual(resolved, [...generic, "reviewer"]);
    assert.deepEqual(resolved, ORCHESTRATION_DEFAULT_TEAM);
    assert.equal(matchOrchestrationPreset(resolved), "solo");
  }
});

test("原预设和手动团队在重新开启时保持原专业选择", () => {
  const roles = buildOrchestrationRoleViews([]);
  for (const team of [["tester"], ["tester", "reviewer"], ["frontend", "backend"]]) {
    const original = [...team];
    assert.deepEqual(resolveOrchestrationTeamOnEnable(team, roles), [...generic, ...team]);
    assert.deepEqual(team, original);
  }
});

test("默认审阅不可用时保持空专业团队，不自动改选测试或全栈", () => {
  const roles = buildOrchestrationRoleViews(builtInAgents({ reviewer: { enabled: false } }));
  assert.ok(roles.some((role) => role.name === "tester" && role.available));
  const team = resolveOrchestrationTeamOnEnable(generic, roles);
  assert.deepEqual(team, generic);
  assert.equal(hasSelectedOrchestrationRole(team), false);
});

test("面板人数上限只计六个专业角色，运行规模提示按生效团队计算", () => {
  assert.deepEqual(getOrchestrationTeamLimits(), { soft: 4, hard: 6 });
  assert.equal(orchestrationTeamSizeNotice(generic), null);
  assert.equal(orchestrationTeamSizeNotice([...generic, ...specialistNames.slice(0, 5)]), "soft");
  assert.equal(orchestrationTeamSizeNotice([...generic, ...specialistNames]), "hard");
});
