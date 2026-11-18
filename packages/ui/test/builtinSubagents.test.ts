import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILT_IN_SUBAGENT_DEFINITIONS,
  BUILT_IN_SUBAGENT_NAMES,
} from "@zcode/shared";
import { SUBAGENT_COLORS } from "../src/lib/subagentColors.js";

test("每个内置编排角色都有 UI 调色板内的颜色和标签", () => {
  for (const definition of BUILT_IN_SUBAGENT_DEFINITIONS) {
    assert.ok(
      SUBAGENT_COLORS.includes(definition.color),
      `${definition.name} 的颜色 ${definition.color} 不在 UI 调色板内`,
    );
    assert.ok(definition.tags.length > 0, `${definition.name} 缺少标签`);
    assert.ok(definition.description.trim().length > 0, `${definition.name} 缺少描述`);
  }
});

test("编排默认团队引用的角色都存在", () => {
  const defaultTeam = ["general-purpose", "Explore", "tester"];
  for (const name of defaultTeam) {
    assert.ok(
      BUILT_IN_SUBAGENT_NAMES.includes(name as (typeof BUILT_IN_SUBAGENT_NAMES)[number]),
      `默认团队成员不存在: ${name}`,
    );
  }
});
