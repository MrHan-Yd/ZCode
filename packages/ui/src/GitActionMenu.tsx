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
import {
  type GitCommitMessageConversationContext,
  type GitIdentity,
  type GitRepositorySummary,
  type ModelSelection,
  type ZCodeTaskChangeSummary,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Command, CommandItem, CommandList, CommandShortcut } from "@/components/ui/command.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
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
  buildCommitFileRows,
  canUseGitActionMenu,
  canPushGitBranch,
  collectCommitPreviewStagePaths,
  excludeCommitPreviewFiles,
  groupCommitFileRows,
  resolveCommitPreviewSelectionState,
  resolveCommitRequestMode,
  resolveGitActionMenuPrimaryAction,
  shouldShowCommitFileList,
  splitCommitPreviewFilePath,
  type GitCommitFileGroupId,
  type GitCommitFileRow,
} from "@/git-action-menu/display.js";
import {
  filterCommitPreviewFilesByCurrentSession,
  getCurrentSessionFilePaths,
} from "@/git-action-menu/currentSessionFileScope.js";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";
import { formatCommandShortcutLabel, matchesPrimaryShortcut } from "@/lib/keyboardShortcuts.js";
import { logger } from "@/logger.js";
import {
  AlertCircleIcon,
  ArrowUpFromLine,
  ChevronDownIcon,
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
const TID_GIT_COMMIT_FILE_GROUP = "git-commit-file-group";
const TID_GIT_COMMIT_FILE_GROUP_SELECT_ALL = "git-commit-file-group-select-all";
const TID_GIT_COMMIT_FILE_GROUP_TOGGLE = "git-commit-file-group-toggle";
const TID_GIT_COMMIT_FILE_LIST = "git-commit-file-list";
const TID_GIT_COMMIT_GENERATE_BUTTON = "git-commit-generate-button";
const TID_GIT_COMMIT_MESSAGE_INPUT = "git-commit-message-input";
const TID_GIT_COMMIT_SELECT_ALL = "git-commit-select-all";

/** 默认排除集合。始终作为不可变值使用：所有写入路径都构造新 Set，不会就地修改它。 */
const EMPTY_COMMIT_EXCLUDED_PATHS: ReadonlySet<string> = new Set<string>();

/** 默认折叠集合：空集表示全部展开。同样只作为不可变值使用。 */
const EMPTY_COMMIT_COLLAPSED_FILE_GROUPS: ReadonlySet<GitCommitFileGroupId> = new Set<
  GitCommitFileGroupId
>();

type CommitDialogActionId = (typeof COMMIT_DIALOG_ACTION_IDS)[number];

function gitCommitActionItemTestId(actionId: CommitDialogActionId): string {
  return `${TID_GIT_COMMIT_ACTION_ITEM}-${actionId}`;
}

/** 分组 id 到文案 key。分组标题与 a11y 文案共用同一处映射，避免两处各写一份 switch。 */
const COMMIT_FILE_GROUP_LABEL_IDS: Record<GitCommitFileGroupId, string> = {
  staged: "git.actionMenu.commitDialog.fileList.group.staged",
  changes: "git.actionMenu.commitDialog.fileList.group.changes",
  untracked: "git.actionMenu.commitDialog.fileList.group.untracked",
};

/**
 * 清单计数文案：全部选中时只显示总数，部分选中时显示「已选/总数」。
 * 整体「全选」行与各分组行共用同一口径，用户不必为两种行分别解读计数含义。
 */
function formatCommitFileCountLabel(options: {
  intl: IntlInstance;
  numberFormatter: Intl.NumberFormat;
  selectedCount: number;
  totalCount: number;
  allSelected: boolean;
}): string {
  if (options.allSelected) {
    return options.intl.formatMessage(
      { id: "git.actionMenu.commitDialog.changesValue" },
      { count: options.numberFormatter.format(options.totalCount) },
    );
  }

  return options.intl.formatMessage(
    { id: "git.actionMenu.commitDialog.changesValueSelected" },
    {
      selected: options.numberFormatter.format(options.selectedCount),
      total: options.numberFormatter.format(options.totalCount),
    },
  );
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
  /** 本次不参与提交的文件（key 为 `stagePath`）；空集表示全部提交。 */
  excludedStagePaths: ReadonlySet<string>;
  pushEnabled: boolean;
  onRefreshGit: () => void;
  onOpenChange: (nextOpen: boolean) => void;
  onMessageChange: (nextValue: string) => void;
  onToggleFileSelection: (stagePath: string) => void;
  onSetAllFilesSelected: (selected: boolean) => void;
  /** 按 stagePath 批量勾选 / 取消勾选，用于分组行的组级全选。 */
  onSetFilesSelected: (stagePaths: readonly string[], selected: boolean) => void;
  onGenerateMessage: () => void;
  onSubmit: () => void;
  onSubmitAndPush: () => void;
  onPushOnly: () => void;
}

/**
 * 弹窗可勾选的行：由两份 per-source 预览按归属规则合成，一行一路径。
 * 归属互斥（同一文件不占两行）由 `buildCommitFileRows` 保证，勾选结果才能原样映射回
 * `GitCommitRequest.paths`。
 */
function getCommitDialogRows(state: GitCommitDialogState): GitCommitFileRow[] {
  return buildCommitFileRows({
    stagedFiles: state.stagedFiles,
    unstagedFiles: state.unstagedFiles,
  });
}

function getCommitDialogSelectedRows(
  state: GitCommitDialogState,
  excludedPaths: ReadonlySet<string>,
): GitCommitFileRow[] {
  return excludeCommitPreviewFiles(getCommitDialogRows(state), excludedPaths);
}

function getCommitDialogStagePaths(
  state: GitCommitDialogState,
  excludedPaths: ReadonlySet<string> = EMPTY_COMMIT_EXCLUDED_PATHS,
): string[] {
  return collectCommitPreviewStagePaths(getCommitDialogSelectedRows(state, excludedPaths));
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

function commitSelectionCheckboxValue(
  state: "all" | "partial" | "none",
): boolean | "indeterminate" {
  if (state === "all") {
    return true;
  }
  return state === "partial" ? "indeterminate" : false;
}

function CommitFileRow({
  file,
  selected,
  disabled,
  numberFormatter,
  remainderLabel,
  onToggle,
}: {
  file: GitCommitFileRow;
  selected: boolean;
  disabled: boolean;
  numberFormatter: Intl.NumberFormat;
  /** `hasUnstagedRemainder` 行的提示文案；为空表示不需要提示。 */
  remainderLabel: string | null;
  onToggle: (stagePath: string) => void;
}) {
  const { directory, fileName } = splitCommitPreviewFilePath(file.repoRelativePath);
  return (
    <label
      data-testid={`${TID_GIT_COMMIT_FILE_ITEM}-${file.repoRelativePath}`}
      // pl-8 与分组行的复选框左边缘对齐（4px 行首 + 20px 折叠箭头 + 8px 间距）。
      className="flex h-7 cursor-pointer items-center gap-2 rounded-md pr-2 pl-8 hover:bg-menu-hover"
      title={file.repoRelativePath}
    >
      <Checkbox
        checked={selected}
        disabled={disabled}
        onCheckedChange={() => {
          onToggle(file.stagePath);
        }}
      />
      {/* 目录先截断，文件名优先保留：同名文件靠文件名区分。
          目录只收缩不伸展（不能给 flex-1，否则短目录会把文件名挤到行尾）；
          文件名 shrink-0 + max-w-full，只在自身就超出整行时才截断。 */}
      <span className="flex min-w-0 flex-1 items-center gap-1 font-mono text-ui-base">
        {directory ? (
          <span className="min-w-0 truncate text-foreground-subtlest">{directory}/</span>
        ) : null}
        <span
          className={cn(
            "max-w-full shrink-0 truncate",
            selected ? "text-foreground" : "text-foreground-subtle",
          )}
        >
          {fileName}
        </span>
      </span>
      {/* 说明这行为什么只显示索引里的行数：它工作区还有未暂存的改动，本次不提交。
          纯文字提示不是第二个勾选框——同一路径不能占两行。 */}
      {remainderLabel ? (
        <span className="shrink-0 truncate text-ui-sm text-foreground-subtlest">
          {remainderLabel}
        </span>
      ) : null}
      <span className="shrink-0 font-mono text-ui-base">
        <span className="text-diff-added">+{numberFormatter.format(file.added)}</span>{" "}
        <span className="text-diff-removed">-{numberFormatter.format(file.removed)}</span>
      </span>
    </label>
  );
}

/**
 * 分组标题行：折叠箭头 + 组级三态复选框 + 组名 + 组计数。
 *
 * 箭头是 CollapsibleTrigger，与包着 Checkbox 的 label 是兄弟节点：点箭头只折叠，点复选框只改勾选，
 * 两者不能互相嵌套，否则一次点击会同时触发折叠与整组勾选。
 */
function CommitFileGroupHeader({
  groupId,
  label,
  selectionState,
  countLabel,
  collapsed,
  disabled,
  selectAllLabel,
  toggleLabel,
  onSetSelected,
}: {
  groupId: GitCommitFileGroupId;
  label: string;
  selectionState: "all" | "partial" | "none";
  countLabel: string;
  collapsed: boolean;
  disabled: boolean;
  selectAllLabel: string;
  toggleLabel: string;
  onSetSelected: (groupId: GitCommitFileGroupId, selected: boolean) => void;
}) {
  return (
    <div className="flex h-7 items-center gap-2 rounded-md pr-2 pl-1 text-ui-base hover:bg-menu-hover">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          data-testid={`${TID_GIT_COMMIT_FILE_GROUP_TOGGLE}-${groupId}`}
          aria-label={toggleLabel}
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-foreground-subtlest transition-colors hover:text-foreground"
        >
          {/* 与 CollapsibleContent 的 300ms 高度动画同节奏，箭头和面板看起来是同一次手势。 */}
          <ChevronDownIcon
            className={cn(
              "size-4 transition-transform duration-300 ease-in-out",
              collapsed && "-rotate-90",
            )}
          />
        </button>
      </CollapsibleTrigger>
      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
        <Checkbox
          data-testid={`${TID_GIT_COMMIT_FILE_GROUP_SELECT_ALL}-${groupId}`}
          checked={commitSelectionCheckboxValue(selectionState)}
          disabled={disabled}
          onCheckedChange={(nextChecked) => {
            onSetSelected(groupId, nextChecked === true);
          }}
          aria-label={selectAllLabel}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground-subtle">{label}</span>
        <span className="shrink-0 font-normal text-foreground-subtlest">{countLabel}</span>
      </label>
    </div>
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
  excludedStagePaths,
  pushEnabled,
  onRefreshGit,
  onOpenChange,
  onMessageChange,
  onToggleFileSelection,
  onSetAllFilesSelected,
  onSetFilesSelected,
  onGenerateMessage,
  onSubmit,
  onSubmitAndPush,
  onPushOnly,
}: GitCommitDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const [selectedActionId, setSelectedActionId] = useState<CommitDialogActionId>("commit");
  // 折叠是纯展示状态：只决定分组下的文件行渲不渲染，不参与勾选与提交范围计算。
  const [collapsedGroupIds, setCollapsedGroupIds] = useState<ReadonlySet<GitCommitFileGroupId>>(
    EMPTY_COMMIT_COLLAPSED_FILE_GROUPS,
  );
  const messageTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messageInputFocusedOnOpenRef = useRef(false);
  const numberFormatter = new Intl.NumberFormat(locale);
  const hasIdentity = hasGitCommitIdentity(state?.identity ?? null);
  const messageReady = message.trim().length > 0;
  const actionPending = mutationPending || generationPending;
  const selectableRows = state ? getCommitDialogRows(state) : [];
  const selectedRows = state ? getCommitDialogSelectedRows(state, excludedStagePaths) : [];
  const stagePaths = collectCommitPreviewStagePaths(selectedRows);
  const dirtyFileCount = selectableRows.length;
  const { totalAdded, totalRemoved } = getGitBranchCommitTotals(selectedRows);
  const selectionState = resolveCommitPreviewSelectionState(selectableRows, excludedStagePaths);
  // 分组只是 selectableRows 的派生视图：勾选、计数、stagePaths 仍以整表为准。
  const selectableFileGroups = groupCommitFileRows(selectableRows);
  const unstagedRemainderLabel = intl.formatMessage({
    id: "git.actionMenu.commitDialog.fileList.group.staged.unstagedRemainder",
  });
  const displayChangeSummary = state?.activeTaskChangeSummary ?? null;
  const displayAdded = displayChangeSummary?.added ?? totalAdded;
  const displayRemoved = displayChangeSummary?.removed ?? totalRemoved;
  const hasSelectedChanges = stagePaths.length > 0;
  // 清单是唯一展示待提交文件路径的地方：只要还有可提交文件就必须渲染，只有 1 个文件时也不例外。
  const showFileList = shouldShowCommitFileList(selectableRows);
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
      // 折叠是上一次会话留下的临时 UI 状态，重新打开弹窗一律回到全部展开。
      setCollapsedGroupIds(EMPTY_COMMIT_COLLAPSED_FILE_GROUPS);
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

  const setFileGroupCollapsed = useCallback(
    (groupId: GitCommitFileGroupId, collapsed: boolean) => {
      setCollapsedGroupIds((current) => {
        // 幂等：Radix 只在真的切换时回调，但折叠态回写仍按「已是目标值就不新建集合」处理。
        if (current.has(groupId) === collapsed) {
          return current;
        }
        const next = new Set(current);
        if (collapsed) {
          next.add(groupId);
        } else {
          next.delete(groupId);
        }
        return next;
      });
    },
    [],
  );

  const handleFileGroupSelected = useCallback(
    (groupId: GitCommitFileGroupId, selected: boolean) => {
      const group = selectableFileGroups.find((candidate) => candidate.id === groupId);
      if (!group) {
        return;
      }

      // 组级勾选只改本组路径：其他组的排除项原样保留，整体全选状态自然落到 partial。
      onSetFilesSelected(collectCommitPreviewStagePaths(group.files), selected);
    },
    [onSetFilesSelected, selectableFileGroups],
  );

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

            {showFileList ? (
              <div className="shrink-0 px-2.5 pb-2" data-testid={TID_GIT_COMMIT_FILE_LIST}>
                <label className="flex h-7 cursor-pointer items-center gap-2 rounded-md px-2 text-ui-base text-foreground-subtle hover:bg-menu-hover">
                  <Checkbox
                    data-testid={TID_GIT_COMMIT_SELECT_ALL}
                    checked={commitSelectionCheckboxValue(selectionState)}
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
                  {selectableFileGroups.map((group) => {
                    const groupLabel = intl.formatMessage({
                      id: COMMIT_FILE_GROUP_LABEL_IDS[group.id],
                    });
                    const groupSelectionState = resolveCommitPreviewSelectionState(
                      group.files,
                      excludedStagePaths,
                    );
                    const groupSelectedCount = group.files.reduce(
                      (count, row) => (excludedStagePaths.has(row.stagePath) ? count : count + 1),
                      0,
                    );
                    const collapsed = collapsedGroupIds.has(group.id);
                    return (
                      // 折叠走仓库既有的 Collapsible（tw-animate-css 的 300ms 高度关键帧）。
                      // 弹窗高度是 auto，跟着内容高度逐帧变化，所以展开/收起时弹窗本身的伸缩
                      // 也是平滑的——不需要、也不应该再给 DialogContent 加 height transition。
                      <Collapsible
                        key={group.id}
                        data-testid={`${TID_GIT_COMMIT_FILE_GROUP}-${group.id}`}
                        // 标记给 prefers-reduced-motion 用：reduce 下只切状态、不播高度关键帧。
                        data-zcode-commit-file-group="true"
                        open={!collapsed}
                        onOpenChange={(nextOpen) => {
                          setFileGroupCollapsed(group.id, !nextOpen);
                        }}
                      >
                        <CommitFileGroupHeader
                          groupId={group.id}
                          label={groupLabel}
                          selectionState={groupSelectionState}
                          countLabel={formatCommitFileCountLabel({
                            intl,
                            numberFormatter,
                            selectedCount: groupSelectedCount,
                            totalCount: group.files.length,
                            allSelected: groupSelectionState === "all",
                          })}
                          collapsed={collapsed}
                          disabled={actionPending}
                          selectAllLabel={intl.formatMessage(
                            { id: "git.actionMenu.commitDialog.fileList.group.selectAll" },
                            { group: groupLabel },
                          )}
                          toggleLabel={intl.formatMessage(
                            { id: "git.actionMenu.commitDialog.fileList.group.toggle" },
                            { group: groupLabel },
                          )}
                          onSetSelected={handleFileGroupSelected}
                        />
                        <CollapsibleContent>
                          {group.files.map((row) => (
                            <CommitFileRow
                              key={row.stagePath}
                              file={row}
                              selected={!excludedStagePaths.has(row.stagePath)}
                              disabled={actionPending}
                              numberFormatter={numberFormatter}
                              remainderLabel={
                                row.hasUnstagedRemainder ? unstagedRemainderLabel : null
                              }
                              onToggle={onToggleFileSelection}
                            />
                          ))}
                        </CollapsibleContent>
                      </Collapsible>
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

  const setCommitFilesSelected = useCallback(
    (stagePaths: readonly string[], selected: boolean) => {
      if (stagePaths.length === 0) {
        return;
      }

      // 只改这批路径的排除项：组级勾选不应连带影响其他分组已经取消勾选的文件。
      setCommitExcludedStagePaths((current) => {
        const next = new Set(current);
        for (const stagePath of stagePaths) {
          if (selected) {
            next.delete(stagePath);
          } else {
            next.add(stagePath);
          }
        }
        return next;
      });
    },
    [],
  );

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
    setCommitMessageGenerationPending(false);
    clearCommitExcludedStagePaths();
  }, [clearCommitExcludedStagePaths]);

  const setAllCommitFilesSelected = useCallback(
    (selected: boolean) => {
      if (selected || !commitDialogState) {
        clearCommitExcludedStagePaths();
        return;
      }

      setCommitExcludedStagePaths(new Set(getCommitDialogStagePaths(commitDialogState)));
    },
    [clearCommitExcludedStagePaths, commitDialogState],
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
      excludedPaths: ReadonlySet<string>,
    ): Promise<string> => {
      const selectedRows = getCommitDialogSelectedRows(state, excludedPaths);
      const { stagedPaths } = resolveCommitRequestMode(selectedRows);
      const currentSessionFilePaths = getCurrentSessionFilePaths(state.activeTaskChangeSummary);
      const { selection: modelSelection, source: selectionSource } =
        resolveCommitMessageSelection();
      logger.info("[GitActionMenu] 开始生成提交消息", {
        workspacePath,
        branchName: gitSummary.branchName,
        selectedFileCount: selectedRows.length,
        excludedFileCount: excludedPaths.size,
        stagedPathCount: stagedPaths.length,
        currentSessionFileCount: currentSessionFilePaths?.length ?? 0,
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
        // 弹窗的文件清单已经把"哪些文件、按哪种内容提交"表达完整了，生成的 diff 一律包含
        // 未暂存来源；只提交索引内容的路径靠 stagedPaths 单独收窄。
        includeUnstaged: true,
        // 消息必须只描述实际提交的文件，否则会写出并未提交的改动。
        ...(excludedPaths.size > 0 ? { excludePaths: Array.from(excludedPaths) } : {}),
        ...(stagedPaths.length > 0 ? { stagedPaths } : {}),
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

    const stagePaths = getCommitDialogStagePaths(commitDialogState, commitExcludedStagePaths);
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

      const selectedRows = getCommitDialogSelectedRows(commitDialogState, commitExcludedStagePaths);
      const { paths, worktreePaths, stagedOnly } = resolveCommitRequestMode(selectedRows);
      if (paths.length === 0) {
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
          selectedPathCount: paths.length,
          excludedPathCount: commitExcludedStagePaths.size,
          worktreePathCount: worktreePaths.length,
          stagedOnly,
          pushAfterCommit: Boolean(options?.pushAfterCommit),
        });
        // 只 add 工作区模式的路径：索引模式的路径必须保持索引内容，否则没勾选的未暂存余量
        // 会被 git add 一起带进本次提交。
        if (worktreePaths.length > 0) {
          await gitService.stagePaths({
            workspacePath,
            paths: worktreePaths,
          });
        }
        await gitService.commit({
          workspacePath,
          message: nextCommitMessage,
          paths,
          stagedOnly,
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
        excludedStagePaths={commitExcludedStagePaths}
        pushEnabled={pushEnabled}
        onRefreshGit={refreshCommitDialogAfterBranchChange}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closeCommitDialog();
          }
        }}
        onMessageChange={setCommitMessage}
        onToggleFileSelection={toggleCommitFileSelection}
        onSetAllFilesSelected={setAllCommitFilesSelected}
        onSetFilesSelected={setCommitFilesSelected}
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
