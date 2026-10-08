import { Fragment, useEffect, useMemo, useState } from "react";
import type { ProjectMemoryFileSummary, ProjectMemoryWorkspaceSummary } from "@zcode/services";
import { Trash2Icon } from "lucide-react";
import {
  TID_SETTINGS_MEMORY_COUNT,
  TID_SETTINGS_MEMORY_DELETE,
  TID_SETTINGS_MEMORY_FILE,
  TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS,
  TID_SETTINGS_MEMORY_FILE_ICON,
  TID_SETTINGS_MEMORY_FILE_NAME,
  TID_SETTINGS_MEMORY_FILE_UPDATED_AT,
  TID_SETTINGS_MEMORY_REFRESH,
  TID_SETTINGS_MEMORY_SCOPE_ICON,
  TID_SETTINGS_MEMORY_SCOPE_TRIGGER,
  TID_SETTINGS_MEMORY_SEARCH_CLEAR,
  TID_SETTINGS_MEMORY_SEARCH_INPUT,
  TID_SETTINGS_MEMORY_WORKSPACE,
  testId,
} from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { Button } from "@/components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { MemoryFilePreviewDialog } from "@/settings/MemoryFilePreviewDialog.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import { PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { formatMemoryUpdatedAt } from "@/settings/memoryUpdatedAt.js";
import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";

export type MemoryViewerLoadingState = "idle" | "loading" | "ready" | "error";

export function MemorySettingsViewer({
  catalogError,
  catalogState,
  selectedWorkspace,
  workspaces,
  deletingFileName,
  onDeleteMemoryFile,
  onReadMemoryFile,
  onRefresh,
  onScopeKeyChange,
}: {
  catalogError: string | null;
  catalogState: MemoryViewerLoadingState;
  selectedWorkspace: ProjectMemoryWorkspaceSummary | undefined;
  workspaces: ProjectMemoryWorkspaceSummary[];
  /** 正在删除的文件名；用于禁用该行的按钮，避免重复提交。 */
  deletingFileName: string | null;
  onDeleteMemoryFile: (file: ProjectMemoryFileSummary) => void;
  /** 已绑定当前选中工作区，只读正文。 */
  onReadMemoryFile: (fileName: string) => Promise<{ content: string; updatedAt: number }>;
  onRefresh: () => Promise<void>;
  onScopeKeyChange: (workspaceId: string) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [searchQuery, setSearchQuery] = useState("");
  const [previewFile, setPreviewFile] = useState<ProjectMemoryFileSummary | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  const formatMemoryCount = (count: number) =>
    intl.formatMessage(
      {
        id: `settings.memory.viewer.memoryCount.${count === 1 ? "one" : "other"}`,
      },
      { count },
    );
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleFiles = useMemo(
    () =>
      selectedWorkspace?.files.filter((file) =>
        file.name.toLocaleLowerCase().includes(normalizedSearchQuery),
      ) ?? [],
    [normalizedSearchQuery, selectedWorkspace],
  );

  // 文件从目录里消失（被删除、或被外部清理）就关闭预览，避免继续展示已不存在的记忆正文。
  useEffect(() => {
    if (!previewFile) {
      return;
    }
    if (!(selectedWorkspace?.files ?? []).some((file) => file.name === previewFile.name)) {
      setPreviewFile(null);
    }
  }, [previewFile, selectedWorkspace]);

  if (catalogError) {
    return (
      <Alert>
        <AlertDescription>{catalogError}</AlertDescription>
      </Alert>
    );
  }

  if (catalogState === "loading" && workspaces.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.loading" })}
      </div>
    );
  }

  if (!selectedWorkspace) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.empty" })}
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <PluginScopeMenu
            includeUser={false}
            selectedScopeKey={selectedWorkspace.id}
            workspaceOptions={workspaces.map((workspace) => ({
              key: workspace.id,
              label: workspace.label,
            }))}
            onScopeKeyChange={onScopeKeyChange}
            triggerIconTestId={TID_SETTINGS_MEMORY_SCOPE_ICON}
            triggerTestId={TID_SETTINGS_MEMORY_SCOPE_TRIGGER}
            workspaceOptionTestIdPrefix={TID_SETTINGS_MEMORY_WORKSPACE}
          />
          <div className="h-4 w-px bg-border" aria-hidden="true" />
          <span
            data-testid={TID_SETTINGS_MEMORY_COUNT}
            className="shrink-0 text-ui-sm text-foreground-subtle"
          >
            {formatMemoryCount(selectedWorkspace.files.length)}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <SettingsSearchInput
            containerClassName="w-full sm:w-64"
            clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
            clearTestId={TID_SETTINGS_MEMORY_SEARCH_CLEAR}
            data-testid={TID_SETTINGS_MEMORY_SEARCH_INPUT}
            value={searchQuery}
            onClear={() => setSearchQuery("")}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.memory.viewer.searchPlaceholder",
            })}
          />
        </div>
      </div>

      {normalizedSearchQuery && visibleFiles.length === 0 ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.memory.viewer.searchEmpty",
          })}
        />
      ) : (
        <>
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-3">
            <h3 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.memory.viewer.files" })}
            </h3>
            <SettingsResourceHeaderActions
              onRefresh={() => void onRefresh()}
              refreshing={catalogState === "loading"}
              refreshTestId={TID_SETTINGS_MEMORY_REFRESH}
              refreshLabel={intl.formatMessage({
                id: "settings.memory.viewer.refresh",
              })}
            />
          </div>
          <div className="overflow-hidden rounded-xl bg-surface">
            {visibleFiles.map((file, index) => (
              <Fragment key={file.name}>
                {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                <div className="group/memory-row flex min-w-0 items-center hover:bg-hover">
                  {/* 名称区域可点击打开正文预览；删除与外部编辑器按钮是它的兄弟节点，
                      不能嵌在 button 里（嵌套交互元素无效）。 */}
                  <button
                    type="button"
                    data-testid={testId(TID_SETTINGS_MEMORY_FILE, file.name)}
                    onClick={() => setPreviewFile(file)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-3 text-left"
                  >
                    <span
                      data-testid={testId(TID_SETTINGS_MEMORY_FILE_ICON, file.name)}
                      className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background"
                    >
                      <FileDisplayIcon
                        src={resolveFileDisplayDescriptor(file.path).fileIconSrc}
                        size={16}
                        className="size-4 shrink-0"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        data-testid={testId(TID_SETTINGS_MEMORY_FILE_NAME, file.name)}
                        className="block truncate text-ui-base font-medium text-foreground"
                      >
                        {file.name}
                      </span>
                      <span
                        data-testid={testId(TID_SETTINGS_MEMORY_FILE_UPDATED_AT, file.name)}
                        className="mt-0.5 block truncate text-ui-sm text-foreground-subtle"
                      >
                        {formatMemoryUpdatedAt({
                          formatMessage: intl.formatMessage,
                          locale,
                          now,
                          updatedAt: file.updatedAt,
                        })}
                      </span>
                    </span>
                  </button>
                  {/* 删除是破坏性且低频的操作：默认隐藏，悬停或键盘聚焦到按钮时出现，
                      避免与"预览/外部编辑器"这两个高频动作争夺视觉重量。 */}
                  <span className="shrink-0 opacity-0 transition-opacity group-hover/memory-row:opacity-100 focus-within:opacity-100">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          data-testid={testId(TID_SETTINGS_MEMORY_DELETE, file.name)}
                          disabled={deletingFileName === file.name}
                          aria-label={intl.formatMessage(
                            { id: "settings.memory.delete.ariaLabel" },
                            { fileName: file.name },
                          )}
                          onClick={() => onDeleteMemoryFile(file)}
                          className="text-foreground-subtle hover:text-destructive"
                        >
                          <Trash2Icon className="size-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left" sideOffset={6}>
                        {intl.formatMessage({ id: "settings.memory.delete.label" })}
                      </TooltipContent>
                    </Tooltip>
                  </span>
                  <span
                    data-testid={testId(TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS, file.name)}
                    className="mr-3 shrink-0"
                  >
                    <WorkspaceEditorButtonGroup workspaceAbsPath={file.path} />
                  </span>
                </div>
              </Fragment>
            ))}
          </div>
        </>
      )}

      <MemoryFilePreviewDialog
        file={previewFile}
        readFile={onReadMemoryFile}
        onFileChanged={() => void onRefresh()}
        onOpenChange={(open) => {
          if (!open) {
            setPreviewFile(null);
          }
        }}
      />
    </section>
  );
}
