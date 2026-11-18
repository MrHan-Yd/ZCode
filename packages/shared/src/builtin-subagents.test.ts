import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_SUBAGENT_DEFINITIONS,
  getBuiltInSubagentDefinition,
} from "./builtin-subagents.js";
import { BUILT_IN_SUBAGENT_NAMES, isBuiltInSubagentName } from "./subagents-types.js";
import { importSubagentStateSelections } from "./subagent-state-migration.js";

test("内置角色名单唯一且与目录一一对应", () => {
  assert.equal(new Set(BUILT_IN_SUBAGENT_NAMES).size, BUILT_IN_SUBAGENT_NAMES.length);
  assert.equal(BUILT_IN_SUBAGENT_DEFINITIONS.length, BUILT_IN_SUBAGENT_NAMES.length);
  for (const name of BUILT_IN_SUBAGENT_NAMES) {
    const definition = getBuiltInSubagentDefinition(name);
    assert.ok(definition, `缺少内置角色定义: ${name}`);
    assert.equal(definition.name, name);
    assert.ok(definition.tags.length > 0, `${name} 必须有标签`);
  }
});

test("内置角色名只接受精确值", () => {
  assert.equal(isBuiltInSubagentName("architect"), true);
  assert.equal(isBuiltInSubagentName("Architect"), false);
  assert.equal(isBuiltInSubagentName("frontend "), false);
  assert.equal(isBuiltInSubagentName("unknown-role"), false);
});

test("迁移保留新内置角色的模型覆盖，未知键仍被丢弃", () => {
  const migrated = importSubagentStateSelections({
    builtInModelSelectionOverrides: {
      "general-purpose": { providerId: "p1", modelId: "m1" },
      architect: { providerId: "p2", modelId: "m2" },
      unknown: { providerId: "p3", modelId: "m3" },
    },
  });

  assert.deepEqual(
    Object.keys(migrated.builtInModelSelectionOverrides).sort(),
    ["architect", "general-purpose"],
  );
  assert.equal(migrated.builtInModelSelectionOverrides.architect?.modelId, "m2");
});
