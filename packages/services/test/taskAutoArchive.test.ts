import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "../src/paths.js";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { runTaskAutoArchiveSweep } from "../src/session/taskAutoArchive.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WORKSPACE = { workspacePath: "/example/auto-archive", workspaceIdentity: "auto-archive-ws" };

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

/** 只实现 get()：与 Host 注入的 settingService 面保持结构兼容。 */
function settingReader(enabled: boolean, days = 7) {
  return {
    async get() {
      return { taskAutoArchiveEnabled: enabled, taskAutoArchiveOlderThanDays: days };
    },
  };
}

async function withRepo(run: (repo: TaskIndexRepo) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-auto-archive-"));
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

test("自动归档只命中已完成、超期、无未读、未置顶的旧任务", async () => {
  await withRepo(async (repo) => {
    const now = Date.now();
    const old = now - 8 * DAY_MS;

    await repo.syncTaskMeta({ meta: buildMeta("eligible", { status: "completed", updatedAt: old }) });
    await repo.syncTaskMeta({ meta: buildMeta("recent", { status: "completed", updatedAt: now - DAY_MS }) });
    await repo.syncTaskMeta({ meta: buildMeta("errored", { status: "error", updatedAt: old }) });
    // 状态为 NULL（旧数据 / 未映射 phase）：SQL 的 task_status='completed' 不成立，不应归档。
    await repo.syncTaskMeta({ meta: buildMeta("status-less", { updatedAt: old }) });
    await repo.syncTaskMeta({
      meta: buildMeta("pinned", { status: "completed", updatedAt: old }),
      pinned: true,
    });
    await repo.syncTaskMeta({ meta: buildMeta("unread", { status: "completed", updatedAt: old }) });
    await repo.updateTaskState({
      ...WORKSPACE,
      taskId: "unread",
      patch: { unreadAt: now },
    });

    const archivedIds: string[] = [];
    const { archivedCount } = await runTaskAutoArchiveSweep({
      taskIndexRepo: repo,
      settingService: settingReader(true, 7),
      scopes: [WORKSPACE],
      onArchived: (task) => archivedIds.push(task.taskId),
    });

    assert.equal(archivedCount, 1);
    assert.deepEqual(archivedIds, ["eligible"]);
    const archived = await repo.listTaskMetas({ ...WORKSPACE, archived: true });
    assert.deepEqual(
      archived.map((task) => task.taskId),
      ["eligible"],
    );
    // 供常驻扫描枚举工作区用：只回工作区身份，不加载任务正文。
    assert.deepEqual(await repo.listWorkspaceScopes(), [
      {
        workspaceKey: "auto-archive-ws",
        workspacePath: WORKSPACE.workspacePath,
        workspaceIdentity: WORKSPACE.workspaceIdentity,
      },
    ]);
  });
});

test("关闭开关时不归档任何任务", async () => {
  await withRepo(async (repo) => {
    await repo.syncTaskMeta({
      meta: buildMeta("eligible", { status: "completed", updatedAt: Date.now() - 30 * DAY_MS }),
    });
    const archivedIds: string[] = [];
    const { archivedCount } = await runTaskAutoArchiveSweep({
      taskIndexRepo: repo,
      settingService: settingReader(false),
      scopes: [WORKSPACE],
      onArchived: (task) => archivedIds.push(task.taskId),
    });
    assert.equal(archivedCount, 0);
    assert.deepEqual(archivedIds, []);
    assert.deepEqual(await repo.listTaskMetas({ ...WORKSPACE, archived: true }), []);
  });
});

test("listArchivedTasks 不再按 provider 过滤，历史 NULL-provider 归档行仍可见", async () => {
  await withRepo(async (repo) => {
    // provider 缺省 = 旧数据；归档写入不带 provider，读取端若按 glm 过滤就会「归档了却看不到」。
    await repo.syncTaskMeta({
      meta: buildMeta("legacy-archived", { status: "completed" }),
      archived: true,
    });
    type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];
    const disposable = () => ({ dispose() {} });
    const service = createZCodeTaskServiceAdapter({
      taskIndexRepo: repo,
      zcodeAgentService: { disposeAll() {} } as unknown as Options["zcodeAgentService"],
      taskIndexSyncer: {
        onSessionTerminalEvent: disposable,
        onSessionReadyEvent: disposable,
        disposeAll() {},
      } as unknown as Options["taskIndexSyncer"],
    });
    try {
      const archived = await service.listArchivedTasks(WORKSPACE);
      assert.deepEqual(
        archived.map((task) => task.taskId),
        ["legacy-archived"],
      );
    } finally {
      service.disposeAll();
    }
  });
});
