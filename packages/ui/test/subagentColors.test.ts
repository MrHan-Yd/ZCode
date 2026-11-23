import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import {
  isSubagentColor,
  resolveSubagentColorFromName,
  SUBAGENT_COLOR_CLASS,
  SUBAGENT_COLORS,
  SUBAGENT_DOT_COLOR_CLASS,
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

test("全部 16 个身份点使用与身份文字完全相同的主题色，背景只取 currentColor", () => {
  assert.equal(SUBAGENT_COLORS.length, 16);
  assert.deepEqual(Object.keys(SUBAGENT_DOT_COLOR_CLASS).sort(), [...SUBAGENT_COLORS].sort());
  for (const color of SUBAGENT_COLORS) {
    assert.equal(SUBAGENT_DOT_COLOR_CLASS[color], `${SUBAGENT_TEXT_COLOR_CLASS[color]} bg-current`);
    assert.ok(!SUBAGENT_DOT_COLOR_CLASS[color].includes("/32"));
  }
});

test("表单选择器保留全部浅色弱 surface 与深色实色档，不改用身份点色", () => {
  assert.deepEqual(SUBAGENT_COLOR_CLASS, {
    blue: "bg-sky-300 text-sky-900 dark:bg-sky-400/32 dark:text-sky-50",
    deepBlue: "bg-sky-600 text-sky-50",
    deepGreen: "bg-emerald-600 text-emerald-50",
    deepPurple: "bg-violet-600 text-violet-50",
    deepRed: "bg-rose-600 text-rose-50",
    cyan: "bg-cyan-300 text-cyan-900 dark:bg-cyan-400/32 dark:text-cyan-50",
    fuchsia: "bg-fuchsia-300 text-fuchsia-900 dark:bg-fuchsia-400/32 dark:text-fuchsia-50",
    green: "bg-emerald-300 text-emerald-900 dark:bg-emerald-400/32 dark:text-emerald-50",
    indigo: "bg-indigo-300 text-indigo-900 dark:bg-indigo-400/32 dark:text-indigo-50",
    lime: "bg-lime-300 text-lime-900 dark:bg-lime-400/32 dark:text-lime-50",
    orange: "bg-orange-300 text-orange-900 dark:bg-orange-400/32 dark:text-orange-50",
    pink: "bg-pink-300 text-pink-900 dark:bg-pink-400/32 dark:text-pink-50",
    purple: "bg-violet-300 text-violet-900 dark:bg-violet-400/32 dark:text-violet-50",
    red: "bg-rose-300 text-rose-900 dark:bg-rose-400/32 dark:text-rose-50",
    teal: "bg-teal-300 text-teal-900 dark:bg-teal-400/32 dark:text-teal-50",
    yellow: "bg-amber-300 text-amber-900 dark:bg-amber-300/32 dark:text-amber-50",
  });
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
