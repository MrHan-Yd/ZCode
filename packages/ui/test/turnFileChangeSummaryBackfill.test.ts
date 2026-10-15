import assert from "node:assert/strict";
import test from "node:test";
import {
  fileChangesFromFetchedSummary,
  shouldBackfillTurnFileChanges,
} from "../src/v4/turnFileChangeSummaryBackfillModel.js";

/**
 * 文件变更摘要「按需回填」的判定护栏。
 *
 * 投影在 `files === 0` 时不挂 fileChanges，所以「没有 fileChanges」既可能是真的没改文件，
 * 也可能是摘要没算出来。唯一的区分依据是 host 下发的缺口清单；判定一旦放宽，每个无变更的轮
 * 都会白发一次 RPC。这里把这条规则钉住。
 */

const gapTurnIds = new Set(["turn-gap"]);

function decide(overrides: Partial<Parameters<typeof shouldBackfillTurnFileChanges>[0]> = {}) {
  return shouldBackfillTurnFileChanges({
    hasHydratedFileChanges: false,
    isRunning: false,
    rowId: 7,
    entityId: "msg-user-1",
    turnId: "turn-gap",
    unavailableTurnIds: gapTurnIds,
    hasFetchFileChanges: true,
    ...overrides,
  });
}

test("缺口清单里的终态轮：回填", () => {
  assert.equal(decide(), true);
});

test("不在缺口清单里的轮：不回填（这是该信号存在的唯一理由）", () => {
  assert.equal(decide({ turnId: "turn-other" }), false);
  assert.equal(decide({ unavailableTurnIds: undefined }), false);
  assert.equal(decide({ unavailableTurnIds: new Set() }), false);
});

test("已经有 hydration 摘要的轮：不回填（否则等于对正常轮重复取数）", () => {
  assert.equal(decide({ hasHydratedFileChanges: true }), false);
});

test("运行中的轮不回填：结果仍在随 revision 增长，终态才有意义", () => {
  assert.equal(decide({ isRunning: true }), false);
});

test("缺少定位（rowId/entityId/turnId）或没有取数能力时不回填", () => {
  assert.equal(decide({ rowId: undefined }), false);
  assert.equal(decide({ entityId: undefined }), false);
  assert.equal(decide({ turnId: undefined }), false);
  assert.equal(decide({ hasFetchFileChanges: false }), false);
});

test("结果映射：有变更补 active，与投影对 hydration 侧的口径一致", () => {
  assert.deepEqual(fileChangesFromFetchedSummary({ files: 3, additions: 12, deletions: 4 }), {
    files: 3,
    additions: 12,
    deletions: 4,
    state: "active",
  });
});

test("结果映射：reverted 原样保留，不被 active 覆盖", () => {
  assert.deepEqual(
    fileChangesFromFetchedSummary({ files: 2, additions: 1, deletions: 1, state: "reverted" }),
    { files: 2, additions: 1, deletions: 1, state: "reverted" },
  );
});

test("结果映射：files === 0 不补 state，免得把没改文件的轮说成可回退", () => {
  assert.deepEqual(fileChangesFromFetchedSummary({ files: 0, additions: 0, deletions: 0 }), {
    files: 0,
    additions: 0,
    deletions: 0,
  });
});
