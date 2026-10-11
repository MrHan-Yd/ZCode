import { useCallback, useMemo, useState } from "react";
import { Archive, ArchiveX, Cloud, Folder, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import {
  ALL_PROJECTS_SCOPE_KEY,
  useArchivedTasksByProject,
  type ProjectArchiveState,
} from "@/settings/useArchivedTasksByProject.js";
import type { WorkspaceTabState } from "@/store/tabStore.js";

export function ArchiveManagementSection({ workspaceTabs }: { workspaceTabs: WorkspaceTabState[] }) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const {
    projects,
    states,
    loading,
    busyProjectKeys,
    refresh,
    restoreTask,
    removeTask,
    deleteTasks,
    isProjectAvailable,
  } = useArchivedTasksByProject(workspaceTabs);

  const [scopeKey, setScopeKey] = useState(ALL_PROJECTS_SCOPE_KEY);
  const [search, setSearch] = useState("");

  const visibleStates = useMemo(
    () =>
      scopeKey === ALL_PROJECTS_SCOPE_KEY
        ? states
        : states.filter((state) => state.project.key === scopeKey),
    [scopeKey, states],
  );

  const searchQuery = search.trim().toLocaleLowerCase();
  const filteredStates = useMemo(
    () =>
      visibleStates.map((state) => ({
        ...state,
        tasks: searchQuery
          ? state.tasks.filter((task) =>
              (task.title ?? "").toLocaleLowerCase().includes(searchQuery),
            )
          : state.tasks,
      })),
    [visibleStates, searchQuery],
  );

  const projectsWithTasks = filteredStates.filter((state) => state.tasks.length > 0);
  const totalCount = filteredStates.reduce((count, state) => count + state.tasks.length, 0);

  const handleRestore = useCallback(
    (state: ProjectArchiveState, task: (typeof state.tasks)[number]) => {
      void restoreTask(state, task).catch((error) => {
        logger.error("[ArchiveManagementSection] 取消归档失败", error);
      });
    },
    [restoreTask],
  );

  const handleRemove = useCallback(
    async (state: ProjectArchiveState, task: (typeof state.tasks)[number]) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "confirmDialog.archivedTaskDeleteTitle" }),
        description: intl.formatMessage({ id: "confirmDialog.archivedTaskDeleteDescription" }),
        confirmLabel: intl.formatMessage({ id: "settings.archive.remove" }),
      });
      if (!confirmed) return;
      try {
        await removeTask(state, task);
      } catch (error) {
        logger.error("[ArchiveManagementSection] 移除归档任务失败", error);
      }
    },
    [confirmDialog, intl, removeTask],
  );

  const handleBatchDelete = useCallback(
    async (targets: ProjectArchiveState[]) => {
      const deletable = targets.filter((state) => state.tasks.length > 0);
      if (deletable.length === 0) return;
      const count = deletable.reduce((total, state) => total + state.tasks.length, 0);
      const confirmed = await confirmDialog({
        title: intl.formatMessage(
          { id: "settings.archive.deleteTitle" },
          { count: String(count) },
        ),
        description: intl.formatMessage({ id: "settings.archive.deleteDescription" }),
        confirmLabel: intl.formatMessage({ id: "settings.archive.remove" }),
      });
      if (!confirmed) return;
      try {
        await deleteTasks(deletable);
      } catch (error) {
        logger.error("[ArchiveManagementSection] 批量移除归档任务失败", error);
      }
    },
    [confirmDialog, deleteTasks, intl],
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PluginScopeMenu
            includeUser={false}
            leadingOption={{
              key: ALL_PROJECTS_SCOPE_KEY,
              label: intl.formatMessage({ id: "settings.archive.scope.all" }),
              icon: Archive,
            }}
            workspaceOptions={projects.map((project) => ({
              key: project.key,
              label: project.label,
              remote: project.remote,
            }))}
            selectedScopeKey={scopeKey}
            onScopeKeyChange={setScopeKey}
          />
          <h2 className="text-ui-lg font-medium text-foreground">
            {intl.formatMessage({ id: "settings.archiveTitle" })}
          </h2>
          <span className="text-ui-base text-foreground-subtle">{totalCount}</span>
        </div>
        <div className="flex items-center gap-2">
          <SettingsSearchInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onClear={() => setSearch("")}
            placeholder={intl.formatMessage({ id: "settings.archive.searchPlaceholder" })}
            aria-label={intl.formatMessage({ id: "settings.archive.searchPlaceholder" })}
            containerClassName="w-[260px]"
          />
          <ControlHintTooltip title={intl.formatMessage({ id: "common.refresh" })} side="top">
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={loading}
              aria-label={intl.formatMessage({ id: "common.refresh" })}
              onClick={() => void refresh()}
            >
              <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
            </Button>
          </ControlHintTooltip>
          <Button
            type="button"
            variant="outline"
            disabled={loading || projectsWithTasks.length === 0}
            onClick={() => void handleBatchDelete(projectsWithTasks)}
          >
            <Trash2 className="size-4" />
            {intl.formatMessage({ id: "settings.archive.deleteAll" })}
          </Button>
        </div>
      </div>

      {loading && states.length === 0 ? (
        <p className="px-1 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "common.loading" })}
        </p>
      ) : totalCount === 0 ? (
        <p className="px-1 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "taskList.noArchivedTasks" })}
        </p>
      ) : null}

      {projectsWithTasks.map((state) => {
        const ProjectIcon = state.project.remote ? Cloud : Folder;
        return (
          <div key={state.project.key} className="flex flex-col gap-2">
            <SettingsResourceGroupHeader
              title={state.project.label}
              count={state.tasks.length}
              actions={
                <div className="flex items-center gap-2">
                  <ProjectIcon className="size-3.5 text-foreground-subtle" aria-hidden="true" />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busyProjectKeys.has(state.project.key)}
                    onClick={() => void handleBatchDelete([state])}
                  >
                    {intl.formatMessage({ id: "settings.archive.deleteGroup" })}
                  </Button>
                </div>
              }
            />
            <SettingsResourceList
              items={state.tasks}
              getKey={(task) => task.taskId}
              renderItem={(task) => (
                <div className="flex items-center gap-3 px-3 py-2">
                  <span
                    className="min-w-0 flex-1 truncate text-ui-base text-foreground"
                    title={task.title || intl.formatMessage({ id: "taskList.untitled" })}
                  >
                    {task.title || intl.formatMessage({ id: "taskList.untitled" })}
                  </span>
                  <span className="shrink-0 text-ui-base text-foreground-subtle">
                    {formatTaskRelativeTime(task.updatedAt, intl)}
                  </span>
                  <ControlHintTooltip
                    title={intl.formatMessage({ id: "taskList.unarchive" })}
                    side="top"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={intl.formatMessage({ id: "taskList.unarchive" })}
                      onClick={() => handleRestore(state, task)}
                    >
                      <ArchiveX className="size-3.5" />
                    </Button>
                  </ControlHintTooltip>
                  <ControlHintTooltip
                    title={intl.formatMessage({ id: "settings.archive.remove" })}
                    side="top"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-destructive hover:text-destructive"
                      aria-label={intl.formatMessage({ id: "settings.archive.remove" })}
                      onClick={() => void handleRemove(state, task)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </ControlHintTooltip>
                </div>
              )}
            />
          </div>
        );
      })}

      {visibleStates
        .filter((state) => state.unavailable && !isProjectAvailable(state.project.key))
        .map((state) => (
          <p
            key={`unavailable-${state.project.key}`}
            className="px-1 text-ui-base text-foreground-subtle"
          >
            {intl.formatMessage(
              { id: "settings.archive.projectUnavailable" },
              { project: state.project.label },
            )}
          </p>
        ))}
    </div>
  );
}
