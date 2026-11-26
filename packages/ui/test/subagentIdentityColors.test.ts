import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_SUBAGENT_DEFINITIONS,
  BUILT_IN_SUBAGENT_NAMES,
  createAgentStateId,
  ZCODE_AGENT_PROVIDER,
} from "@zcode/shared";
import {
  resolveSubagentColorFromName,
  resolveSubagentIdentityColor,
  selectSubagentIdentityProfiles,
  type SubagentIdentityProfile,
} from "../src/lib/subagentColors.js";

function profile(overrides: Partial<SubagentIdentityProfile> = {}): SubagentIdentityProfile {
  return {
    id: "user:workspace:custom-helper",
    name: "custom-helper",
    scope: "workspace",
    source: "user",
    ...overrides,
  };
}

const BUILT_IN_PROFILES = BUILT_IN_SUBAGENT_DEFINITIONS.map((definition) =>
  profile({
    id: createAgentStateId({ name: definition.name, scope: "built-in", source: "built-in" }),
    name: definition.name,
    scope: "built-in",
    source: "built-in",
    color: definition.color,
  }),
);

test("全部内置角色在首帧、旧 red 元数据和配置加载后使用目录身份色", () => {
  assert.equal(BUILT_IN_SUBAGENT_DEFINITIONS.length, BUILT_IN_SUBAGENT_NAMES.length);
  for (const definition of BUILT_IN_SUBAGENT_DEFINITIONS) {
    for (const profiles of [undefined, BUILT_IN_PROFILES]) {
      assert.equal(
        resolveSubagentIdentityColor({ name: definition.name, profiles }),
        definition.color,
      );
      assert.equal(
        resolveSubagentIdentityColor({ name: definition.name, color: "red", profiles }),
        definition.color,
        `${definition.name} 不应被旧 red 覆盖`,
      );
    }
  }
});

test("内置角色的稳定 built-in ID 由公开构造器识别，不按任意 ID 末段猜角色", () => {
  for (const definition of BUILT_IN_SUBAGENT_DEFINITIONS) {
    const id = createAgentStateId({ name: definition.name, scope: "built-in", source: "built-in" });
    assert.equal(resolveSubagentIdentityColor({ name: id, color: "red" }), definition.color);
    assert.equal(
      resolveSubagentIdentityColor({ name: id, profiles: BUILT_IN_PROFILES }),
      definition.color,
    );
  }
  for (const name of [
    "plugin:reviewer",
    ":reviewer",
    "user:workspace:reviewer",
    "other:built-in:frontend",
  ]) {
    assert.equal(resolveSubagentIdentityColor({ name, color: "lime" }), "lime", name);
    assert.equal(resolveSubagentIdentityColor({ name }), resolveSubagentColorFromName(name), name);
  }
});

test("内置名兼容 trim、NFKC、大小写、Unicode 空白/连字符和 snake/kebab/space 别名", () => {
  for (const name of [
    "ui-designer",
    "ui_designer",
    "UI-DESIGNER",
    "ui designer",
    "  ui\u00a0designer  ",
    "ui\u2009designer",
    "ui\u2010designer",
    "ui\u2014designer",
    "ＵＩ＿ＤＥＳＩＧＮＥＲ",
  ]) {
    assert.equal(resolveSubagentIdentityColor({ name, color: "red" }), "pink", name);
    assert.equal(resolveSubagentIdentityColor({ name, profiles: BUILT_IN_PROFILES }), "pink", name);
  }
  for (const name of [" explore ", "EXPLORE", "Ｅｘｐｌｏｒｅ"]) {
    assert.equal(resolveSubagentIdentityColor({ name, color: "red" }), "cyan", name);
  }
  assert.equal(resolveSubagentIdentityColor({ name: "GENERAL_PURPOSE" }), "blue");
});

test("已匹配 profile 的显式颜色优先于内置目录和旧工具色", () => {
  const custom = profile({ name: "frontend", color: "fuchsia" });
  assert.equal(
    resolveSubagentIdentityColor({ name: "frontend", color: "red", profiles: [custom] }),
    "fuchsia",
  );
  assert.equal(resolveSubagentIdentityColor({ name: custom.id!, profiles: [custom] }), "fuchsia");
  const builtIn = {
    ...BUILT_IN_PROFILES.find((agent) => agent.name === "frontend")!,
    color: "deepBlue" as const,
  };
  assert.equal(resolveSubagentIdentityColor({ name: "frontend", profiles: [builtIn] }), "deepBlue");
});

test("匹配到缺色内置 profile 用目录，缺色同名自建/插件 profile 用自身名称 hash", () => {
  const builtIn = profile({ name: "frontend", scope: "built-in", source: "built-in" });
  assert.equal(
    resolveSubagentIdentityColor({ name: "frontend", color: "red", profiles: [builtIn] }),
    "teal",
  );
  for (const source of ["user", "plugin"] as const) {
    const custom = profile({ name: "frontend", source });
    assert.equal(
      resolveSubagentIdentityColor({ name: "FRONT_END", color: "red", profiles: [custom] }),
      resolveSubagentColorFromName(custom.name),
    );
  }
});

test("精确 name / id 先于近似匹配；近似结果必须唯一", () => {
  const exact = profile({ id: "user:workspace:qa-helper", name: "qa-helper", color: "teal" });
  const approximate = profile({
    id: "user:workspace:qa helper",
    name: "QA Helper",
    color: "orange",
  });
  assert.equal(
    resolveSubagentIdentityColor({ name: "qa-helper", profiles: [approximate, exact] }),
    "teal",
  );
  assert.equal(
    resolveSubagentIdentityColor({ name: approximate.id!, profiles: [exact, approximate] }),
    "orange",
  );
  assert.equal(
    resolveSubagentIdentityColor({ name: "qa_helper", profiles: [exact], color: "red" }),
    "teal",
  );
  for (const profiles of [
    [exact, approximate],
    [approximate, exact],
  ]) {
    assert.equal(
      resolveSubagentIdentityColor({ name: "qa_helper", color: "cyan", profiles }),
      "cyan",
    );
    assert.equal(
      resolveSubagentIdentityColor({ name: "qa_helper", profiles }),
      resolveSubagentColorFromName("qa_helper"),
    );
  }
  const duplicate = profile({ id: "user:user:qa-helper", name: exact.name, color: "pink" });
  assert.equal(
    resolveSubagentIdentityColor({ name: exact.name, color: "lime", profiles: [exact, duplicate] }),
    "lime",
  );
});

test("插件完整命名空间参与匹配，不截尾套 reviewer；缺色时按定义完整名称兜底", () => {
  const plugin = profile({
    id: "plugin:team@store:reviewer",
    name: "plugin:reviewer",
    source: "plugin",
    color: "deepGreen",
  });
  assert.equal(
    resolveSubagentIdentityColor({ name: "PLUGIN:REVIEWER", color: "red", profiles: [plugin] }),
    "deepGreen",
  );
  assert.equal(resolveSubagentIdentityColor({ name: "reviewer", profiles: [plugin] }), "red");
  assert.equal(
    resolveSubagentIdentityColor({ name: plugin.id!, profiles: [{ ...plugin, color: undefined }] }),
    resolveSubagentColorFromName(plugin.name),
  );
});

test("非内置仅采用合法旧工具色，否则用归一化后的同名 hash", () => {
  assert.equal(
    resolveSubagentIdentityColor({ name: "custom-helper", color: "deepPurple" }),
    "deepPurple",
  );
  for (const color of [undefined, "unknown", "Red", "red "]) {
    assert.equal(
      resolveSubagentIdentityColor({ name: " custom_helper ", color }),
      resolveSubagentColorFromName("CUSTOM HELPER"),
    );
  }
  assert.equal(
    resolveSubagentColorFromName("ＱＡ＿Ｈｅｌｐｅｒ"),
    resolveSubagentColorFromName("qa-helper"),
  );
});

const WORKSPACE = { workspacePath: "/same/path", provider: ZCODE_AGENT_PROVIDER } as const;
const LEGACY_PROFILES = [profile({ name: "frontend", color: "fuchsia" })];
const LEGACY = {
  agents: LEGACY_PROFILES,
  loadedWorkspacePath: WORKSPACE.workspacePath,
  loadedWorkspaceIdentity: null,
  loadedProvider: ZCODE_AGENT_PROVIDER,
} as const;

test("旧单例仅在 loaded path / identity / provider 都匹配时复用", () => {
  assert.equal(selectSubagentIdentityProfiles(WORKSPACE, undefined, LEGACY), LEGACY_PROFILES);
  for (const legacy of [
    { ...LEGACY, loadedWorkspacePath: "/another/path" },
    { ...LEGACY, loadedWorkspaceIdentity: "remote-other" },
    { ...LEGACY, loadedProvider: null },
    { ...LEGACY, loadedWorkspacePath: null },
  ]) {
    assert.deepEqual(selectSubagentIdentityProfiles(WORKSPACE, undefined, legacy), []);
    assert.equal(
      resolveSubagentIdentityColor({
        name: "frontend",
        color: "red",
        profiles: selectSubagentIdentityProfiles(WORKSPACE, undefined, legacy),
      }),
      "teal",
    );
  }
});

test("同路径不同 workspaceIdentity 不复用配置，identity trim 后才匹配", () => {
  const workspace = { ...WORKSPACE, workspaceIdentity: " remote-b " };
  const remoteA = { ...LEGACY, loadedWorkspaceIdentity: "remote-a" };
  const remoteB = { ...LEGACY, loadedWorkspaceIdentity: "remote-b" };
  assert.deepEqual(selectSubagentIdentityProfiles(workspace, undefined, remoteA), []);
  assert.equal(selectSubagentIdentityProfiles(workspace, undefined, remoteB), LEGACY_PROFILES);
  const profiles = [profile({ name: "frontend", color: "deepBlue" })];
  const context = { ...WORKSPACE, workspaceIdentity: "remote-b", loaded: true, agents: profiles };
  assert.equal(selectSubagentIdentityProfiles(workspace, context, remoteA), profiles);
  assert.deepEqual(
    selectSubagentIdentityProfiles({ ...WORKSPACE, workspaceIdentity: "remote-a" }, context),
    [],
  );
});

test("当前已加载的空配置桶仍优先，不从旧单例复活已删除配置", () => {
  const profiles: SubagentIdentityProfile[] = [];
  const context = { ...WORKSPACE, workspaceIdentity: null, loaded: true, agents: profiles };
  assert.equal(selectSubagentIdentityProfiles(WORKSPACE, context, LEGACY), profiles);
  assert.equal(
    selectSubagentIdentityProfiles(WORKSPACE, { ...context, loaded: false }, LEGACY),
    LEGACY_PROFILES,
  );
});
