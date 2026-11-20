import assert from "node:assert/strict";
import test from "node:test";
import {
  SUBAGENT_STATUS_ORDER,
  countSubagentStatuses,
  hasSubagentStatusSummary,
  sortRunningSubagentsByStatus,
  type RunningSubagentStatus,
} from "../src/v4/subagentStatusModel.js";

interface TestSubagent {
  id: string;
  status: RunningSubagentStatus;
  startedAt?: number;
}

function subagent(id: string, status: RunningSubagentStatus, startedAt?: number): TestSubagent {
  return startedAt === undefined ? { id, status } : { id, status, startedAt };
}

function ids(subagents: readonly TestSubagent[]): string[] {
  return subagents.map((item) => item.id);
}

test("状态优先级固定为 running → waiting → blocked：不按 startedAt 把等待/阻塞抢到前面", () => {
  assert.deepEqual(SUBAGENT_STATUS_ORDER, ["running", "waiting", "blocked"]);

  const ordered = sortRunningSubagentsByStatus([
    subagent("blocked-1", "blocked", 1),
    subagent("waiting-5", "waiting", 5),
    subagent("running-20", "running", 20),
    subagent("running-10", "running", 10),
  ]);

  assert.deepEqual(ids(ordered), ["running-10", "running-20", "waiting-5", "blocked-1"]);
});

test("同状态内按 startedAt 升序", () => {
  const ordered = sortRunningSubagentsByStatus([
    subagent("late", "running", 300),
    subagent("early", "running", 100),
    subagent("middle", "running", 200),
  ]);

  assert.deepEqual(ids(ordered), ["early", "middle", "late"]);
});

test("startedAt 缺失或非有限值排在该状态组末尾，缺失项之间保持原序", () => {
  const ordered = sortRunningSubagentsByStatus([
    subagent("missing-a", "running"),
    subagent("started-200", "running", 200),
    subagent("nan", "running", Number.NaN),
    subagent("started-100", "running", 100),
    subagent("infinite", "running", Number.POSITIVE_INFINITY),
  ]);

  assert.deepEqual(ids(ordered), ["started-100", "started-200", "missing-a", "nan", "infinite"]);

  // 缺失项只在各自状态组内排尾：waiting 组仍然整体排在 running 组之后。
  const mixed = sortRunningSubagentsByStatus([
    subagent("waiting-missing", "waiting"),
    subagent("running-missing", "running"),
  ]);
  assert.deepEqual(ids(mixed), ["running-missing", "waiting-missing"]);
});

test("startedAt 相同的项保持投影原序（稳定），重复排序不跳位", () => {
  const input = [
    subagent("first", "running", 100),
    subagent("second", "running", 100),
    subagent("third", "running", 100),
  ];

  const once = sortRunningSubagentsByStatus(input);
  const twice = sortRunningSubagentsByStatus(once);

  assert.deepEqual(ids(once), ["first", "second", "third"]);
  assert.deepEqual(ids(twice), ["first", "second", "third"]);
  // 排序不修改调用方传入的数组。
  assert.deepEqual(ids(input), ["first", "second", "third"]);
});

test("空列表与单项列表原样返回", () => {
  assert.deepEqual(sortRunningSubagentsByStatus([]), []);

  const only = [subagent("only", "waiting", 42)];
  assert.deepEqual(ids(sortRunningSubagentsByStatus(only)), ["only"]);
});

test("countSubagentStatuses 分别统计三种运行态", () => {
  const counts = countSubagentStatuses([
    subagent("r1", "running"),
    subagent("r2", "running"),
    subagent("w1", "waiting"),
    subagent("b1", "blocked"),
  ]);

  assert.deepEqual(counts, { running: 2, waiting: 1, blocked: 1 });
  assert.deepEqual(countSubagentStatuses([]), { running: 0, waiting: 0, blocked: 0 });
});

test("hasSubagentStatusSummary 只在至少一项非零时为真", () => {
  assert.equal(hasSubagentStatusSummary({ running: 0, waiting: 0, blocked: 0 }), false);
  assert.equal(hasSubagentStatusSummary({ running: 1, waiting: 0, blocked: 0 }), true);
  assert.equal(hasSubagentStatusSummary({ running: 0, waiting: 2, blocked: 0 }), true);
  assert.equal(hasSubagentStatusSummary({ running: 0, waiting: 0, blocked: 3 }), true);
});
