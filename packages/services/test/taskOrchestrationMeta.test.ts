import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

const WORKSPACE = {
  workspacePath: "/example/orchestration-meta",
  workspaceIdentity: "orchestration-meta-ws",
};

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
  const dir = await mkdtemp(join(tmpdir(), "zcode-orchestration-meta-"));
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

test("编排配置随 task meta 持久化，并在后续同步不带字段时保留", async () => {
  await withRepo(async (repo) => {
    const orchestration = {
      enabled: true,
      team: ["general-purpose", "Explore", "tester"],
      maxConcurrency: 3,
    };
    await repo.syncTaskMeta({ meta: buildMeta("run", { orchestration }) });
    const [created] = await repo.listTaskMetas(WORKSPACE);
    assert.deepEqual(created?.orchestration, orchestration);

    // 运行态 snapshot 不携带编排字段：合并必须沿用已存值，不能把它冲掉。
    await repo.syncTaskMeta({
      meta: buildMeta("run", { title: "run renamed", updatedAt: 5 }),
    });
    const [preserved] = await repo.listTaskMetas(WORKSPACE);
    assert.deepEqual(preserved?.orchestration, orchestration);
    assert.equal(preserved?.title, "run renamed");

    // 显式写入新配置（包括关闭）仍然覆盖旧值。
    const disabled = { enabled: false, team: ["general-purpose"], maxConcurrency: 2 };
    await repo.syncTaskMeta({ meta: buildMeta("run", { orchestration: disabled }) });
    const [updated] = await repo.listTaskMetas(WORKSPACE);
    assert.deepEqual(updated?.orchestration, disabled);
  });
});

test("经典任务不写编排字段，round-trip 后仍缺席", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({ meta: buildMeta("classic") });
    const [classic] = await repo.listTaskMetas(WORKSPACE);
    assert.equal(classic?.orchestration, undefined);
    assert.equal(Object.prototype.hasOwnProperty.call(classic, "orchestration"), false);
  });
});
