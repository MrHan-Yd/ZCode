import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type IMemoryService,
  type ProjectMemoryFileSummary,
  type ProjectMemoryRootsDescription,
  type ProjectMemoryWorkspaceSummary,
} from "@zcode/services";
import { TID_SETTINGS_MEMORY_INACTIVE_ROOTS, TID_SETTINGS_MEMORY_SWITCH } from "@zcode/shared";
import { runUserAction, runUserActionAsync } from "@/lib/userActionTelemetry.js";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  MemorySettingsViewer,
  type MemoryViewerLoadingState,
} from "@/settings/MemorySettingsViewer.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

/** 目录 + 只读正文 + 删除单条记忆；不提供编辑与批量写入。 */
type MemoryCatalogService = Pick<
  IMemoryService,
  | "listProjectMemories"
  | "describeProjectMemoryRoots"
  | "readProjectMemoryFile"
  | "deleteProjectMemoryFile"
>;

function normalizeWorkspaceDisplayName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "project";
}

function buildWorkspaceDisplayNameMap(names: readonly string[]): ReadonlyMap<string, string> {
  const matches = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const candidate of names) {
    const displayName = candidate.trim();
    const slug = normalizeWorkspaceDisplayName(displayName);
    if (!displayName || !slug || ambiguous.has(slug)) continue;
    const existing = matches.get(slug);
    if (existing && existing !== displayName) {
      matches.delete(slug);
      ambiguous.add(slug);
      continue;
    }
    matches.set(slug, displayName);
  }
  return matches;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function MemorySettingsSection({
  memoryEnabled,
  memoryService,
  onMemoryEnabledChange,
  projectMemoryViewerAvailable,
  workspaceDisplayNames = [],
}: {
  memoryEnabled: boolean;
  memoryService: MemoryCatalogService;
  onMemoryEnabledChange: (enabled: boolean) => Promise<void>;
  projectMemoryViewerAvailable: boolean;
  workspaceDisplayNames?: readonly string[];
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const catalogRequestIdRef = useRef(0);
  const [catalogState, setCatalogState] = useState<MemoryViewerLoadingState>("idle");
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<ProjectMemoryWorkspaceSummary[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [rootsDescription, setRootsDescription] = useState<ProjectMemoryRootsDescription | null>(
    null,
  );
  const [deletingFileName, setDeletingFileName] = useState<string | null>(null);

  const refreshCatalog = useCallback(async (): Promise<ProjectMemoryWorkspaceSummary[] | null> => {
    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    setCatalogState("loading");
    setCatalogError(null);
    try {
      const result = await memoryService.listProjectMemories();
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces(result);
      setCatalogState("ready");
      // 根分布探测是辅助信息：失败只意味着没有提示，不能影响主列表。
      void memoryService.describeProjectMemoryRoots().then(
        (description) => {
          if (catalogRequestIdRef.current === requestId) {
            setRootsDescription(description);
          }
        },
        (error: unknown) => {
          logger.warn("[MemorySettingsSection] 读取记忆根分布失败", {
            error: getErrorMessage(error),
          });
          if (catalogRequestIdRef.current === requestId) {
            setRootsDescription(null);
          }
        },
      );
      return result;
    } catch (error) {
      if (catalogRequestIdRef.current !== requestId) {
        return null;
      }
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      setRootsDescription(null);
      setCatalogError(getErrorMessage(error));
      setCatalogState("error");
      return null;
    }
  }, [memoryService]);

  useEffect(() => {
    if (memoryEnabled && projectMemoryViewerAvailable) {
      void refreshCatalog();
      return;
    }

    catalogRequestIdRef.current += 1;
    setCatalogState("idle");
    setCatalogError(null);
    setWorkspaces([]);
    setSelectedWorkspaceId(null);
    setRootsDescription(null);
  }, [memoryEnabled, projectMemoryViewerAvailable, refreshCatalog]);

  const displayWorkspaces = useMemo(() => {
    const displayNameBySlug = buildWorkspaceDisplayNameMap(workspaceDisplayNames);
    const orderBySlug = new Map<string, number>();
    for (const [index, name] of workspaceDisplayNames.entries()) {
      const slug = normalizeWorkspaceDisplayName(name);
      if (!orderBySlug.has(slug)) orderBySlug.set(slug, index);
    }
    return workspaces
      .map((workspace, catalogIndex) => {
        const slug = normalizeWorkspaceDisplayName(workspace.label);
        return {
          catalogIndex,
          order: orderBySlug.get(slug) ?? Number.POSITIVE_INFINITY,
          workspace: {
            ...workspace,
            label: displayNameBySlug.get(slug) ?? workspace.label,
          },
        };
      })
      .sort((left, right) => left.order - right.order || left.catalogIndex - right.catalogIndex)
      .map(({ workspace }) => workspace);
  }, [workspaceDisplayNames, workspaces]);
  const selectedWorkspace = useMemo(
    () => displayWorkspaces.find((workspace) => workspace.id === selectedWorkspaceId),
    [displayWorkspaces, selectedWorkspaceId],
  );

  useEffect(() => {
    const firstWorkspace = displayWorkspaces[0];
    if (!firstWorkspace) {
      setSelectedWorkspaceId(null);
      return;
    }
    if (
      !selectedWorkspaceId ||
      !displayWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)
    ) {
      setSelectedWorkspaceId(firstWorkspace.id);
    }
  }, [displayWorkspaces, selectedWorkspaceId]);

  const handleRefresh = useCallback(async () => {
    await runUserActionAsync({
      input: { featureId: "settings.memory", action: "refresh_memory", trigger: "button" },
      operation: refreshCatalog,
      completed: { resultSource: "platform_result" },
      failureStage: "catalog_refresh",
    });
  }, [refreshCatalog]);

  const handleReadMemoryFile = useCallback(
    async (fileName: string): Promise<{ content: string; updatedAt: number }> => {
      if (!selectedWorkspaceId) {
        // 预览只可能从已选中工作区的文件行发起；显式报错，避免把空 workspaceId 发给服务层
        // 换回一句难以定位的 "Invalid Project Memory path"。
        throw new Error("No project memory workspace selected");
      }
      // workspaceId 在这里绑定：预览弹窗不需要知道当前选中的是哪个工作区。
      return await memoryService.readProjectMemoryFile({
        workspaceId: selectedWorkspaceId,
        fileName,
      });
    },
    [memoryService, selectedWorkspaceId],
  );

  const handleDeleteMemoryFile = useCallback(
    (file: ProjectMemoryFileSummary) => {
      if (!selectedWorkspaceId) {
        return;
      }

      void (async () => {
        // 删除不可恢复（不进回收站、不在 git 下），必须二次确认并把文件名写进文案。
        const confirmed = await confirmDialog({
          title: intl.formatMessage({ id: "settings.memory.delete.confirmTitle" }),
          description: intl.formatMessage(
            { id: "settings.memory.delete.confirmDescription" },
            { fileName: file.name },
          ),
          confirmLabel: intl.formatMessage({ id: "settings.memory.delete.confirmLabel" }),
          cancelLabel: intl.formatMessage({ id: "common.cancel" }),
          confirmVariant: "destructive",
        });
        if (!confirmed) {
          return;
        }

        setDeletingFileName(file.name);
        try {
          await runUserActionAsync({
            input: { featureId: "settings.memory", action: "delete_memory", trigger: "button" },
            operation: () =>
              memoryService.deleteProjectMemoryFile({
                workspaceId: selectedWorkspaceId,
                fileName: file.name,
              }),
            completed: { resultSource: "platform_result" },
            failureStage: "memory_delete",
          });
          await refreshCatalog();
        } catch (error) {
          logger.warn("[MemorySettingsSection] 删除记忆文件失败", {
            fileName: file.name,
            error: getErrorMessage(error),
          });
          toast(
            intl.formatMessage(
              { id: "settings.memory.delete.failed" },
              { message: getErrorMessage(error) },
            ),
          );
        } finally {
          setDeletingFileName(null);
        }
      })();
    },
    [confirmDialog, intl, memoryService, refreshCatalog, selectedWorkspaceId],
  );

  return (
    <div className="space-y-6">
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({
            id: "settings.memory.workspaceMemory",
          })}
          description={intl.formatMessage({
            id: "settings.memoryDescription",
          })}
          control={
            <Switch
              aria-label={intl.formatMessage({
                id: "settings.memory.workspaceMemory",
              })}
              checked={memoryEnabled}
              data-testid={TID_SETTINGS_MEMORY_SWITCH}
              onCheckedChange={(checked) => {
                void onMemoryEnabledChange(checked);
              }}
            />
          }
        />
      </SettingsGroupCard>

      {!projectMemoryViewerAvailable ? (
        <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.memory.viewer.localOnly" })}
        </div>
      ) : !memoryEnabled ? null : (
        <MemorySettingsViewer
          catalogError={catalogError}
          catalogState={catalogState}
          selectedWorkspace={selectedWorkspace}
          workspaces={displayWorkspaces}
          deletingFileName={deletingFileName}
          onDeleteMemoryFile={handleDeleteMemoryFile}
          onReadMemoryFile={handleReadMemoryFile}
          onRefresh={handleRefresh}
          onScopeKeyChange={(workspaceId) =>
            runUserAction({
              input: {
                featureId: "settings.memory",
                action: "change_memory_scope",
                trigger: "select",
              },
              operation: () => setSelectedWorkspaceId(workspaceId),
              completed: { resultSource: "local_commit" },
              failureStage: "local_commit",
            })
          }
        />
      )}

      {memoryEnabled && projectMemoryViewerAvailable && rootsDescription ? (
        <ProjectMemoryInactiveRootsNotice description={rootsDescription} />
      ) : null}
    </div>
  );
}

/**
 * 数据目录从家目录搬走后，旧根的记忆既不进列表也不参与注入。这里把该情况讲清楚：
 * 不静默合并进列表（那会让页面失去"哪些记忆真正生效"的审计意义），只提示并给出复制指引。
 */
function ProjectMemoryInactiveRootsNotice({
  description,
}: {
  description: ProjectMemoryRootsDescription;
}) {
  const { intl } = useZCodeIntl();
  if (description.inactiveRoots.length === 0) {
    return null;
  }

  return (
    <Alert data-testid={TID_SETTINGS_MEMORY_INACTIVE_ROOTS}>
      <AlertDescription className="space-y-2">
        <p>{intl.formatMessage({ id: "settings.memory.inactiveRoots.title" })}</p>
        <ul className="space-y-1">
          {description.inactiveRoots.map((root) => (
            <li key={root.rootId} className="break-all font-mono text-ui-sm">
              {intl.formatMessage(
                { id: "settings.memory.inactiveRoots.entry" },
                {
                  path: root.path,
                  workspaceCount: root.workspaceCount,
                  fileCount: root.fileCount,
                },
              )}
            </li>
          ))}
        </ul>
        <p className="break-all font-mono text-ui-sm">
          {intl.formatMessage(
            { id: "settings.memory.inactiveRoots.guidance" },
            { activeRootPath: description.activeRootPath },
          )}
        </p>
      </AlertDescription>
    </Alert>
  );
}
