/* eslint-disable max-lines -- 列表/编辑视图、未保存拦截与增删改状态共享同一份草稿，拆分会增加页面状态同步成本。 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Loader2, Pin, PinOff, Plus, Trash2, X } from "lucide-react";
import type {
  PromptTemplate,
  PromptTemplateInput,
  PromptTemplateSortMode,
  PromptTemplateSummary,
} from "@zcode/shared";
import { toPromptTemplateSummary } from "@zcode/shared";
import type {
  ConfigSyncBackupList,
  ConfigSyncDownloadPlan,
  ConfigSyncSecretWarning,
  ConfigSyncStatus,
} from "@zcode/services";
import {
  TID_SETTINGS_PROMPT_LIBRARY,
  TID_SETTINGS_PROMPT_LIBRARY_CONFIG_DOWNLOAD,
  TID_SETTINGS_PROMPT_LIBRARY_CONFIG_RESTORE,
  TID_SETTINGS_PROMPT_LIBRARY_CONFIG_UPLOAD,
  TID_SETTINGS_PROMPT_LIBRARY_DELETE,
  TID_SETTINGS_PROMPT_LIBRARY_ERROR,
  TID_SETTINGS_PROMPT_LIBRARY_EMPTY,
  TID_SETTINGS_PROMPT_LIBRARY_LIST,
  TID_SETTINGS_PROMPT_LIBRARY_NEW,
  TID_SETTINGS_PROMPT_LIBRARY_PIN,
  TID_SETTINGS_PROMPT_LIBRARY_ROW,
  TID_SETTINGS_PROMPT_LIBRARY_SEARCH,
  TID_SETTINGS_PROMPT_LIBRARY_SEARCH_CLEAR,
  TID_SETTINGS_PROMPT_LIBRARY_SORT,
  TID_SETTINGS_PROMPT_LIBRARY_SYNC_STATUS,
  testId,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { usePromptLibrary } from "@/hooks/usePromptLibrary.js";
import { filterPromptTemplates } from "@/lib/promptLibrarySearch.js";
import { formatTaskRelativeTime } from "@/lib/taskListItemPresentation.js";
import {
  ConfigSyncDownloadDialog,
  ConfigSyncRestoreDialog,
  ConfigSyncSecretWarningDialog,
} from "@/settings/ConfigSyncDialogs.js";
import { ConfigSyncStatusRow, describeConfigSyncError } from "@/settings/ConfigSyncParts.js";
import { PromptLibraryForm } from "@/settings/PromptLibraryForm.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import {
  SettingsResourceGroupHeader,
  SettingsResourceList,
} from "@/settings/SettingsResourceGroup.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import { sortPromptLibraryItems } from "@/store/promptLibraryStore.js";

const SORT_STORAGE_KEY = "zcode-prompt-library-sort";

export type PromptLibraryLeaveGuard = (proceed: () => void) => void;

interface PromptLibrarySectionProps {
  /** dirty 编辑态下，设置页用它包住切区/返回工作区动作。 */
  onLeaveGuardChange?: (guard: PromptLibraryLeaveGuard | null) => void;
  /** 未登录 GitHub 时跳转到「同步配置」分区。 */
  onOpenSyncConfigSettings?: () => void;
}

interface MutationFailure {
  ok: false;
  reason: string;
  message?: string;
}

function readSortPreference(): PromptTemplateSortMode {
  if (typeof window === "undefined") {
    return "recentUsed";
  }
  try {
    const raw = window.localStorage.getItem(SORT_STORAGE_KEY);
    return raw === "recentUpdated" || raw === "name" || raw === "recentUsed" ? raw : "recentUsed";
  } catch (error) {
    logger.warn("[PromptLibrarySection] 读取排序偏好失败", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "recentUsed";
  }
}

function writeSortPreference(sortMode: PromptTemplateSortMode): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(SORT_STORAGE_KEY, sortMode);
  } catch (error) {
    logger.warn("[PromptLibrarySection] 写入排序偏好失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function PromptRowTags({ tags }: { tags: readonly string[] }) {
  if (tags.length === 0) {
    return null;
  }

  const chipClassName =
    "inline-flex shrink-0 items-center rounded-md bg-surface px-1.5 py-0.5 text-ui-xs text-foreground-subtlest";
  return (
    <div className="flex flex-wrap items-center gap-1">
      {tags.slice(0, 2).map((tag) => (
        <span key={tag} className={chipClassName}>
          #{tag}
        </span>
      ))}
      {tags[2] ? (
        <span className={`${chipClassName} hidden sm:inline-flex`}>#{tags[2]}</span>
      ) : null}
      {tags.length > 3 ? (
        <span className={`${chipClassName} hidden sm:inline-flex`}>+{tags.length - 3}</span>
      ) : null}
      {tags.length > 2 ? (
        <span className={`${chipClassName} sm:hidden`}>+{tags.length - 2}</span>
      ) : null}
    </div>
  );
}

export function PromptLibrarySection({
  onLeaveGuardChange,
  onOpenSyncConfigSettings,
}: PromptLibrarySectionProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const library = usePromptLibrary();
  const service = library.service;
  const items = library.items;
  const load = library.load;
  const readOnly = library.readOnly;

  const [view, setView] = useState<"list" | "editor">("list");
  const [editingInitial, setEditingInitial] = useState<PromptTemplate | null>(null);
  const [editorLoading, setEditorLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortMode, setSortMode] = useState<PromptTemplateSortMode>(readSortPreference);
  const [errorDismissed, setErrorDismissed] = useState(false);
  const [syncStatus, setSyncStatus] = useState<ConfigSyncStatus | null>(null);
  const [syncPhase, setSyncPhase] = useState<"idle" | "uploading" | "previewing" | "applying">(
    "idle",
  );
  const [downloadPlan, setDownloadPlan] = useState<ConfigSyncDownloadPlan | null>(null);
  const [secretWarnings, setSecretWarnings] = useState<readonly ConfigSyncSecretWarning[] | null>(
    null,
  );
  const [restoreBackups, setRestoreBackups] = useState<ConfigSyncBackupList | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const pendingRevealIdRef = useRef<string | null>(null);
  const editorRequestRef = useRef(0);

  // 同步方法是可选契约：旧 Host / 测试替身可能不实现，所有入口先做特性检测。
  const syncService = service;
  const syncSupported = Boolean(
    syncService &&
    typeof syncService.getSyncStatus === "function" &&
    typeof syncService.uploadToGithub === "function" &&
    typeof syncService.previewDownload === "function" &&
    typeof syncService.applyDownload === "function" &&
    typeof syncService.listSyncBackups === "function" &&
    typeof syncService.restoreSyncBackup === "function",
  );
  const syncBusy = syncPhase !== "idle";

  useEffect(() => {
    if (!service) {
      return;
    }
    void load();
  }, [load, service]);

  useEffect(() => {
    if (library.error) {
      setErrorDismissed(false);
    }
  }, [library.error]);

  const describeFailure = useCallback(
    (result: MutationFailure): string => {
      if (result.reason === "alias-conflict") {
        return intl.formatMessage({
          id: "settings.promptLibrary.form.alias.validation.duplicate",
        });
      }
      if (result.reason === "invalid-alias") {
        return intl.formatMessage({
          id: "settings.promptLibrary.form.alias.validation.characters",
        });
      }
      return result.message ?? result.reason;
    },
    [intl],
  );

  const confirmDiscard = useCallback(
    () =>
      confirmDialog({
        title: intl.formatMessage({ id: "settings.promptLibrary.form.unsaved.title" }),
        confirmLabel: intl.formatMessage({
          id: "settings.promptLibrary.form.unsaved.discard",
        }),
        cancelLabel: intl.formatMessage({
          id: "settings.promptLibrary.form.unsaved.keepEditing",
        }),
        confirmVariant: "destructive",
        defaultFocus: "cancel",
      }),
    [confirmDialog, intl],
  );

  const closeEditor = useCallback(() => {
    editorRequestRef.current += 1;
    setView("list");
    setEditingInitial(null);
    setEditorLoading(false);
    setDirty(false);
  }, []);

  const requestCloseEditor = useCallback(async () => {
    if (dirty && !(await confirmDiscard())) {
      return;
    }
    closeEditor();
  }, [closeEditor, confirmDiscard, dirty]);

  useEffect(() => {
    if (!onLeaveGuardChange) {
      return;
    }
    if (view !== "editor" || !dirty) {
      onLeaveGuardChange(null);
      return;
    }
    onLeaveGuardChange((proceed) => {
      void confirmDiscard().then((discard) => {
        if (discard) {
          proceed();
        }
      });
    });
    return () => {
      onLeaveGuardChange(null);
    };
  }, [confirmDiscard, dirty, onLeaveGuardChange, view]);

  // Web 额外注册 beforeunload；桌面窗口关闭由外层进程处理。
  useEffect(() => {
    if (view !== "editor" || !dirty) {
      return;
    }
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [dirty, view]);

  const handleSortChange = useCallback((next: string) => {
    const sortModeValue = next as PromptTemplateSortMode;
    setSortMode(sortModeValue);
    writeSortPreference(sortModeValue);
  }, []);

  const openCreateEditor = useCallback(() => {
    if (readOnly) {
      return;
    }
    editorRequestRef.current += 1;
    setEditingInitial(null);
    setEditorLoading(false);
    setDirty(false);
    setView("editor");
  }, [readOnly]);

  const openEditEditor = useCallback(
    async (item: PromptTemplateSummary) => {
      if (readOnly || !service) {
        return;
      }
      const requestId = editorRequestRef.current + 1;
      editorRequestRef.current = requestId;
      setEditingInitial(null);
      setEditorLoading(true);
      setDirty(false);
      setView("editor");

      try {
        const result = await service.get({ id: item.id });
        if (editorRequestRef.current !== requestId) {
          return;
        }
        if (!result.ok) {
          toast(
            intl.formatMessage({
              id:
                result.reason === "not-found"
                  ? "composer.promptLibrary.deletedWhileOpen"
                  : "settings.promptLibrary.loadFailed",
            }),
          );
          closeEditor();
          void load({ force: true });
          return;
        }
        setEditingInitial(result.item);
        setEditorLoading(false);
      } catch (error) {
        if (editorRequestRef.current !== requestId) {
          return;
        }
        logger.warn("[PromptLibrarySection] 读取提示词失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.promptLibrary.loadFailed" }));
        closeEditor();
      }
    },
    [closeEditor, intl, load, readOnly, service],
  );

  const handleSave = useCallback(
    async (input: PromptTemplateInput) => {
      if (!service) {
        return;
      }
      setSaving(true);
      try {
        const result = editingInitial
          ? await library.updatePrompt({
              ...input,
              id: editingInitial.id,
              expectedUpdatedAt: editingInitial.updatedAt,
            })
          : await library.createPrompt(input);

        if (!result.ok) {
          toast(describeFailure(result));
          return;
        }

        toast(
          intl.formatMessage({
            id: editingInitial
              ? "settings.promptLibrary.toast.saved"
              : "settings.promptLibrary.toast.created",
          }),
        );

        // 保存成功后保留搜索与排序；若当前搜索不再匹配新记录，清空搜索并滚动到该行。
        const summary = toPromptTemplateSummary(result.item);
        const matchesCurrentSearch =
          !searchQuery.trim() || filterPromptTemplates([summary], searchQuery).length > 0;
        if (!matchesCurrentSearch) {
          setSearchQuery("");
        }
        pendingRevealIdRef.current = result.item.id;
        closeEditor();
      } catch (error) {
        logger.warn("[PromptLibrarySection] 保存提示词失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.promptLibrary.loadFailed" }));
      } finally {
        setSaving(false);
      }
    },
    [closeEditor, describeFailure, editingInitial, intl, library, searchQuery, service],
  );

  const reportOperationFailure = useCallback(
    (error: unknown) => {
      logger.warn("[PromptLibrarySection] 提示词库操作失败", {
        error: error instanceof Error ? error.message : String(error),
      });
      toast(intl.formatMessage({ id: "settings.promptLibrary.loadFailed" }));
    },
    [intl],
  );

  const handleDelete = useCallback(async () => {
    if (!editingInitial) {
      return;
    }
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "settings.promptLibrary.form.delete.title" }),
      description: intl.formatMessage(
        { id: "settings.promptLibrary.form.delete.description" },
        { name: editingInitial.title },
      ),
      confirmLabel: intl.formatMessage({ id: "common.delete" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      confirmVariant: "destructive",
      defaultFocus: "cancel",
    });
    if (!confirmed) {
      return;
    }

    try {
      const result = await library.removePrompt(editingInitial.id);
      if (!result.ok) {
        toast(describeFailure(result));
        return;
      }
      toast(intl.formatMessage({ id: "settings.promptLibrary.toast.deleted" }));
      closeEditor();
    } catch (error) {
      reportOperationFailure(error);
    }
  }, [
    closeEditor,
    confirmDialog,
    describeFailure,
    editingInitial,
    intl,
    library,
    reportOperationFailure,
  ]);

  const handleTogglePin = useCallback(
    async (item: PromptTemplateSummary) => {
      if (readOnly) {
        return;
      }
      try {
        const result = await library.setPinned(item.id, !item.pinned);
        if (!result.ok) {
          toast(describeFailure(result));
        }
      } catch (error) {
        reportOperationFailure(error);
      }
    },
    [describeFailure, library, readOnly, reportOperationFailure],
  );

  const handleResetLibrary = useCallback(async () => {
    if (!service) {
      return;
    }
    const confirmed = await confirmDialog({
      title: intl.formatMessage({ id: "settings.promptLibrary.warning.rebuild" }),
      description: intl.formatMessage({
        id: "settings.promptLibrary.warning.rebuildConfirm",
      }),
      confirmLabel: intl.formatMessage({ id: "common.confirm" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      confirmVariant: "destructive",
      defaultFocus: "cancel",
    });
    if (!confirmed) {
      return;
    }
    try {
      const result = await service.reset();
      if (!result.ok) {
        toast(describeFailure(result));
        return;
      }
      await load({ force: true });
    } catch (error) {
      reportOperationFailure(error);
    }
  }, [confirmDialog, describeFailure, intl, load, reportOperationFailure, service]);

  const loadSyncStatus = useCallback(async () => {
    if (!syncService || typeof syncService.getSyncStatus !== "function") {
      return;
    }
    try {
      setSyncStatus(await syncService.getSyncStatus());
    } catch (error) {
      logger.warn("[PromptLibrarySection] 读取提示词库同步状态失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [syncService]);

  useEffect(() => {
    if (!syncSupported) {
      return;
    }
    void loadSyncStatus();
  }, [loadSyncStatus, syncSupported]);

  const describeThrownSyncError = useCallback(
    (error: unknown) =>
      intl.formatMessage(
        { id: "settings.configSync.failed" },
        { detail: error instanceof Error ? error.message : String(error) },
      ),
    [intl],
  );

  const handleSyncUpload = useCallback(
    async (params?: { confirmSecretUpload?: boolean }) => {
      if (!syncService || typeof syncService.uploadToGithub !== "function") {
        return;
      }
      setSyncPhase("uploading");
      try {
        const result = await syncService.uploadToGithub(params);
        if (result.status === "error") {
          if (result.error.code === "secret_warning") {
            setSecretWarnings(result.error.secretWarnings ?? []);
            return;
          }
          if (result.error.code !== "busy") {
            toast(describeConfigSyncError(intl, result.error));
          }
          return;
        }
        setSecretWarnings(null);
        toast(
          result.status === "unchanged"
            ? intl.formatMessage({ id: "settings.configSync.unchanged" })
            : intl.formatMessage(
                { id: "settings.promptLibrary.sync.uploaded" },
                // 服务的 itemCount 是同步条目数（整库恒为 1），这里展示用户可见的提示词条数。
                { count: items.length },
              ),
        );
        await loadSyncStatus();
      } catch (error) {
        toast(describeThrownSyncError(error));
      } finally {
        setSyncPhase("idle");
      }
    },
    [describeThrownSyncError, intl, items.length, loadSyncStatus, syncService],
  );

  const handleSyncPreview = useCallback(async () => {
    if (!syncService || typeof syncService.previewDownload !== "function") {
      return;
    }
    setSyncPhase("previewing");
    try {
      const result = await syncService.previewDownload();
      if (result.status === "error") {
        if (result.error.code !== "busy") {
          toast(describeConfigSyncError(intl, result.error));
        }
        return;
      }
      setDownloadPlan(result);
    } catch (error) {
      toast(describeThrownSyncError(error));
    } finally {
      setSyncPhase("idle");
    }
  }, [describeThrownSyncError, intl, syncService]);

  const handleSyncApply = useCallback(
    async (params: { strategy: "merge" | "replace" }) => {
      if (!downloadPlan || !syncService || typeof syncService.applyDownload !== "function") {
        return;
      }
      setSyncPhase("applying");
      try {
        const result = await syncService.applyDownload({
          strategy: params.strategy,
          expectedRemoteRevision: downloadPlan.remoteRevision,
          confirmReplace: params.strategy === "replace",
        });
        if (result.status === "error") {
          if (result.error.code !== "busy") {
            toast(describeConfigSyncError(intl, result.error));
          }
          return;
        }
        setDownloadPlan(null);
        toast(
          result.status === "up_to_date"
            ? intl.formatMessage({ id: "settings.configSync.upToDate" })
            : intl.formatMessage({ id: "settings.promptLibrary.sync.downloaded" }),
        );
        await Promise.all([load({ force: true }), loadSyncStatus()]);
      } catch (error) {
        toast(describeThrownSyncError(error));
      } finally {
        setSyncPhase("idle");
      }
    },
    [describeThrownSyncError, downloadPlan, intl, load, loadSyncStatus, syncService],
  );

  const handleSyncRestoreOpen = useCallback(async () => {
    if (!syncService || typeof syncService.listSyncBackups !== "function") {
      return;
    }
    setSyncPhase("previewing");
    try {
      const backups = await syncService.listSyncBackups();
      if (backups.backups.length === 0) {
        toast(intl.formatMessage({ id: "settings.configSync.restoreEmpty" }));
        return;
      }
      setRestoreBackups(backups);
    } catch (error) {
      toast(describeThrownSyncError(error));
    } finally {
      setSyncPhase("idle");
    }
  }, [describeThrownSyncError, intl, syncService]);

  const handleSyncRestore = useCallback(
    async (params: { backupDir: string }) => {
      if (!syncService || typeof syncService.restoreSyncBackup !== "function") {
        return;
      }
      setSyncPhase("applying");
      try {
        const result = await syncService.restoreSyncBackup(params);
        if (result.status === "error") {
          if (result.error.code !== "busy") {
            toast(describeConfigSyncError(intl, result.error));
          }
          return;
        }
        setRestoreBackups(null);
        toast(
          intl.formatMessage(
            { id: "settings.configSync.restored" },
            { count: result.itemCount ?? 0 },
          ),
        );
        await Promise.all([load({ force: true }), loadSyncStatus()]);
      } catch (error) {
        toast(describeThrownSyncError(error));
      } finally {
        setSyncPhase("idle");
      }
    },
    [describeThrownSyncError, intl, load, loadSyncStatus, syncService],
  );

  const handleDeleteRow = useCallback(
    async (item: PromptTemplateSummary) => {
      if (readOnly || !service) {
        return;
      }
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "settings.promptLibrary.form.delete.title" }),
        description: intl.formatMessage(
          { id: "settings.promptLibrary.form.delete.description" },
          { name: item.title },
        ),
        confirmLabel: intl.formatMessage({ id: "common.delete" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
        confirmVariant: "destructive",
        defaultFocus: "cancel",
      });
      if (!confirmed) {
        return;
      }
      try {
        const result = await library.removePrompt(item.id);
        if (!result.ok) {
          toast(describeFailure(result));
          return;
        }
        toast(intl.formatMessage({ id: "settings.promptLibrary.toast.deleted" }));
      } catch (error) {
        reportOperationFailure(error);
      }
    },
    [confirmDialog, describeFailure, intl, library, readOnly, reportOperationFailure, service],
  );

  // 新建/编辑返回列表后，把目标行滚入视野。
  useEffect(() => {
    if (view !== "list" || !pendingRevealIdRef.current) {
      return;
    }
    const revealId = pendingRevealIdRef.current;
    pendingRevealIdRef.current = null;
    requestAnimationFrame(() => {
      rowRefs.current.get(revealId)?.scrollIntoView({ block: "nearest" });
    });
  }, [view, items]);

  const sortedItems = useMemo(() => sortPromptLibraryItems(items, sortMode), [items, sortMode]);
  const filteredItems = useMemo(
    () => filterPromptTemplates(sortedItems, searchQuery),
    [searchQuery, sortedItems],
  );
  const hasQuery = searchQuery.trim().length > 0;
  const pinnedItems = filteredItems.filter((item) => item.pinned);
  const unpinnedItems = filteredItems.filter((item) => !item.pinned);
  const hasAnyItems = items.length > 0;

  const handleFormEscape = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (view !== "editor" || event.key !== "Escape" || event.defaultPrevented) {
        return;
      }
      if (event.nativeEvent.isComposing) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void requestCloseEditor();
    },
    [requestCloseEditor, view],
  );

  const newButton = (
    <Button
      type="button"
      variant="default"
      size="lg"
      onClick={openCreateEditor}
      disabled={readOnly || !service}
      data-testid={TID_SETTINGS_PROMPT_LIBRARY_NEW}
      className="h-11 sm:h-8"
    >
      <Plus data-icon="inline-start" aria-hidden="true" />
      {intl.formatMessage({ id: "settings.promptLibrary.new" })}
    </Button>
  );

  const renderRow = (item: PromptTemplateSummary) => {
    const lastUsedLabel =
      typeof item.lastUsedAt === "number"
        ? intl.formatMessage(
            { id: "settings.promptLibrary.row.lastUsed" },
            { time: formatTaskRelativeTime(item.lastUsedAt, intl) },
          )
        : intl.formatMessage({ id: "settings.promptLibrary.row.neverUsed" });

    return (
      <div
        ref={(node) => {
          if (node) {
            rowRefs.current.set(item.id, node);
          } else {
            rowRefs.current.delete(item.id);
          }
        }}
        role="button"
        tabIndex={0}
        aria-label={item.title}
        data-testid={testId(TID_SETTINGS_PROMPT_LIBRARY_ROW, item.id)}
        className="flex min-h-[72px] w-full cursor-pointer items-start gap-2 px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none"
        onClick={() => void openEditEditor(item)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void openEditEditor(item);
          }
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          aria-label={intl.formatMessage({
            id: item.pinned
              ? "settings.promptLibrary.pin.remove"
              : "settings.promptLibrary.pin.add",
          })}
          aria-pressed={item.pinned}
          data-testid={testId(TID_SETTINGS_PROMPT_LIBRARY_PIN, item.id)}
          className="mt-0.5 size-11 shrink-0 text-foreground-subtle sm:size-8"
          disabled={readOnly}
          onClick={(event) => {
            event.stopPropagation();
            void handleTogglePin(item);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.stopPropagation();
            }
          }}
          onMouseDown={(event) => {
            // 置顶按钮只切换状态，不打开编辑视图。
            event.stopPropagation();
          }}
        >
          {item.pinned ? (
            <Pin className="size-4" aria-hidden="true" />
          ) : (
            <PinOff className="size-4" aria-hidden="true" />
          )}
        </Button>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-ui-base font-medium text-foreground">{item.title}</span>
            {item.alias ? (
              <span className="ml-auto shrink-0 font-mono text-ui-xs text-foreground-subtlest">
                ;{item.alias}
              </span>
            ) : null}
          </div>
          <div className="truncate text-ui-sm text-foreground-subtle">{item.contentPreview}</div>
          <div className="flex flex-wrap items-center gap-2">
            <PromptRowTags tags={item.tags} />
            <span className="text-ui-xs text-foreground-subtlest">{lastUsedLabel}</span>
          </div>
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon-md"
          aria-label={intl.formatMessage({ id: "settings.promptLibrary.delete" })}
          data-testid={testId(TID_SETTINGS_PROMPT_LIBRARY_DELETE, item.id)}
          className="mt-0.5 size-11 shrink-0 text-foreground-subtle hover:text-destructive sm:size-8"
          disabled={readOnly || !service}
          onClick={(event) => {
            event.stopPropagation();
            void handleDeleteRow(item);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.stopPropagation();
            }
          }}
          onMouseDown={(event) => {
            // 删除按钮只打开确认弹窗，不触发行进入编辑视图。
            event.stopPropagation();
          }}
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </Button>
      </div>
    );
  };

  const renderGroup = (
    title: string,
    groupItems: readonly PromptTemplateSummary[],
    count: number,
  ) => (
    <section className="space-y-3">
      <SettingsResourceGroupHeader count={count} title={title} />
      <SettingsResourceList items={groupItems} getKey={(item) => item.id} renderItem={renderRow} />
    </section>
  );

  if (!library.available) {
    return (
      <div
        data-testid={TID_SETTINGS_PROMPT_LIBRARY}
        className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle"
      >
        {intl.formatMessage({ id: "settings.promptLibrary.unsupported" })}
      </div>
    );
  }

  if (view === "editor") {
    const editorTitle = editingInitial
      ? intl.formatMessage({ id: "settings.promptLibrary.edit" })
      : intl.formatMessage({ id: "settings.promptLibrary.new" });
    return (
      <div
        data-testid={TID_SETTINGS_PROMPT_LIBRARY}
        className="space-y-6"
        onKeyDown={handleFormEscape}
      >
        <SettingsBreadcrumbReporter
          items={[{ label: editingInitial?.title ?? editorTitle }]}
          onSectionSelect={() => void requestCloseEditor()}
        />
        <div className="space-y-1">
          <h3 className="text-ui-xl font-semibold text-foreground">{editorTitle}</h3>
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.promptLibrary.description" })}
          </p>
        </div>
        {editorLoading ? (
          <PluginLoadingState
            label={intl.formatMessage({ id: "settings.promptLibrary.loading" })}
          />
        ) : (
          <PromptLibraryForm
            initial={editingInitial}
            existingItems={items}
            saving={saving}
            readOnly={readOnly}
            onSave={handleSave}
            onCancel={() => void requestCloseEditor()}
            onDelete={editingInitial ? () => void handleDelete() : undefined}
            onDirtyChange={setDirty}
          />
        )}
      </div>
    );
  }

  return (
    <div data-testid={TID_SETTINGS_PROMPT_LIBRARY} className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.promptLibrary.description" })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {syncSupported && syncBusy && !syncStatus ? (
            <span className="inline-flex items-center gap-1.5 text-ui-base text-foreground-subtle">
              <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.configSync.inProgress" })}
            </span>
          ) : null}
          {syncSupported ? (
            <SettingsResourceHeaderActions
              onUploadToGithub={() => void handleSyncUpload()}
              onDownloadFromGithub={() => void handleSyncPreview()}
              onRestoreFromBackup={() => void handleSyncRestoreOpen()}
              uploadToGithubDisabled={readOnly || syncBusy}
              downloadFromGithubDisabled={readOnly || syncBusy}
              restoreFromBackupDisabled={
                readOnly || syncBusy || (syncStatus?.backupCount ?? 0) === 0
              }
              uploadToGithubTestId={TID_SETTINGS_PROMPT_LIBRARY_CONFIG_UPLOAD}
              downloadFromGithubTestId={TID_SETTINGS_PROMPT_LIBRARY_CONFIG_DOWNLOAD}
              restoreFromBackupTestId={TID_SETTINGS_PROMPT_LIBRARY_CONFIG_RESTORE}
            />
          ) : null}
          {hasAnyItems ? newButton : null}
        </div>
      </div>

      {syncSupported && syncStatus ? (
        <ConfigSyncStatusRow
          status={syncStatus}
          busy={syncBusy}
          onOpenSyncConfigSettings={onOpenSyncConfigSettings}
          testId={TID_SETTINGS_PROMPT_LIBRARY_SYNC_STATUS}
          goLoginTestId={testId(TID_SETTINGS_PROMPT_LIBRARY_SYNC_STATUS, "go-login")}
        />
      ) : null}

      {syncSupported && readOnly ? (
        <p className="text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.promptLibrary.sync.readOnlyDisabled" })}
        </p>
      ) : null}

      {library.warning ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-ui-base text-warning"
        >
          <span className="min-w-0">{library.warning.message}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 sm:h-6"
            onClick={() => void handleResetLibrary()}
          >
            {intl.formatMessage({ id: "settings.promptLibrary.warning.rebuild" })}
          </Button>
        </div>
      ) : null}

      {readOnly ? (
        <div className="rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.promptLibrary.readOnly" })}
        </div>
      ) : null}

      {library.error && hasAnyItems && !errorDismissed ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
        >
          <span className="min-w-0">{library.error}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={intl.formatMessage({ id: "common.close" })}
            onClick={() => setErrorDismissed(true)}
          >
            <X className="size-3.5" aria-hidden="true" />
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SettingsSearchInput
          containerClassName="min-w-0 flex-1"
          className="h-11 sm:h-9"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onClear={() => setSearchQuery("")}
          clearLabel={intl.formatMessage({ id: "settings.promptLibrary.clearSearch" })}
          clearTestId={TID_SETTINGS_PROMPT_LIBRARY_SEARCH_CLEAR}
          placeholder={intl.formatMessage({
            id: "settings.promptLibrary.searchPlaceholder",
          })}
          aria-label={intl.formatMessage({
            id: "settings.promptLibrary.searchPlaceholder",
          })}
          data-testid={TID_SETTINGS_PROMPT_LIBRARY_SEARCH}
        />
        <div className="flex items-center gap-2">
          <span className="shrink-0 text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.promptLibrary.sort.label" })}
          </span>
          <Select value={sortMode} onValueChange={handleSortChange}>
            <SelectTrigger
              size="lg"
              className="h-11 min-w-32 sm:h-8"
              data-testid={TID_SETTINGS_PROMPT_LIBRARY_SORT}
              aria-label={intl.formatMessage({ id: "settings.promptLibrary.sort.label" })}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent position="popper" align="end" sideOffset={4}>
              <SelectItem value="recentUsed">
                {intl.formatMessage({ id: "settings.promptLibrary.sort.recentUsed" })}
              </SelectItem>
              <SelectItem value="recentUpdated">
                {intl.formatMessage({ id: "settings.promptLibrary.sort.recentUpdated" })}
              </SelectItem>
              <SelectItem value="name">
                {intl.formatMessage({ id: "settings.promptLibrary.sort.name" })}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {library.error && !hasAnyItems ? (
        <div
          data-testid={TID_SETTINGS_PROMPT_LIBRARY_ERROR}
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-dashed border-destructive/40 px-4 py-6 text-ui-base text-destructive"
        >
          <span>{intl.formatMessage({ id: "settings.promptLibrary.loadFailed" })}</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 sm:h-6"
            onClick={() => void load({ force: true })}
          >
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : !library.loaded || (library.loading && !hasAnyItems) ? (
        <PluginLoadingState label={intl.formatMessage({ id: "settings.promptLibrary.loading" })} />
      ) : !hasAnyItems ? (
        <div data-testid={TID_SETTINGS_PROMPT_LIBRARY_EMPTY}>
          <PluginInstallEmptyState
            title={intl.formatMessage({ id: "settings.promptLibrary.empty.title" })}
            description={intl.formatMessage({
              id: "settings.promptLibrary.empty.description",
            })}
            actions={
              <Button
                type="button"
                variant="default"
                size="lg"
                onClick={openCreateEditor}
                disabled={readOnly}
                data-testid={TID_SETTINGS_PROMPT_LIBRARY_NEW}
                className="h-11 sm:h-8"
              >
                <Plus data-icon="inline-start" aria-hidden="true" />
                {intl.formatMessage({ id: "settings.promptLibrary.new" })}
              </Button>
            }
          />
        </div>
      ) : hasQuery && filteredItems.length === 0 ? (
        <div className="space-y-3">
          <PluginSearchEmptyState
            label={intl.formatMessage({ id: "settings.promptLibrary.searchEmpty" })}
          />
          <div className="flex justify-center">
            <Button type="button" variant="link" size="lg" onClick={() => setSearchQuery("")}>
              {intl.formatMessage({ id: "settings.promptLibrary.clearSearch" })}
            </Button>
          </div>
        </div>
      ) : (
        <div data-testid={TID_SETTINGS_PROMPT_LIBRARY_LIST} className="space-y-6">
          {hasQuery ? (
            renderGroup(
              intl.formatMessage({ id: "settings.promptLibrary.group.search" }),
              filteredItems,
              filteredItems.length,
            )
          ) : (
            <>
              {pinnedItems.length > 0
                ? renderGroup(
                    intl.formatMessage({ id: "settings.promptLibrary.group.pinned" }),
                    pinnedItems,
                    pinnedItems.length,
                  )
                : null}
              {unpinnedItems.length > 0
                ? renderGroup(
                    intl.formatMessage({ id: "settings.promptLibrary.group.all" }),
                    unpinnedItems,
                    items.length,
                  )
                : null}
            </>
          )}
        </div>
      )}

      {/* 同步确认弹窗按需挂载，关闭即丢弃勾选状态。 */}
      {downloadPlan ? (
        <ConfigSyncDownloadDialog
          plan={downloadPlan}
          applying={syncPhase === "applying"}
          onCancel={() => setDownloadPlan(null)}
          onConfirm={(params) => void handleSyncApply(params)}
          testId="prompt-library-config-sync-confirm"
          replaceAckTestId="prompt-library-config-sync-replace-ack"
        />
      ) : null}
      {restoreBackups ? (
        <ConfigSyncRestoreDialog
          backups={restoreBackups}
          restoring={syncPhase === "applying"}
          onCancel={() => setRestoreBackups(null)}
          onConfirm={(params) => void handleSyncRestore(params)}
          testId="prompt-library-config-sync-restore-confirm"
          optionTestId="prompt-library-config-sync-restore-option"
        />
      ) : null}
      {secretWarnings ? (
        <ConfigSyncSecretWarningDialog
          warnings={secretWarnings}
          uploading={syncPhase === "uploading"}
          onCancel={() => setSecretWarnings(null)}
          onConfirm={() => void handleSyncUpload({ confirmSecretUpload: true })}
          testId="prompt-library-config-sync-secret-warning"
        />
      ) : null}
    </div>
  );
}
