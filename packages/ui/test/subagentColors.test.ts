import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  isSubagentColor,
  resolveSubagentColorFromName,
  SUBAGENT_COLOR_CLASS,
  SUBAGENT_COLORS,
  SUBAGENT_TEXT_COLOR_CLASS,
} from "../src/lib/subagentColors.js";

// 调色板分布在四处契约里（shared 联合类型、services 校验、ui 映射、cli 校验）。
// 这里能守住的是 ui 侧：色板、类名映射、i18n 标签三者必须互相对齐。
test("色板不重复，且每个颜色都有圆点类名、文字类名和双语文案", () => {
  assert.equal(new Set(SUBAGENT_COLORS).size, SUBAGENT_COLORS.length);

  for (const color of SUBAGENT_COLORS) {
    assert.ok(SUBAGENT_COLOR_CLASS[color]?.trim(), `缺少圆点类名: ${color}`);
    assert.ok(SUBAGENT_TEXT_COLOR_CLASS[color]?.trim(), `缺少文字类名: ${color}`);
    assert.ok(zhCN[`settings.subagents.color.${color}`], `缺少中文文案: ${color}`);
    assert.ok(enUS[`settings.subagents.color.${color}`], `缺少英文文案: ${color}`);
  }
});

test("颜色映射表不包含色板之外的颜色", () => {
  // 只给 AgentColor 加颜色、忘了加进 SUBAGENT_COLORS 时，
  // 设置页就选不中这个颜色；用映射表的 key 反查能发现这种漂移。
  assert.deepEqual(Object.keys(SUBAGENT_COLOR_CLASS).sort(), [...SUBAGENT_COLORS].sort());
  assert.deepEqual(Object.keys(SUBAGENT_TEXT_COLOR_CLASS).sort(), [...SUBAGENT_COLORS].sort());
});

test("isSubagentColor 只接受合法颜色", () => {
  for (const color of SUBAGENT_COLORS) {
    assert.equal(isSubagentColor(color), true);
  }
  for (const value of ["", "magenta", "Yellow", "teal "]) {
    assert.equal(isSubagentColor(value), false, `不应接受: ${value}`);
  }
});

test("按名称兜底取色始终落在色板内", () => {
  for (const name of ["", "a", "code-reviewer", "全新中文名", "x".repeat(200)]) {
    const color = resolveSubagentColorFromName(name);
    assert.ok(SUBAGENT_COLORS.includes(color), `兜底色越界: ${name} -> ${color}`);
  }
});
