import assert from "node:assert/strict";
import test from "node:test";
import {
  ORCHESTRATION_DEFAULT_TEAM,
  normalizeOrchestrationTeamSelection,
} from "./orchestration.js";

const generic = ["general-purpose", "Explore"];

test("通用子代理隐式保留，空专业团队也不丢通用能力", () => {
  assert.deepEqual(normalizeOrchestrationTeamSelection(undefined), generic);
  assert.deepEqual(normalizeOrchestrationTeamSelection([]), generic);
  assert.deepEqual(normalizeOrchestrationTeamSelection(["tester"]), [...generic, "tester"]);
});

test("旧团队补齐通用角色、去空去重，保持专业角色选择", () => {
  assert.deepEqual(
    normalizeOrchestrationTeamSelection(["general-purpose", " tester ", "", "tester"]),
    [...generic, "tester"],
  );
  assert.deepEqual(normalizeOrchestrationTeamSelection(["reviewer", "Explore"]), [
    ...generic,
    "reviewer",
  ]);
});

test("全专业团队最多八个生效角色，归一化幂等", () => {
  const team = normalizeOrchestrationTeamSelection([
    "architect",
    "frontend",
    "backend",
    "ui-designer",
    "tester",
    "reviewer",
    "extra",
  ]);
  assert.deepEqual(team, [
    ...generic,
    "architect",
    "frontend",
    "backend",
    "ui-designer",
    "tester",
    "reviewer",
  ]);
  assert.deepEqual(normalizeOrchestrationTeamSelection(team), team);
});

test("默认精简团队仅增加审阅，不需要手选通用子代理", () => {
  assert.deepEqual(ORCHESTRATION_DEFAULT_TEAM, [...generic, "reviewer"]);
});
