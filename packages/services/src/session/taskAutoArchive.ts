// 自动归档判定的唯一实现：Host（renderer 打开分组视图时的即时路径）与常驻 scheduler
// （启动 + 周期的常驻路径）共用，避免两条路径各写一份判定/去重/日志。
import type { AppSettings, ZCodeTaskMeta } from "@zcode/shared";
import { resolveWorkspaceKey } from "@zcode/shared";
import { createServiceLogger, type ServiceLogger } from "#src/logger/serviceLogger.js";
import type { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

export interface TaskAutoArchiveWorkspaceScope {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 只要求 get()：adapter 拿到的是 Host 注入的 settingService，
 * scheduler 自己创建 settingService，两者都读写同一份 setting.json。
 */
export interface TaskAutoArchiveSettingReader {
  get(): Promise<Pick<AppSettings, "taskAutoArchiveEnabled" | "taskAutoArchiveOlderThanDays">>;
}

export interface TaskAutoArchiveConfig {
  olderThanDays: number;
}

const DEFAULT_OLDER_THAN_DAYS = 7;
const logger = createServiceLogger("task-auto-archive");

function resolveLogger(log: ServiceLogger | undefined): ServiceLogger {
  return log ?? logger;
}

/** 读开关与保留期；未开启、无 settingService 或读取失败都返回 null（跳过本轮）。 */
export async function readTaskAutoArchiveConfig(
  settingService: TaskAutoArchiveSettingReader | undefined,
  log?: ServiceLogger,
): Promise<TaskAutoArchiveConfig | null> {
  if (!settingService) {
    return null;
  }
  try {
    const settings = await settingService.get();
    if (!settings.taskAutoArchiveEnabled) {
      return null;
    }
    return {
      olderThanDays: settings.taskAutoArchiveOlderThanDays ?? DEFAULT_OLDER_THAN_DAYS,
    };
  } catch (error) {
    resolveLogger(log).warn(undefined, "读取 task 自动归档设置失败，跳过本轮自动归档", error);
    return null;
  }
}

/**
 * 按设置归档给定工作区里的超期旧任务。
 * 判定与过滤在 `TaskIndexRepo.archiveStaleTasks`（已完成 / 无未读 / 未置顶 / 超过保留期）。
 * 调用方决定命中任务如何收敛 UI（onArchived）；本函数只负责扫描与去重。
 */
export async function runTaskAutoArchiveSweep(params: {
  taskIndexRepo: Pick<TaskIndexRepo, "archiveStaleTasks">;
  settingService?: TaskAutoArchiveSettingReader;
  scopes: TaskAutoArchiveWorkspaceScope[];
  onArchived?: (task: ZCodeTaskMeta, scope: TaskAutoArchiveWorkspaceScope) => void;
  log?: ServiceLogger;
}): Promise<{ archivedCount: number }> {
  const { scopes } = params;
  if (scopes.length === 0) {
    return { archivedCount: 0 };
  }
  const config = await readTaskAutoArchiveConfig(params.settingService, params.log);
  if (!config) {
    return { archivedCount: 0 };
  }
  const seenWorkspaceKeys = new Set<string>();
  let archivedCount = 0;
  for (const scope of scopes) {
    const key = resolveWorkspaceKey(scope);
    if (seenWorkspaceKeys.has(key)) {
      continue;
    }
    seenWorkspaceKeys.add(key);
    // 处理所有存量任务（含列表隐藏的历史记录）：按工作区 + 过期时间 + 完成状态归档。
    const archivedTasks = await params.taskIndexRepo.archiveStaleTasks({
      workspacePath: scope.workspacePath,
      workspaceIdentity: scope.workspaceIdentity,
      olderThanDays: config.olderThanDays,
    });
    archivedCount += archivedTasks.length;
    if (params.onArchived) {
      for (const task of archivedTasks) {
        params.onArchived(task, scope);
      }
    }
  }
  if (archivedCount > 0) {
    resolveLogger(params.log).info(
      undefined,
      `按设置自动归档旧 task 数量=${archivedCount} olderThanDays=${config.olderThanDays}`,
    );
  }
  return { archivedCount };
}
