import assert from "node:assert/strict";
import test from "node:test";
import { nextGitRepositoryHealDelayMs } from "../src/lib/gitRepositoryHeal.js";

test("补偿刷新按 10s/30s/60s 递增并在用尽后停止", () => {
  assert.equal(nextGitRepositoryHealDelayMs(0), 10_000);
  assert.equal(nextGitRepositoryHealDelayMs(1), 30_000);
  assert.equal(nextGitRepositoryHealDelayMs(2), 60_000);
  assert.equal(nextGitRepositoryHealDelayMs(3), null);
});

test("非法尝试序号直接停止，不返回兜底延迟", () => {
  assert.equal(nextGitRepositoryHealDelayMs(-1), null);
  assert.equal(nextGitRepositoryHealDelayMs(1.5), null);
});
