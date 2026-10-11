import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

const WORKSPACE = { workspacePath: "/example/task-purge", workspaceIdentity: "task-purge-ws" };

function buildMeta(taskId: string, overrides: Partial<ZCodeTaskMeta> = {}): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: WORKSPACE.workspacePath,
    workspaceIdentity: WORKSPACE.workspaceIdentity,
    mode: "build",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function withRepo(run: (repo: TaskIndexRepo) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-task-purge-"));
  setDataBaseDir(dir);
  const repo = new TaskIndexRepo(join(dir, "tasks.sqlite"));
  try {
    await run(repo);
  } finally {
    repo.close();
    setDataBaseDir(null);
    await rm(dir, { recursive: true, force: true });
  }
}

test("purgeTask 物理删除已归档任务，且只对已归档行生效", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({
      meta: buildMeta("archived-task", { status: "completed" }),
      archived: true,
    });
    await repo.syncTaskMeta({ meta: buildMeta("active-task", { status: "completed" }) });

    // 归档态只存在于索引行：前置守卫必须能查出来（彻底删除在发命令前要用它）。
    assert.equal(await repo.isArchivedTask({ ...WORKSPACE, taskId: "archived-task" }), true);
    assert.equal(await repo.isArchivedTask({ ...WORKSPACE, taskId: "active-task" }), false);

    // 未归档：拒绝物理删除，行必须还在。
    assert.equal(await repo.purgeTask({ ...WORKSPACE, taskId: "active-task" }), false);
    assert.deepEqual(
      (await repo.listTaskMetas({ ...WORKSPACE, archived: false })).map((task) => task.taskId),
      ["active-task"],
    );

    // 已归档：物理删除，归档集合与普通集合都不再出现。
    assert.equal(await repo.purgeTask({ ...WORKSPACE, taskId: "archived-task" }), true);
    assert.deepEqual(await repo.listTaskMetas({ ...WORKSPACE, archived: true }), []);
    assert.equal(await repo.isArchivedTask({ ...WORKSPACE, taskId: "archived-task" }), false);
    // 重复删除幂等：行已不存在，返回 false 而不是抛错。
    assert.equal(await repo.purgeTask({ ...WORKSPACE, taskId: "archived-task" }), false);
  });
});
