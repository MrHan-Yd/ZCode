import { useCallback, useEffect, useMemo, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { logger } from "@/logger.js";
import { getPathLeaf } from "@/lib/path.js";
import { buildTaskWorkspaceKey } from "@/lib/taskQueryCache.js";
import { removeTaskFromTaskCaches } from "@/lib/taskListMetaSync.js";
import {
  buildWorkspaceServiceLookup,
  type WorkspaceServiceResolverState,
} from "@/lib/workspaceServiceResolver.js";
import { deleteArchivedTaskSelection } from "@/lib/archivedTaskDeletion.js";
import { getPluginWorkspaceKey } from "@/settings/PluginScopeMenu.js";
import { applyTaskQueryCacheMutation } from "@/store/taskQueryCacheStore.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

/** 「全部项目」是页面前置作用域，不指向任何真实工作区。 */
export const ALL_PROJECTS_SCOPE_KEY = "__all_projects__";

export interface ArchiveProject {
  key: string;
  workspacePath: string;
  workspaceIdentity?: string;
  label: string;
  remote: boolean;
}

export interface ProjectArchiveState {
  project: ArchiveProject;
  tasks: ZCodeTaskMeta[];
  unavailable: boolean;
}

/**
 * 项目列表 = 当前打开的工作区标签 ∪ 持久化的最近/历史项目。
 * 远端项目只有在能解析到在线 session 时才可读，否则标记为不可用（与 MCP 作用域一致）。
 */
function buildArchiveProjects(
  workspaceTabs: WorkspaceTabState[],
  recentProjects: readonly string[],
  persisted: readonly { workspacePath: string; workspaceIdentity?: string }[],
): ArchiveProject[] {
  const byKey = new Map<string, ArchiveProject>();
  const add = (project: ArchiveProject) => {
    if (!project.workspacePath?.trim() || byKey.has(project.key)) return;
    byKey.set(project.key, project);
  };
  for (const tab of workspaceTabs) {
    add({
      key: getPluginWorkspaceKey(tab),
      workspacePath: tab.workspacePath,
      workspaceIdentity: tab.workspaceIdentity,
      label: tab.label || getPathLeaf(tab.workspacePath),
      remote: Boolean(tab.remoteTarget || tab.remoteSessionId),
    });
  }
  for (const entry of persisted) {
    add({
      key: buildTaskWorkspaceKey(entry.workspacePath, entry.workspaceIdentity),
      workspacePath: entry.workspacePath,
      workspaceIdentity: entry.workspaceIdentity,
      label: getPathLeaf(entry.workspacePath),
      remote: Boolean(entry.workspaceIdentity?.trim()),
    });
  }
  for (const path of recentProjects) {
    add({
      key: buildTaskWorkspaceKey(path),
      workspacePath: path,
      label: getPathLeaf(path),
      remote: false,
    });
  }
  return [...byKey.values()];
}

export function useArchivedTasksByProject(workspaceTabs: WorkspaceTabState[]) {
  const baseServices = useBaseWorkspaceServices();
  const { settings } = useSettings();
  const sessionsById = useRemoteWorkspaceSessionStore((state) => state.sessionsById);
  const sessionIdByWorkspaceIdentity = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspaceIdentity,
  );
  const sessionIdByWorkspacePath = useRemoteWorkspaceSessionStore(
    (state) => state.sessionIdByWorkspacePath,
  );

  const [states, setStates] = useState<ProjectArchiveState[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyProjectKeys, setBusyProjectKeys] = useState<Set<string>>(() => new Set());

  // 项目列表只在「来源值」变化时重建：useSettings 每次刷新都会给出新的 settings 对象身份，
  // 直接依赖它会让 projects/serviceLookup/refresh 每轮换身份，从而对每个项目重复发一次
  // listArchivedTasks。这里按值签名复用（与 useGlobalTaskList / useGroupedTaskView 同款做法）。
  const projectSourceSignature = JSON.stringify([
    workspaceTabs.map((tab) => [
      tab.workspacePath,
      tab.workspaceIdentity ?? null,
      tab.label ?? null,
      Boolean(tab.remoteTarget || tab.remoteSessionId),
    ]),
    settings?.recentProjects ?? [],
    (settings?.lastWorkspaceSession ?? []).map((entry) => [
      entry.workspacePath,
      "workspaceIdentity" in entry ? (entry.workspaceIdentity ?? null) : null,
    ]),
  ]);

  const projects = useMemo(
    () =>
      buildArchiveProjects(
        workspaceTabs,
        settings?.recentProjects ?? [],
        (settings?.lastWorkspaceSession ?? []).map((entry) => ({
          workspacePath: entry.workspacePath,
          workspaceIdentity: "workspaceIdentity" in entry ? entry.workspaceIdentity : undefined,
        })),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 值签名等价即复用，避免 settings 身份变化触发重复拉取。
    [projectSourceSignature],
  );

  const resolverState = useMemo<WorkspaceServiceResolverState<IServiceAccessor>>(
    () => ({ sessionsById, sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath }),
    [sessionIdByWorkspaceIdentity, sessionIdByWorkspacePath, sessionsById],
  );
  const serviceLookup = useMemo(
    () => buildWorkspaceServiceLookup(projects, baseServices, resolverState),
    [baseServices, projects, resolverState],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    const next = await Promise.all(
      projects.map(async (project): Promise<ProjectArchiveState> => {
        const resolved = serviceLookup.get(project.key);
        if (!resolved) {
          return { project, tasks: [], unavailable: true };
        }
        try {
          // 真正按项目读取归档集合（provider 无关）；只读 tasks-index，不启动 agent。
          const tasks = await resolved.services.zcodeTaskService.listArchivedTasks({
            workspacePath: project.workspacePath,
            ...(project.workspaceIdentity ? { workspaceIdentity: project.workspaceIdentity } : {}),
          });
          return {
            project,
            tasks: [...tasks].sort((left, right) => right.updatedAt - left.updatedAt),
            unavailable: false,
          };
        } catch (error) {
          logger.warn("[useArchivedTasksByProject] 读取项目归档任务失败", {
            workspacePath: project.workspacePath,
            error,
          });
          return { project, tasks: [], unavailable: true };
        }
      }),
    );
    setStates(next);
    setLoading(false);
  }, [projects, serviceLookup]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const removeTaskLocally = useCallback((projectKey: string, taskId: string) => {
    setStates((current) =>
      current.map((state) =>
        state.project.key === projectKey
          ? { ...state, tasks: state.tasks.filter((task) => task.taskId !== taskId) }
          : state,
      ),
    );
  }, []);

  const restoreTask = useCallback(
    async (state: ProjectArchiveState, task: ZCodeTaskMeta) => {
      const resolved = serviceLookup.get(state.project.key);
      if (!resolved) return;
      const meta = await resolved.services.zcodeTaskService.unarchiveTask({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      });
      applyTaskQueryCacheMutation({
        previousTask: task,
        nextTask: meta,
        previousState: { pinned: false, archived: true },
        nextState: { pinned: false, archived: false },
      });
      removeTaskLocally(state.project.key, task.taskId);
    },
    [removeTaskLocally, serviceLookup],
  );

  const removeTask = useCallback(
    async (state: ProjectArchiveState, task: ZCodeTaskMeta) => {
      const resolved = serviceLookup.get(state.project.key);
      if (!resolved) return;
      await resolved.services.zcodeTaskService.deleteTask({
        taskId: task.taskId,
        workspacePath: task.workspacePath,
        ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      });
      removeTaskLocally(state.project.key, task.taskId);
      removeTaskFromTaskCaches({
        workspacePath: task.workspacePath,
        workspaceIdentity: task.workspaceIdentity,
        taskId: task.taskId,
      });
    },
    [removeTaskLocally, serviceLookup],
  );

  /** 批量移除（软删）。确认框由调用方负责；这里只做逐项事务与本地收敛。 */
  const deleteTasks = useCallback(
    async (targets: ProjectArchiveState[]) => {
      const deletable = targets.filter((state) => state.tasks.length > 0);
      if (deletable.length === 0) return;
      setBusyProjectKeys((current) => {
        const next = new Set(current);
        for (const state of deletable) next.add(state.project.key);
        return next;
      });
      try {
        await deleteArchivedTaskSelection(
          {
            groups: deletable.map((state) => ({
              workspace: {
                workspacePath: state.project.workspacePath,
                workspaceIdentity: state.project.workspaceIdentity,
                label: state.project.label,
                service: serviceLookup.get(state.project.key)?.services.zcodeTaskService,
              },
              targets: state.tasks.map((task) => ({
                taskId: task.taskId,
                workspacePath: state.project.workspacePath,
                workspaceIdentity: state.project.workspaceIdentity,
              })),
            })),
            count: deletable.reduce((count, state) => count + state.tasks.length, 0),
            unavailableWorkspaces: [],
          },
          (target) => {
            removeTaskLocally(
              buildTaskWorkspaceKey(target.workspacePath, target.workspaceIdentity),
              target.taskId,
            );
            removeTaskFromTaskCaches(target);
          },
        );
      } finally {
        setBusyProjectKeys((current) => {
          const next = new Set(current);
          for (const state of deletable) next.delete(state.project.key);
          return next;
        });
      }
    },
    [removeTaskLocally, serviceLookup],
  );

  return {
    projects,
    states,
    loading,
    busyProjectKeys,
    refresh,
    restoreTask,
    removeTask,
    deleteTasks,
    isProjectAvailable: (projectKey: string) => serviceLookup.has(projectKey),
  };
}
