import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";
import { resolveSubagentColorFromName, SUBAGENT_COLORS } from "../src/lib/subagentColors.js";
import {
  countSubagentColorUsage,
  isSelfCreatedSubagent,
  resolveSubagentDisplayColor,
  type SubagentColorUsageAgent,
} from "../src/lib/subagentColorUsage.js";

function agent(overrides: Partial<SubagentColorUsageAgent> = {}): SubagentColorUsageAgent {
  return { name: "reviewer", scope: "user", source: "user", ...overrides };
}

test("只有自建子智能体参与颜色占用统计", () => {
  assert.equal(isSelfCreatedSubagent(agent()), true);
  assert.equal(isSelfCreatedSubagent(agent({ scope: "workspace" })), true);

  // 内置：scope/source 都是 built-in，即使显式带了颜色也不算占用。
  assert.equal(isSelfCreatedSubagent(agent({ scope: "built-in", source: "built-in" })), false);
  // 插件：来自插件安装目录，颜色由插件决定。
  assert.equal(isSelfCreatedSubagent(agent({ source: "plugin" })), false);
  // 只读的自建 agent 同样不可编辑，不参与统计。
  assert.equal(isSelfCreatedSubagent(agent({ readOnly: true })), false);
});

test("显式颜色优先，未设置颜色时按名称 hash 取兜底色", () => {
  assert.equal(resolveSubagentDisplayColor(agent({ color: "teal" })), "teal");
  assert.equal(
    resolveSubagentDisplayColor(agent({ name: "code-reviewer" })),
    resolveSubagentColorFromName("code-reviewer"),
  );
});

test("占用统计忽略内置与插件子智能体", () => {
  const counts = countSubagentColorUsage([
    agent({ name: "reviewer", color: "red" }),
    agent({ name: "tester", color: "red" }),
    agent({ name: "general-purpose", color: "blue", scope: "built-in", source: "built-in" }),
    agent({ name: "Explore", color: "cyan", scope: "built-in", source: "built-in" }),
    agent({ name: "plugin:helper", color: "lime", source: "plugin" }),
  ]);

  assert.equal(counts.get("red"), 2);
  // 内置用过的 blue/cyan 与插件用过的 lime 都不应出现在占用表里。
  assert.equal(counts.has("blue"), false);
  assert.equal(counts.has("cyan"), false);
  assert.equal(counts.has("lime"), false);
  assert.equal(counts.size, 1);
});

test("未设置颜色的自建子智能体按其显示色占用", () => {
  const name = "code-reviewer";
  const counts = countSubagentColorUsage([agent({ name })]);
  assert.equal(counts.get(resolveSubagentColorFromName(name)), 1);
});

test("统计值始终落在调色板内，且空列表返回空表", () => {
  assert.equal(countSubagentColorUsage([]).size, 0);
  const counts = countSubagentColorUsage([
    agent({ name: "a", color: "purple" }),
    agent({ name: "b" }),
    agent({ name: "全新中文名" }),
  ]);
  for (const color of counts.keys()) {
    assert.ok(SUBAGENT_COLORS.includes(color), `占用色越界: ${color}`);
  }
});

test("占用提示文案双语齐备且带颜色名与数量占位符", () => {
  for (const locale of [zhCN, enUS]) {
    const option = locale["settings.subagents.color.usedOption"];
    assert.ok(option?.includes("{color}"), "缺少 {color} 占位符");
    assert.ok(option?.includes("{count}"), "缺少 {count} 占位符");
    assert.ok(locale["settings.subagents.form.color.usedHint"]?.trim(), "缺少色板提示文案");
  }
});
