import assert from "node:assert/strict";
import test from "node:test";
import { resolveGitPaneFileActions } from "../src/GitPane/fileActions.js";

test("未暂存的已修改文件：可暂存、可撤销，不可取消暂存", () => {
  assert.deepEqual(
    resolveGitPaneFileActions({
      readonly: false,
      kind: "modified",
      isStaged: false,
      isUntracked: false,
      pending: false,
    }),
    { stage: true, unstage: false, discard: true },
  );
});

test("已暂存文件：只能取消暂存，不能再次暂存，也不提供撤销", () => {
  assert.deepEqual(
    resolveGitPaneFileActions({
      readonly: false,
      kind: "modified",
      isStaged: true,
      isUntracked: false,
      pending: false,
    }),
    { stage: false, unstage: true, discard: false },
  );
});

test("未跟踪文件可暂存，但不提供撤销", () => {
  // git restore --worktree 对未跟踪路径会失败；「撤销」未跟踪文件实际是删磁盘文件。
  assert.deepEqual(
    resolveGitPaneFileActions({
      readonly: false,
      kind: "added",
      isStaged: false,
      isUntracked: true,
      pending: false,
    }),
    { stage: true, unstage: false, discard: false },
  );
});

test("新增但非未跟踪的文件同样不提供撤销（不在 HEAD 里，restore 无基准）", () => {
  assert.deepEqual(
    resolveGitPaneFileActions({
      readonly: false,
      kind: "added",
      isStaged: false,
      isUntracked: false,
      pending: false,
    }),
    { stage: true, unstage: false, discard: false },
  );
});

test("已删除的未暂存文件可以撤销（restore 会把它恢复回来）", () => {
  assert.deepEqual(
    resolveGitPaneFileActions({
      readonly: false,
      kind: "deleted",
      isStaged: false,
      isUntracked: false,
      pending: false,
    }),
    { stage: true, unstage: false, discard: true },
  );
});

test("只读来源（与分支比较 / 某轮会话快照）不提供任何写操作", () => {
  assert.deepEqual(
    resolveGitPaneFileActions({
      readonly: true,
      kind: "modified",
      isStaged: false,
      isUntracked: false,
      pending: false,
    }),
    { stage: false, unstage: false, discard: false },
  );
});

test("操作进行中三项全部禁用，避免同文件并发重复提交", () => {
  assert.deepEqual(
    resolveGitPaneFileActions({
      readonly: false,
      kind: "modified",
      isStaged: false,
      isUntracked: false,
      pending: true,
    }),
    { stage: false, unstage: false, discard: false },
  );
});
