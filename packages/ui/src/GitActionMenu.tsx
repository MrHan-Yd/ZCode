/* eslint-disable max-lines -- 顶部 Git 操作当前集中承载 trigger、commit dialog 和 push dialog；先按工作流边界收口，避免为了拆行数把状态机打散。 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type {
  GitCommitMessageConversationContext,
  GitIdentity,
  GitRepositorySummary,
  ModelSelection,
  ZCodeTaskChangeSummary,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Command, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { toast } from "@/components/ui/toast.js";
import {
  buildGitBranchCommitPreviewFiles,
  getGitBranchCommitTotals,
  resolveGitBranchTriggerLabel,
} from "@/git-branch-switcher/display.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { hasGitCommitIdentity } from "@/git-branch-switcher/switchAssist.js";
import {
  canUseGitActionMenu,
  canPushGitBranch,
  collectCommitPreviewStagePaths,
  dedupeCommitPreviewFiles,
  excludeCommitPreviewFiles,
  resolveCommitPreviewSelectionState,
  resolveGitActionMenuPrimaryAction,
  splitCommitPreviewFilePath,
} from "@/git-action-menu/display.js";
import {
  filterCommitPreviewFilesByCurrentSession,
  getCurrentSessionFilePaths,
} from "@/git-action-menu/currentSessionFileScope.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { formatCommandShortcutLabel, matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { logger } from "@/logger.js";
import {
  AlertCircleIcon,
  ArrowUpFromLine,
  CheckIcon,
  CloudUploadIcon,
  GitBranchIcon,
  GitCommitIcon,
  LoaderIcon,
  SparklesIcon,
} from "lucide-react";

interface GitActionMenuProps {
  workspacePath: string;
  workspaceIdentity?: string;
  gitSummary: GitRepositorySummary;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  commitMessageConversationContext?: GitCommitMessageConversationContext | null;
  /** 当前会话正在使用的模型；生成提交消息缺省继承它。 */
  commitMessageModelSelection?: ModelSelection | null;
  onRefreshGit: () => void;
  className?: string;
  triggerIconOnly?: boolean;
  triggerLayout?: "header" | "status-row";
}

type GitCommitPreviewFile = ReturnType<typeof buildGitBranchCommitPreviewFiles>[number];

const COMMIT_DIALOG_ACTION_IDS = ["commit", "commitAndPush", "push"] as const;
const GIT_COMMIT_MESSAGE_TEXTAREA_ID = "git-action-menu-commit-message";
const TID_GIT_ACTION_TRIGGER = "git-action-trigger";
const TID_GIT_COMMIT_ACTION_COMMAND = "git-commit-action-command";
const TID_GIT_COMMIT_ACTION_ITEM = "git-commit-action-item";
const TID_GIT_COMMIT_DIALOG = "git-commit-dialog";
const TID_GIT_COMMIT_FILE_ITEM = "git-commit-file-item";
const TID_GIT_COMMIT_FILE_LIST = "git-commit-file-list";
const TID_GIT_COMMIT_GENERATE_BUTTON = "git-commit-generate-button";
const TID_GIT_COMMIT_INCLUDE_UNSTAGED = "git-commit-include-unstaged";
const TID_GIT_COMMIT_MESSAGE_INPUT = "git-commit-message-input";
const TID_GIT_COMMIT_SELECT_ALL = "git-commit-select-all";

/** 默认排除集合。始终作为不可变值使用：所有写入路径都构造新 Set，不会就地修改它。 */
const EMPTY_COMMIT_EXCLUDED_PATHS: ReadonlySet<string> = new Set<string>();

type CommitDialogActionId = (typeof COMMIT_DIALOG_ACTION_IDS)[number];

function gitCommitActionItemTestId(actionId: CommitDialogActionId): string {
  return `${TID_GIT_COMMIT_ACTION_ITEM}-${actionId}`;
}

function isCommitDialogActionId(value: string): value is CommitDialogActionId {
  return COMMIT_DIALOG_ACTION_IDS.includes(value as CommitDialogActionId);
}

function isCommitMessageTextAreaTarget(target: EventTarget | null): target is HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement && target.id === GIT_COMMIT_MESSAGE_TEXTAREA_ID;
}

interface GitCommitDialogState {
  summary: GitRepositorySummary;
  identity: GitIdentity | null;
  activeTaskChangeSummary: ZCodeTaskChangeSummary | null;
  stagedFiles: GitCommitPreviewFile[];
  unstagedFiles: GitCommitPreviewFile[];
}

interface GitCommitDialogProps {
  open: boolean;
  loading: boolean;
  state: GitCommitDialogState | null;
  workspacePath: string;
  message: string;
  error: string | null;
  mutationPending: boolean;
  generationPending: boolean;
  includeUnstaged: boolean;
  /** 本次不参与提交的文件（key 为 `stagePath`）；空集表示全部提交。 */
  excludedStagePaths: ReadonlySet<string>;
  pushEnabled: boolean;
  onRefreshGit: () => void;
  onOpenChange: (nextOpen: boolean) => void;
  onMessageChange: (nextValue: string) => void;
  onIncludeUnstagedChange: (nextValue: boolean) => void;
  onToggleFileSelection: (stagePath: string) => void;
  onSetAllFilesSelected: (selected: boolean) => void;
  onGenerateMessage: () => void;
  onSubmit: () => void;
  onSubmitAndPush: () => void;
  onPushOnly: () => void;
}

function getCommitDialogFiles(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
): GitCommitPreviewFile[] {
  return includeUnstaged ? [...state.unstagedFiles, ...state.stagedFiles] : state.stagedFiles;
}

/**
 * 弹窗可勾选的文件：staged 与 unstaged 合并后按 `stagePath` 去重。
 * 同一路径只有一行勾选，勾选结果才能原样映射回 `GitCommitRequest.paths`。
 */
function getCommitDialogSelectableFiles(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
): GitCommitPreviewFile[] {
  return dedupeCommitPreviewFiles(getCommitDialogFiles(state, includeUnstaged));
}

function getCommitDialogSelectedFiles(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
  excludedPaths: ReadonlySet<string>,
): GitCommitPreviewFile[] {
  return excludeCommitPreviewFiles(
    getCommitDialogSelectableFiles(state, includeUnstaged),
    excludedPaths,
  );
}

function getCommitDialogStagePaths(
  state: GitCommitDialogState,
  includeUnstaged: boolean,
  excludedPaths: ReadonlySet<string> = EMPTY_COMMIT_EXCLUDED_PATHS,
): string[] {
  return collectCommitPreviewStagePaths(
    getCommitDialogSelectedFiles(state, includeUnstaged, excludedPaths),
  );
}

function CommitCommandActionItem({
  id,
  icon,
  label,
  shortcutLabel,
  disabled,
  loading,
  onSelect,
}: {
  id: CommitDialogActionId;
  icon: ReactNode;
  label: string;
  shortcutLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      data-testid={gitCommitActionItemTestId(id)}
      value={id}
      disabled={disabled}
      onSelect={() => {
        if (!disabled) {
          onSelect();
        }
      }}
      className={cn(
        "h-9 px-2.5 py-1.5 font-medium",
        disabled ? "cursor-default text-foreground-subtlest" : "text-foreground",
      )}
    >
      <span className="flex size-5 shrink-0 items-center justify-center">
        {loading ? <LoaderIcon className="size-4 animate-spin" /> : icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcutLabel ? <CommandShortcut>{shortcutLabel}</CommandShortcut> : null}
    </CommandItem>
  );
}

function GitCommitDialog({
  open,
  loading,
  state,
  workspacePath,
  message,
  error,
  mutationPending,
  generationPending,
  includeUnstaged,
  excludedStagePaths,
  pushEnabled,
  onRefreshGit,
  onOpenChange,
  onMessageChange,
  onIncludeUnstagedChange,
  onToggleFileSelection,
  onSetAllFilesSelected,
  onGenerateMessage,
  onSubmit,
  onSubmitAndPush,
  onPushOnly,
}: GitCommitDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const [selectedActionId, setSelectedActionId] = useState<CommitDialogActionId>("commit");
  const messageTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageInputFocusedOnOpenRef = useRef(false);
  const numberFormatter = new Intl.NumberFormat(locale);
  const hasIdentity = hasGitCommitIdentity(state?.identity ?? null);
  const messageReady = message.trim().length > 0;
  const actionPending = mutationPending || generationPending;
  const selectableFiles = state ? getCommitDialogSelectableFiles(state, includeUnstaged) : [];
  const selectedFiles = state
    ? getCommitDialogSelectedFiles(state, includeUnstaged, excludedStagePaths)
    : [];
  const stagePaths = collectCommitPreviewStagePaths(selectedFiles);
  const dirtyFileCount = state ? getCommitDialogStagePaths(state, true).length : 0;
  const { fileCount, totalAdded, totalRemoved } = getGitBranchCommitTotals(selectedFiles);
  const selectionState = resolveCommitPreviewSelectionState(selectableFiles, excludedStagePaths);
  const displayChangeSummary = state?.activeTaskChangeSummary ?? null;
  const displayAdded = displayChangeSummary?.added ?? totalAdded;
  const displayRemoved = displayChangeSummary?.removed ?? totalRemoved;
  const hasSelectedChanges = stagePaths.length > 0;
  const hasUnstagedChanges = Boolean(state?.unstagedFiles.length);
  // 只有一个文件时勾选没有自由度，渲染清单只是噪声：总数已由开关行右侧的计数表达。
  const showFileList = selectableFiles.length > 1;
  const commitActionDisabled =
    actionPending || !hasSelectedChanges || (!hasIdentity && state?.identity !== null);
  const pushOnlyDisabled = actionPending || !pushEnabled;
  const commitShortcutLabel = formatCommandShortcutLabel("⏎");
  const commitActions = useMemo(
    () => [
      {
        id: "commit" as const,
        icon: <GitCommitIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.commitDialog.action.commit",
        }),
        disabled: commitActionDisabled,
        loading: mutationPending,
        onSelect: onSubmit,
      },
      {
        id: "commitAndPush" as const,
        icon: <CloudUploadIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.commitDialog.action.commitAndPush",
        }),
        disabled: commitActionDisabled,
        loading: mutationPending,
        onSelect: onSubmitAndPush,
      },
      {
        id: "push" as const,
        icon: <CloudUploadIcon className="size-4" />,
        label: intl.formatMessage({
          id: "git.actionMenu.push",
        }),
        disabled: pushOnlyDisabled,
        loading: false,
        onSelect: onPushOnly,
      },
    ],
    [
      commitActionDisabled,
      intl,
      mutationPending,
      onPushOnly,
      onSubmit,
      onSubmitAndPush,
      pushOnlyDisabled,
    ],
  );

  useEffect(() => {
    if (open) {
      setSelectedActionId("commit");
    }
  }, [open]);

  useEffect(() => {
    if (!open) {
      messageInputFocusedOnOpenRef.current = false;
      return;
    }
    if (loading || !state || actionPending || messageInputFocusedOnOpenRef.current) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      // 打开弹窗后的默认焦点要落在提交信息里，方便立即编辑或生成后微调。
      messageTextareaRef.current?.focus();
      messageInputFocusedOnOpenRef.current = true;
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [actionPending, loading, open, state]);

  useEffect(() => {
    // 弹窗加载 Git 状态前提交动作会短暂不可用，不能在 loading 阶段把默认选择跳到推送。
    if (!open || loading || !state || actionPending) {
      return;
    }

    const selectedAction = commitActions.find((action) => action.id === selectedActionId);
    if (selectedAction && !selectedAction.disabled) {
      return;
    }

    const firstEnabledAction = commitActions.find((action) => !action.disabled);
    if (firstEnabledAction && firstEnabledAction.id !== selectedActionId) {
      setSelectedActionId(firstEnabledAction.id);
    }
  }, [actionPending, commitActions, loading, open, selectedActionId, state]);

  const triggerSelectedAction = useCallback(() => {
    const selectedAction = commitActions.find((action) => action.id === selectedActionId);
    if (!selectedAction || selectedAction.disabled) {
      return;
    }
    selectedAction.onSelect();
  }, [commitActions, selectedActionId]);

  const selectAdjacentAction = useCallback(
    (direction: 1 | -1) => {
      setSelectedActionId((currentActionId) => {
        const enabledActions = commitActions.filter((action) => !action.disabled);
        if (enabledActions.length === 0) {
          return currentActionId;
        }

        const currentIndex = enabledActions.findIndex((action) => action.id === currentActionId);
        if (currentIndex === -1) {
          return enabledActions[0]?.id ?? currentActionId;
        }

        const nextIndex =
          (currentIndex + direction + enabledActions.length) % enabledActions.length;
        return enabledActions[nextIndex]?.id ?? currentActionId;
      });
    },
    [commitActions],
  );

  const handleActionCommandKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      selectAdjacentAction(event.key === "ArrowDown" ? 1 : -1);
    },
    [selectAdjacentAction],
  );

  const handleDialogKeyDown = useCallback(
    (event: KeyboardEvent<HTMLFormElement>) => {
      if (
        isCommitMessageTextAreaTarget(event.target) &&
        (event.key === "ArrowDown" || event.key === "ArrowUp")
      ) {
        // 输入框保持焦点时也允许切换下方 Command 操作，避免键盘流断掉。
        event.preventDefault();
        event.stopPropagation();
        selectAdjacentAction(event.key === "ArrowDown" ? 1 : -1);
        return;
      }

      if (!matchesPrimaryShortcut(event, "Enter")) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      triggerSelectedAction();
    },
    [selectAdjacentAction, triggerSelectedAction],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={TID_GIT_COMMIT_DIALOG}
        showCloseButton={false}
        className="max-w-md gap-0 overflow-hidden border-popover-border bg-popover p-0 shadow-lg"
        onOpenAutoFocus={(event) => {
          if (!loading && state && !actionPending) {
            event.preventDefault();
          }
        }}
      >
        {loading ? (
          <div className="flex h-56 items-center justify-center px-5 py-5 text-foreground-subtle">
            <LoaderIcon className="size-5 animate-spin" />
          </div>
        ) : state ? (
          <form
            // 弹窗外壳是 grid 容器，子项默认 min-width:auto：长文件路径会把整行撑出弹窗边框，
            // 而不是在行内截断。min-w-0 是下方 truncate 生效的前提。
            // 高度按视口封顶，超出的部分由 form 自身滚动；各区块 shrink-0 才不会在滚动时被压扁。
            className="flex max-h-[calc(100dvh-3rem)] min-h-0 min-w-0 flex-col overflow-y-auto"
            onKeyDownCapture={handleDialogKeyDown}
            onSubmit={(event: FormEvent<HTMLFormElement>) => {
              event.preventDefault();
              triggerSelectedAction();
            }}
          >
            <div className="flex shrink-0 min-w-0 items-center justify-between gap-3 px-4 py-3">
              <GitBranchSwitcher
                workspacePath={workspacePath}
                gitSummary={state.summary}
                dirtyFileCount={dirtyFileCount}
                onRefreshGit={onRefreshGit}
                className="min-w-0 px-0 pt-0"
                triggerClassName="h-7 max-w-64 justify-start rounded-lg px-1.5 text-foreground-subtle hover:bg-hover hover:text-foreground [&>span]:max-w-48"
                popoverSide="bottom"
                popoverClassName="w-80"
                branchListClassName="max-h-56"
                showFooterActions={false}
              />
              <div className="flex shrink-0 items-center gap-1.5 font-mono text-ui-base">
                <span className="text-diff-added">+{numberFormatter.format(displayAdded)}</span>
                <span className="text-diff-removed">-{numberFormatter.format(displayRemoved)}</span>
              </div>
            </div>

            <div className="min-h-36 shrink-0 px-4 pb-2">
              <label htmlFor={GIT_COMMIT_MESSAGE_TEXTAREA_ID} className="sr-only">
                {intl.formatMessage({
                  id: "git.actionMenu.commitDialog.messageLabel",
                })}
              </label>
              <div className="relative">
                <Textarea
                  ref={messageTextareaRef}
                  data-testid={TID_GIT_COMMIT_MESSAGE_INPUT}
                  id={GIT_COMMIT_MESSAGE_TEXTAREA_ID}
                  value={message}
                  disabled={actionPending}
                  placeholder={intl.formatMessage({
                    id: "git.actionMenu.commitDialog.messagePlaceholder",
                  })}
                  className="field-sizing-fixed min-h-28 rounded-none border-0 bg-transparent px-0 py-2 pr-8 text-ui-base font-medium text-foreground shadow-none placeholder:text-foreground-subtle focus-visible:border-transparent focus-visible:bg-transparent focus-visible:ring-0 md:text-ui-base"
                  onChange={(event) => {
                    onMessageChange(event.target.value);
                  }}
                />
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      data-testid={TID_GIT_COMMIT_GENERATE_BUTTON}
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={onGenerateMessage}
                      disabled={
                        actionPending ||
                        !hasSelectedChanges ||
                        (!hasIdentity && state.identity !== null)
                      }
                      aria-label={intl.formatMessage({
                        id: messageReady
                          ? "git.actionMenu.commitDialog.regenerate"
                          : "git.actionMenu.commitDialog.generate",
                      })}
                      className="absolute right-0 top-1.5 text-foreground-subtle hover:text-foreground"
                    >
                      {generationPending ? (
                        <LoaderIcon className="size-4 animate-spin" />
                      ) : (
                        <SparklesIcon className="size-4" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" align="end" sideOffset={6}>
                    {intl.formatMessage({
                      id: messageReady
                        ? "git.actionMenu.commitDialog.regenerate"
                        : "git.actionMenu.commitDialog.generate",
                    })}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>

            <div className="shrink-0 px-2.5 pb-2">
              <button
                type="button"
                role="checkbox"
                data-testid={TID_GIT_COMMIT_INCLUDE_UNSTAGED}
                aria-checked={includeUnstaged}
                disabled={actionPending || !hasUnstagedChanges}
                onClick={() => onIncludeUnstagedChange(!includeUnstaged)}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-ui-base font-medium transition-colors",
                  actionPending || !hasUnstagedChanges
                    ? "cursor-default text-foreground-subtle"
                    : "cursor-pointer text-foreground hover:bg-menu-hover",
                )}
              >
                <span className="flex size-5 shrink-0 items-center justify-center">
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-sm border",
                      includeUnstaged
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-transparent",
                    )}
                  >
                    <CheckIcon className="size-3.5" />
                  </span>
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {intl.formatMessage({
                    id: "git.actionMenu.commitDialog.includeUnstaged",
                  })}
                </span>
                <span className="shrink-0 text-ui-base font-normal text-foreground-subtle">
                  {selectionState === "all"
                    ? intl.formatMessage(
                        {
                          id: "git.actionMenu.commitDialog.changesValue",
                        },
                        {
                          count: numberFormatter.format(fileCount),
                        },
                      )
                    : intl.formatMessage(
                        {
                          id: "git.actionMenu.commitDialog.changesValueSelected",
                        },
                        {
                          selected: numberFormatter.format(fileCount),
                          total: numberFormatter.format(selectableFiles.length),
                        },
                      )}
                </span>
              </button>
            </div>

            {showFileList ? (
              <div className="shrink-0 px-2.5 pb-2" data-testid={TID_GIT_COMMIT_FILE_LIST}>
                <label className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-ui-base text-foreground-subtle hover:bg-menu-hover">
                  <Checkbox
                    data-testid={TID_GIT_COMMIT_SELECT_ALL}
                    checked={
                      selectionState === "all"
                        ? true
                        : selectionState === "partial"
                          ? "indeterminate"
                          : false
                    }
                    disabled={actionPending}
                    onCheckedChange={(nextChecked) => {
                      onSetAllFilesSelected(nextChecked === true);
                    }}
                    aria-label={intl.formatMessage({
                      id: "git.actionMenu.commitDialog.fileList.selectAll",
                    })}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {intl.formatMessage({ id: "git.actionMenu.commitDialog.fileList.label" })}
                  </span>
                </label>

                {/* 高度按视口取上限：文件多时清单内部滚动，表头计数与底部提交动作始终留在视野内。 */}
                <div className="max-h-[min(40vh,18rem)] overflow-x-hidden overflow-y-auto overscroll-contain pr-1">
                  {selectableFiles.map((file) => {
                    const isSelected = !excludedStagePaths.has(file.stagePath);
                    const { directory, fileName } = splitCommitPreviewFilePath(
                      file.repoRelativePath,
                    );
                    return (
                      <label
                        key={file.stagePath}
                        data-testid={`${TID_GIT_COMMIT_FILE_ITEM}-${file.repoRelativePath}`}
                        className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-menu-hover"
                        title={file.repoRelativePath}
                      >
                        <Checkbox
                          checked={isSelected}
                          disabled={actionPending}
                          onCheckedChange={() => {
                            onToggleFileSelection(file.stagePath);
                          }}
                        />
                        {/* 目录先截断，文件名优先保留：同名文件靠文件名区分。
                            目录只收缩不伸展（不能给 flex-1，否则短目录会把文件名挤到行尾）；
                            文件名 shrink-0 + max-w-full，只在自身就超出整行时才截断。 */}
                        <span className="flex min-w-0 flex-1 items-center gap-1 font-mono text-ui-base">
                          {directory ? (
                            <span className="min-w-0 truncate text-foreground-subtlest">
                              {directory}/
                            </span>
                          ) : null}
                          <span
                            className={cn(
                              "max-w-full shrink-0 truncate",
                              isSelected ? "text-foreground" : "text-foreground-subtle",
                            )}
                          >
                            {fileName}
                          </span>
                        </span>
                        <span className="shrink-0 font-mono text-ui-base">
                          <span className="text-diff-added">
                            +{numberFormatter.format(file.added)}
                          </span>{" "}
                          <span className="text-diff-removed">
                            -{numberFormatter.format(file.removed)}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="shrink-0 border-t border-border/50 px-2.5 py-2">
              {!hasIdentity ? (
                <div className="mb-1.5 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-ui-base text-warning">
                  <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                  <p>
                    {intl.formatMessage({
                      id: "git.actionMenu.commitDialog.identityMissing",
                    })}
                  </p>
                </div>
              ) : null}

              {error ? <p className="px-3 py-1.5 text-ui-base text-destructive">{error}</p> : null}

              <Command
                data-testid={TID_GIT_COMMIT_ACTION_COMMAND}
                shouldFilter={false}
                loop
                tabIndex={0}
                value={selectedActionId}
                onValueChange={(nextValue) => {
                  if (isCommitDialogActionId(nextValue)) {
                    setSelectedActionId(nextValue);
                  }
                }}
                onKeyDown={handleActionCommandKeyDown}
                aria-label={intl.formatMessage({
                  id: "git.actionMenu.trigger.ariaLabel",
                })}
                className="rounded-none bg-transparent p-0 text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
              >
                <CommandList className="max-h-none scroll-py-1">
                  {commitActions.map((action) => (
                    <CommitCommandActionItem
                      key={action.id}
                      id={action.id}
                      icon={action.icon}
                      label={action.label}
                      shortcutLabel={
                        selectedActionId === action.id ? commitShortcutLabel : undefined
                      }
                      disabled={action.disabled}
                      loading={action.loading}
                      onSelect={action.onSelect}
                    />
                  ))}
                </CommandList>
              </Command>
            </div>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

interface GitPushDialogProps {
  open: boolean;
  gitSummary: GitRepositorySummary;
  currentBranchLabel: string;
  pushEnabled: boolean;
  error: string | null;
  mutationPending: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  onSubmit: () => void;
}

function GitPushDialog({
  open,
  gitSummary,
  currentBranchLabel,
  pushEnabled,
  error,
  mutationPending,
  onOpenChange,
  onSubmit,
}: GitPushDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const numberFormatter = new Intl.NumberFormat(locale);
  const [errorCopied, setErrorCopied] = useState(false);
  const descriptionId = gitSummary.trackingBranchName
    ? "git.actionMenu.pushDialog.description.tracked"
    : "git.actionMenu.pushDialog.description.untracked";

  const handleCopyError = useCallback(() => {
    if (!error) {
      return;
    }

    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(
        intl.formatMessage(
          { id: "git.actionMenu.pushDialog.error.copyFailed" },
          { error: "clipboard-unavailable" },
        ),
      );
      return;
    }

    void navigator.clipboard.writeText(error).then(
      () => {
        setErrorCopied(true);
        window.setTimeout(() => {
          setErrorCopied(false);
        }, 1500);
      },
      (copyError: unknown) => {
        const message = copyError instanceof Error ? copyError.message : String(copyError);
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.pushDialog.error.copyFailed" },
            { error: message },
          ),
        );
      },
    );
  }, [error, intl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 rounded-2xl p-0 overflow-hidden">
        <DialogHeader className="gap-2 px-6 py-5 pb-0">
          <DialogTitle className="text-lg font-medium text-foreground">
            {intl.formatMessage({ id: "git.actionMenu.pushDialog.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: descriptionId })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-6 py-6">
          {!error && (
            <div className="rounded-xl bg-background/30">
              <div className="flex items-start justify-between p-4">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({
                    id: "git.actionMenu.pushDialog.currentBranchLabel",
                  })}
                </div>
                <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
                  <GitBranchIcon className="size-4 text-foreground-subtle" />
                  <span>{currentBranchLabel}</span>
                </div>
              </div>

              <div className="space-y-3 border-t border-border/50 p-4 text-ui-base">
                <div className="flex items-center justify-between gap-4">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.upstreamLabel",
                    })}
                  </div>
                  <div className="text-foreground-subtle">
                    {gitSummary.trackingBranchName
                      ? gitSummary.trackingBranchName
                      : intl.formatMessage({
                          id: "git.actionMenu.pushDialog.upstreamPending",
                        })}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.aheadBehindLabel",
                    })}
                  </div>
                  <div className="text-foreground-subtle">
                    {intl.formatMessage(
                      {
                        id: "git.actionMenu.pushDialog.aheadBehindValue",
                      },
                      {
                        ahead: numberFormatter.format(gitSummary.ahead),
                        behind: numberFormatter.format(gitSummary.behind),
                      },
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-4 border-t border-border/50 pt-3">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.pushLabel",
                    })}
                  </div>
                  <div className="flex items-center gap-2 text-foreground-subtle">
                    <ArrowUpFromLine className="size-4" />
                    <span>
                      {intl.formatMessage({
                        id: "git.actionMenu.pushDialog.pushValue",
                      })}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {!pushEnabled ? (
            <div className="flex items-start gap-3 rounded-xl bg-warning/10 px-4 py-3 text-ui-base text-warning">
              <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
              <span>
                {intl.formatMessage({
                  id: "git.actionMenu.pushDialog.upToDate",
                })}
              </span>
            </div>
          ) : null}

          {error ? (
            <>
              <div className="flex items-start gap-3 rounded-xl bg-warning/10 px-4 py-3 text-ui-base text-warning">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                <span>
                  {intl.formatMessage({
                    id: "git.actionMenu.pushDialog.error.summary",
                  })}
                </span>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pushDialog.error.detailsLabel",
                    })}
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-ui-base text-foreground-subtle hover:text-foreground"
                    onClick={handleCopyError}
                  >
                    {intl.formatMessage({
                      id: errorCopied
                        ? "git.actionMenu.pushDialog.error.copy.copied"
                        : "git.actionMenu.pushDialog.error.copy",
                    })}
                  </Button>
                </div>
                <Textarea
                  // Textarea 默认带 field-sizing-content，长错误文本会按内容扩张并把弹窗横向撑爆。
                  // 这里改成固定尺寸模式，并允许长内容换行，保证错误详情始终被限制在弹窗宽度内。
                  className="field-sizing-fixed w-full max-w-full min-h-56 rounded-lg border-input-border bg-background/50 px-3 py-3 text-ui-base text-foreground whitespace-pre-wrap break-words placeholder:text-foreground-subtlest focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 md:text-ui-base"
                  readOnly
                >
                  {error}
                </Textarea>
              </div>
            </>
          ) : null}

          <DialogFooter className="gap-2 pt-4">
            {error ? (
              <Button
                type="button"
                size="lg"
                onClick={() => onOpenChange(false)}
                disabled={mutationPending}
                className="h-10 min-w-0 px-5"
              >
                {intl.formatMessage({ id: "common.close" })}
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="secondary"
                  size="lg"
                  onClick={() => onOpenChange(false)}
                  disabled={mutationPending}
                  className="h-10 min-w-0 px-5"
                >
                  {intl.formatMessage({ id: "common.cancel" })}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  onClick={onSubmit}
                  disabled={mutationPending || !pushEnabled}
                  className="h-10 min-w-0 px-5"
                >
                  {mutationPending ? <LoaderIcon className="size-4 animate-spin" /> : null}
                  {intl.formatMessage({
                    id: "git.actionMenu.pushDialog.confirm",
                  })}
                </Button>
              </>
            )}
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function GitActionMenu({
  workspacePath,
  workspaceIdentity,
  gitSummary,
  activeTaskChangeSummary = null,
  commitMessageConversationContext = null,
  commitMessageModelSelection = null,
  onRefreshGit,
  className,
  triggerIconOnly = false,
  triggerLayout = "header",
}: GitActionMenuProps) {
  const { gitService } = useServices();
  const { intl, locale } = useZCodeIntl();
  const { settings } = useSettings();
  const [commitDialogOpen, setCommitDialogOpen] = useState(false);
  const [commitDialogLoading, setCommitDialogLoading] = useState(false);
  const [commitDialogState, setCommitDialogState] = useState<GitCommitDialogState | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitIncludeUnstaged, setCommitIncludeUnstaged] = useState(true);
  const [commitMessageGenerationPending, setCommitMessageGenerationPending] = useState(false);
  const [pushDialogOpen, setPushDialogOpen] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  // 本次提交不包含的文件。弹窗会话内的临时状态，不作为持久化偏好。
  const [commitExcludedStagePaths, setCommitExcludedStagePaths] = useState<ReadonlySet<string>>(
    EMPTY_COMMIT_EXCLUDED_PATHS,
  );

  const clearCommitExcludedStagePaths = useCallback(() => {
    setCommitExcludedStagePaths(EMPTY_COMMIT_EXCLUDED_PATHS);
  }, []);

  const toggleCommitFileSelection = useCallback((stagePath: string) => {
    setCommitExcludedStagePaths((current) => {
      const next = new Set(current);
      if (next.has(stagePath)) {
        next.delete(stagePath);
      } else {
        next.add(stagePath);
      }
      return next;
    });
  }, []);

  const actionAvailable = canUseGitActionMenu(gitSummary);
  const currentBranchLabel = useMemo(
    () =>
      resolveGitBranchTriggerLabel({
        headRefType: gitSummary.headRefType,
        currentBranchName: gitSummary.branchName,
        detachedLabel: intl.formatMessage({ id: "git.head.detached" }),
        fallbackLabel: intl.formatMessage({ id: "git.branchSwitcher.label" }),
      }),
    [gitSummary.branchName, gitSummary.headRefType, intl],
  );
  const commitEnabled = gitSummary.isDirty;
  const pushEnabled = canPushGitBranch(gitSummary);
  const triggerPending = mutationPending || commitMessageGenerationPending || commitDialogLoading;
  const primaryActionId = useMemo(
    () =>
      resolveGitActionMenuPrimaryAction({
        actionAvailable,
        commitEnabled,
        pushEnabled,
      }),
    [actionAvailable, commitEnabled, pushEnabled],
  );
  const primaryActionDisabled = !actionAvailable || triggerPending || primaryActionId === null;
  const isStatusRowTrigger = triggerLayout === "status-row";

  useEffect(() => {
    // 顶部 commit 入口改成“始终展示、异常时置灰”后，
    // 这里记录低频可用性日志，方便继续区分是仓库探测失败，
    // 还是 UI 交互本身出现了禁用/启用状态不一致。
    logger.info("[GitActionMenu] 顶部 Git 操作入口可用性变化", {
      workspacePath,
      available: actionAvailable,
      primaryActionDisabled,
      primaryActionId,
      isGitAvailable: gitSummary.isGitAvailable,
      isRepository: gitSummary.isRepository,
      headRefType: gitSummary.headRefType,
      branchName: gitSummary.branchName,
      trackingBranchName: gitSummary.trackingBranchName,
      isDirty: gitSummary.isDirty,
    });
  }, [
    gitSummary.branchName,
    gitSummary.headRefType,
    gitSummary.isDirty,
    gitSummary.isGitAvailable,
    gitSummary.isRepository,
    gitSummary.trackingBranchName,
    actionAvailable,
    primaryActionId,
    primaryActionDisabled,
    workspacePath,
  ]);

  const closeCommitDialog = useCallback(() => {
    setCommitDialogOpen(false);
    setCommitDialogLoading(false);
    setCommitDialogState(null);
    setCommitMessage("");
    setCommitError(null);
    setCommitIncludeUnstaged(true);
    setCommitMessageGenerationPending(false);
    clearCommitExcludedStagePaths();
  }, [clearCommitExcludedStagePaths]);

  const handleCommitIncludeUnstagedChange = useCallback(
    (nextValue: boolean) => {
      setCommitIncludeUnstaged(nextValue);
      // 切换范围后可勾选集合本身变了，沿用旧的排除项会让"取消勾选"以难以预期的方式延续到新集合。
      clearCommitExcludedStagePaths();
    },
    [clearCommitExcludedStagePaths],
  );

  const setAllCommitFilesSelected = useCallback(
    (selected: boolean) => {
      if (selected || !commitDialogState) {
        clearCommitExcludedStagePaths();
        return;
      }

      setCommitExcludedStagePaths(
        new Set(getCommitDialogStagePaths(commitDialogState, commitIncludeUnstaged)),
      );
    },
    [clearCommitExcludedStagePaths, commitDialogState, commitIncludeUnstaged],
  );

  const closePushDialog = useCallback(() => {
    setPushDialogOpen(false);
    setPushError(null);
  }, []);

  const openPushDialog = useCallback(() => {
    setPushError(null);
    setPushDialogOpen(true);
  }, []);

  const loadCommitDialogState = useCallback(
    async (options?: { resetMessage?: boolean }) => {
      setCommitDialogLoading(true);
      setCommitError(null);
      if (options?.resetMessage) {
        setCommitMessage("");
      }

      try {
        const refreshResult = await gitService.refresh({
          workspacePath,
          includeIdentity: true,
        });
        const rawUnstagedFiles = buildGitBranchCommitPreviewFiles(refreshResult.unstagedChanges);
        const rawStagedFiles = buildGitBranchCommitPreviewFiles(refreshResult.stagedChanges);
        const unstagedFiles = filterCommitPreviewFilesByCurrentSession({
          files: rawUnstagedFiles,
          summary: activeTaskChangeSummary,
          gitSummary: refreshResult.summary,
          workspacePath,
        });
        const stagedFiles = filterCommitPreviewFilesByCurrentSession({
          files: rawStagedFiles,
          summary: activeTaskChangeSummary,
          gitSummary: refreshResult.summary,
          workspacePath,
        });
        setCommitDialogState({
          summary: refreshResult.summary,
          activeTaskChangeSummary,
          identity: refreshResult.identity,
          stagedFiles,
          unstagedFiles,
        });
        setCommitIncludeUnstaged(unstagedFiles.length > 0);
        // 重新拉取后文件集合可能已变化（打开弹窗、切换分支刷新），旧的排除项不再对应同一批文件。
        clearCommitExcludedStagePaths();
        setCommitDialogLoading(false);
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitActionMenu] 读取提交弹窗状态失败", {
          workspacePath,
          error: message,
        });
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.commitDialog.error.requestFailed" },
            { error: message },
          ),
        );
        closeCommitDialog();
      }
    },
    [
      activeTaskChangeSummary,
      clearCommitExcludedStagePaths,
      closeCommitDialog,
      gitService,
      intl,
      workspacePath,
    ],
  );

  const openCommitDialog = useCallback(async () => {
    setCommitDialogOpen(true);
    setCommitDialogState(null);
    setCommitMessage("");
    setCommitError(null);
    setCommitIncludeUnstaged(true);
    await loadCommitDialogState({ resetMessage: true });
  }, [loadCommitDialogState]);

  const refreshCommitDialogAfterBranchChange = useCallback(() => {
    onRefreshGit();
    void loadCommitDialogState({ resetMessage: true });
  }, [loadCommitDialogState, onRefreshGit]);

  /**
   * 提交消息用哪个模型：设置里指定了固定模型就用它，否则跟随当前会话的模型，都没有才交给
   * 服务层退回 Host 的 preferredSelection。只有这一处读这两个事实源，服务层不再自行选模型。
   */
  const resolveCommitMessageSelection = useCallback((): {
    selection: ModelSelection | null;
    source: "configured" | "session" | "host-default";
  } => {
    const configured = settings?.gitCommitMessageModelSelection ?? null;
    if (configured) {
      return { selection: configured, source: "configured" };
    }
    if (commitMessageModelSelection) {
      return { selection: commitMessageModelSelection, source: "session" };
    }
    return { selection: null, source: "host-default" };
  }, [commitMessageModelSelection, settings]);

  const generateCommitMessage = useCallback(
    async (
      state: GitCommitDialogState,
      includeUnstaged: boolean,
      excludedPaths: ReadonlySet<string>,
    ): Promise<string> => {
      const files = getCommitDialogSelectedFiles(state, includeUnstaged, excludedPaths);
      const currentSessionFilePaths = getCurrentSessionFilePaths(state.activeTaskChangeSummary);
      const { selection: modelSelection, source: selectionSource } =
        resolveCommitMessageSelection();
      logger.info("[GitActionMenu] 开始生成提交消息", {
        workspacePath,
        branchName: gitSummary.branchName,
        selectedFileCount: files.length,
        excludedFileCount: excludedPaths.size,
        currentSessionFileCount: currentSessionFilePaths?.length ?? 0,
        includeUnstaged,
        conversationMessageCount: commitMessageConversationContext?.messages.length ?? 0,
        selectionSource,
        modelSelection: modelSelection
          ? `${modelSelection.providerId}/${modelSelection.modelId}`
          : null,
      });

      const result = await gitService.generateCommitMessage({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        locale,
        includeUnstaged,
        // 消息必须只描述实际提交的文件，否则会写出并未提交的改动。
        ...(excludedPaths.size > 0 ? { excludePaths: Array.from(excludedPaths) } : {}),
        ...(currentSessionFilePaths ? { currentSessionFilePaths } : {}),
        ...(modelSelection ? { selection: modelSelection } : {}),
        ...(commitMessageConversationContext
          ? { conversationContext: commitMessageConversationContext }
          : {}),
      });

      logger.info("[GitActionMenu] 提交消息生成成功", {
        workspacePath,
        branchName: gitSummary.branchName,
        providerId: result.providerId,
        model: result.model,
      });
      return result.message;
    },
    [
      commitMessageConversationContext,
      gitService,
      gitSummary.branchName,
      locale,
      resolveCommitMessageSelection,
      workspaceIdentity,
      workspacePath,
    ],
  );

  const handleGenerateCommitMessage = useCallback(async () => {
    if (!commitDialogState) {
      return;
    }

    const stagePaths = getCommitDialogStagePaths(
      commitDialogState,
      commitIncludeUnstaged,
      commitExcludedStagePaths,
    );
    if (stagePaths.length === 0) {
      setCommitError(
        intl.formatMessage({
          id: "git.actionMenu.commitDialog.error.noChanges",
        }),
      );
      return;
    }

    setCommitError(null);
    setCommitMessageGenerationPending(true);

    try {
      const nextCommitMessage = await generateCommitMessage(
        commitDialogState,
        commitIncludeUnstaged,
        commitExcludedStagePaths,
      );
      setCommitMessage(nextCommitMessage);
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitActionMenu] 生成提交消息失败", {
        workspacePath,
        branchName: gitSummary.branchName,
        error: message,
      });
      setCommitError(
        intl.formatMessage({
          id: "git.actionMenu.commitDialog.error.generateFailed",
        }),
      );
    } finally {
      setCommitMessageGenerationPending(false);
    }
  }, [
    commitExcludedStagePaths,
    commitIncludeUnstaged,
    commitDialogState,
    generateCommitMessage,
    gitSummary.branchName,
    intl,
    workspacePath,
  ]);

  const pushCurrentBranch = useCallback(
    async (options?: { showToast?: boolean }) => {
      const result = await gitService.push({ workspacePath });
      logger.info("[GitActionMenu] 推送更改成功", {
        workspacePath,
        branchName: result.branchName,
        trackingBranchName: result.trackingBranchName,
        remoteName: result.remoteName,
        setUpstream: result.setUpstream,
      });
      if (options?.showToast !== false) {
        toast(
          intl.formatMessage(
            { id: "git.actionMenu.pushDialog.toast.success" },
            {
              target:
                result.trackingBranchName?.trim() ||
                result.branchName?.trim() ||
                currentBranchLabel,
            },
          ),
        );
      }
      return result;
    },
    [currentBranchLabel, gitService, intl, workspacePath],
  );

  const handleCommitAction = useCallback(
    async (options?: { pushAfterCommit?: boolean }) => {
      if (!commitDialogState) {
        return;
      }

      if (!hasGitCommitIdentity(commitDialogState.identity)) {
        setCommitError(
          intl.formatMessage({
            id: "git.actionMenu.commitDialog.identityMissing",
          }),
        );
        return;
      }

      const includeUnstaged = commitIncludeUnstaged;
      const stagePaths = getCommitDialogStagePaths(
        commitDialogState,
        includeUnstaged,
        commitExcludedStagePaths,
      );
      const pathsToStage = includeUnstaged ? stagePaths : [];
      if (stagePaths.length === 0) {
        setCommitError(
          intl.formatMessage({
            id: "git.actionMenu.commitDialog.error.noChanges",
          }),
        );
        return;
      }

      let nextCommitMessage = commitMessage.trim();
      if (!nextCommitMessage) {
        setCommitError(null);
        setCommitMessageGenerationPending(true);
        try {
          nextCommitMessage = await generateCommitMessage(
            commitDialogState,
            includeUnstaged,
            commitExcludedStagePaths,
          );
          setCommitMessage(nextCommitMessage);
        } catch (error: unknown) {
          const message = getErrorMessage(error);
          logger.warn("[GitActionMenu] 生成提交消息失败", {
            workspacePath,
            branchName: gitSummary.branchName,
            error: message,
          });
          setCommitError(
            intl.formatMessage({
              id: "git.actionMenu.commitDialog.error.generateFailed",
            }),
          );
          return;
        } finally {
          setCommitMessageGenerationPending(false);
        }
      }

      setCommitError(null);
      setMutationPending(true);
      let committed = false;

      try {
        logger.info("[GitActionMenu] 开始提交当前更改", {
          workspacePath,
          branchName: gitSummary.branchName,
          selectedPathCount: stagePaths.length,
          excludedPathCount: commitExcludedStagePaths.size,
          stagedPathCount: pathsToStage.length,
          includeUnstaged,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        if (pathsToStage.length > 0) {
          await gitService.stagePaths({
            workspacePath,
            paths: pathsToStage,
          });
        }
        await gitService.commit({
          workspacePath,
          message: nextCommitMessage,
          paths: stagePaths,
          stagedOnly: !includeUnstaged,
        });
        committed = true;

        if (options?.pushAfterCommit) {
          await pushCurrentBranch({ showToast: false });
        }

        logger.info("[GitActionMenu] 提交当前更改成功", {
          workspacePath,
          branchName: gitSummary.branchName,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        toast(
          intl.formatMessage({
            id: options?.pushAfterCommit
              ? "git.actionMenu.commitDialog.toast.commitAndPushSuccess"
              : "git.actionMenu.commitDialog.toast.success",
          }),
        );
        closeCommitDialog();
        onRefreshGit();
      } catch (error: unknown) {
        const message = getErrorMessage(error);
        logger.warn("[GitActionMenu] 提交当前更改失败", {
          workspacePath,
          error: message,
          committed,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        setCommitError(
          intl.formatMessage(
            {
              id:
                committed && options?.pushAfterCommit
                  ? "git.actionMenu.commitDialog.error.pushAfterCommitFailed"
                  : "git.actionMenu.commitDialog.error.requestFailed",
            },
            { error: message },
          ),
        );
        if (committed) {
          onRefreshGit();
        }
      } finally {
        setMutationPending(false);
      }
    },
    [
      closeCommitDialog,
      commitExcludedStagePaths,
      commitIncludeUnstaged,
      commitDialogState,
      commitMessage,
      generateCommitMessage,
      gitService,
      gitSummary.branchName,
      intl,
      onRefreshGit,
      pushCurrentBranch,
      workspacePath,
    ],
  );

  const handleCommitSubmit = useCallback(async () => {
    await handleCommitAction();
  }, [handleCommitAction]);

  const handleCommitAndPushSubmit = useCallback(async () => {
    await handleCommitAction({ pushAfterCommit: true });
  }, [handleCommitAction]);

  const handlePushSubmit = useCallback(async () => {
    if (!pushEnabled) {
      return;
    }

    setMutationPending(true);
    setPushError(null);

    try {
      await pushCurrentBranch();
      closePushDialog();
      onRefreshGit();
    } catch (error: unknown) {
      const message = getErrorMessage(error);
      logger.warn("[GitActionMenu] 推送更改失败", {
        workspacePath,
        error: message,
      });
      setPushError(
        intl.formatMessage(
          { id: "git.actionMenu.pushDialog.error.requestFailed" },
          { error: message },
        ),
      );
    } finally {
      setMutationPending(false);
    }
  }, [closePushDialog, intl, onRefreshGit, pushCurrentBranch, pushEnabled, workspacePath]);

  const handlePrimaryAction = useCallback(() => {
    if (primaryActionDisabled) {
      return;
    }

    runUserAction({
      input: { featureId: "workbench.git", action: "open", trigger: "button" },
      operation: () => {
        if (primaryActionId === "push") {
          openPushDialog();
          return;
        }
        void openCommitDialog();
      },
      completed: { resultSource: "local_commit" },
      failureStage: "git_action_open",
    });
  }, [openCommitDialog, openPushDialog, primaryActionId, primaryActionDisabled]);

  const handleStatusRowContainerClick = useCallback(() => {
    handlePrimaryAction();
  }, [handlePrimaryAction]);

  return (
    <>
      <div
        onClick={isStatusRowTrigger && !triggerIconOnly ? handleStatusRowContainerClick : undefined}
        className={cn(
          // macOS/Windows 小窗口下，顶部 Git 主按钮的中文文案会和分支入口、窗口控制区挤在同一行。
          // 在 header 容器变窄时只隐藏主按钮文字，保留图标入口，避免丢失核心 Git 操作。
          // transition-all 会把 scrollbar-color 等非合成属性也启动动画，
          // 进而触发整页 UpdateLayoutTree；Git 入口只需要颜色反馈，不动画尺寸和滚动条属性。
          "flex h-7 items-center overflow-hidden rounded-lg border border-border bg-input transition-colors hover:border-border-hover @max-[560px]/workspace-header:w-7 @max-[560px]/workspace-header:justify-center",
          triggerIconOnly && "w-7 justify-center",
          isStatusRowTrigger &&
            "h-8 w-full justify-start rounded-lg border-0 bg-transparent hover:border-transparent hover:bg-hover @max-[560px]/workspace-header:w-full @max-[560px]/workspace-header:justify-start",
          className,
        )}
      >
        <Button
          data-testid={TID_GIT_ACTION_TRIGGER}
          type="button"
          variant="ghost"
          size="default"
          disabled={primaryActionDisabled}
          aria-label={intl.formatMessage({
            id: "git.actionMenu.trigger.ariaLabel",
          })}
          className={cn(
            "h-7 rounded-lg border-0 gap-1 px-1.5 @max-[560px]/workspace-header:w-7 @max-[560px]/workspace-header:px-0 @max-[560px]/workspace-header:[&>span]:hidden",
            triggerIconOnly && "w-7 px-0 [&>span]:hidden",
            isStatusRowTrigger &&
              "h-8 min-w-0 w-full justify-start gap-2 px-2 text-left text-ui-base hover:bg-transparent hover:text-foreground @max-[560px]/workspace-header:w-auto @max-[560px]/workspace-header:[&>span]:inline",
          )}
          onClick={isStatusRowTrigger && !triggerIconOnly ? undefined : handlePrimaryAction}
        >
          {/* 主按钮进入 pending 时直接替换左侧动作图标，避免在紧凑头部里额外追加 loading 图标把按钮挤宽。*/}
          {triggerPending ? (
            <LoaderIcon className="size-4 animate-spin text-foreground-subtle" />
          ) : primaryActionId === "push" ? (
            <ArrowUpFromLine className="size-4 text-foreground" />
          ) : (
            <GitCommitIcon className="size-4 text-foreground" />
          )}
          <span className={cn(isStatusRowTrigger && "min-w-0 truncate")}>
            {intl.formatMessage({ id: "git.actionMenu.trigger" })}
          </span>
        </Button>
      </div>

      <GitCommitDialog
        open={commitDialogOpen}
        loading={commitDialogLoading}
        state={commitDialogState}
        workspacePath={workspacePath}
        message={commitMessage}
        error={commitError}
        mutationPending={mutationPending}
        generationPending={commitMessageGenerationPending}
        includeUnstaged={commitIncludeUnstaged}
        excludedStagePaths={commitExcludedStagePaths}
        pushEnabled={pushEnabled}
        onRefreshGit={refreshCommitDialogAfterBranchChange}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closeCommitDialog();
          }
        }}
        onMessageChange={setCommitMessage}
        onIncludeUnstagedChange={handleCommitIncludeUnstagedChange}
        onToggleFileSelection={toggleCommitFileSelection}
        onSetAllFilesSelected={setAllCommitFilesSelected}
        onGenerateMessage={() => {
          void handleGenerateCommitMessage();
        }}
        onSubmit={() => {
          void handleCommitSubmit();
        }}
        onSubmitAndPush={() => {
          void handleCommitAndPushSubmit();
        }}
        onPushOnly={() => {
          closeCommitDialog();
          openPushDialog();
        }}
      />

      <GitPushDialog
        open={pushDialogOpen}
        gitSummary={gitSummary}
        currentBranchLabel={currentBranchLabel}
        pushEnabled={pushEnabled}
        error={pushError}
        mutationPending={mutationPending}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closePushDialog();
          }
        }}
        onSubmit={() => {
          void handlePushSubmit();
        }}
      />
    </>
  );
}
