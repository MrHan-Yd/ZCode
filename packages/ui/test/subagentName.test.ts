import assert from "node:assert/strict";
import test from "node:test";
import { resolveSubagentDisplayName, SUBAGENT_UNNAMED_TYPE } from "../src/lib/subagentName.js";

// 名字是标识符，不是文案：面板要显示的就是 runtime 报出的那个词。
// 这里守住的只有「什么算名字」——本地化、改写、加前后缀都会让面板与会话里的 Agent 工具行对不上。
test("有名字时原样返回（不改写、不本地化）", () => {
  for (const name of ["backend-developer", "general-purpose", "Explore", "code-reviewer"]) {
    assert.equal(resolveSubagentDisplayName(name), name);
  }
});

test("首尾空白不是名字的一部分", () => {
  assert.equal(resolveSubagentDisplayName("  backend-developer  "), "backend-developer");
});

test("缺省 / 空串 / 只有空白 / 投影哨兵都不构成名字", () => {
  // 哨兵是 payload 缺 agentType 时投影落的兜底值，写出来等于把「不知道」当名字显示。
  assert.equal(resolveSubagentDisplayName(undefined), undefined);
  assert.equal(resolveSubagentDisplayName(""), undefined);
  assert.equal(resolveSubagentDisplayName("   "), undefined);
  assert.equal(resolveSubagentDisplayName(SUBAGENT_UNNAMED_TYPE), undefined);
  assert.equal(resolveSubagentDisplayName(" subagent "), undefined);
});

test("只有整词哨兵被吞掉：含哨兵字样的真实名字照常显示", () => {
  assert.equal(resolveSubagentDisplayName("subagent-reviewer"), "subagent-reviewer");
});
