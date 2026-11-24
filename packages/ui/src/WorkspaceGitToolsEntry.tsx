import { TID_GIT_TOOLS_ENTRY, TID_GIT_TOOLS_PANEL } from "@zcode/shared";
import type { GitChangeSourceId, ModelSelection, ZCodeTaskChangeSummary } from "@zcode/shared";
import { GitBranchIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ComposerModelSelectionReader } from "@/v4/composer/composerModelSelectionPort.js";
import { GitToolsPanel } from "@/v4/GitToolsPanel.js";
import {
  resolveGitToolsBadge,
  type GitToolsBadge,
  type GitToolsModel,
} from "@/v4/gitToolsModel.js";

interface WorkspaceGitToolsEntryProps {
  workspacePath: string;
  workspaceIdentity?: string;
  gitTools: GitToolsModel;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  commitMessageModelSelection?: ModelSelection | null;
  readCommitMessageModelSelection?: ComposerModelSelectionReader;
  onRefreshGit: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
}

function formatBadgeCount(count: number): string {
  return count >= 100 ? "99+" : String(count);
}

function badgeKindMessageId(badge: GitToolsBadge): string {
  switch (badge.kind) {
    case "changes":
      return "chat.statusPanel.changes";
    case "pushable":
      return "chat.statusPanel.unpushedCommits";
    case "behind":
      return "chat.statusPanel.behindRemote";
    case "synced":
      return "chat.statusPanel.remoteSynced";
  }
}

/**
 * 工作区标题栏的 Git 工具入口：GitBranch 图标 + 计数徽标，点击展开 Git 浮层。
 *
 * 这是 Git 工具的唯一入口（spec 规则 1/9）：图标在 `gitTools !== null` 时始终出现，
 * 不再依赖状态面板是否展开，也不再渲染任何 chip。浮层是 Git 行的唯一渲染点。
 */
export function WorkspaceGitToolsEntry({
  workspacePath,
  workspaceIdentity,
  gitTools,
  open,
  onOpenChange,
  gitWorktreeReviewSourceId,
  activeTaskChangeSummary,
  commitMessageModelSelection = null,
  readCommitMessageModelSelection,
  onRefreshGit,
  onOpenGitReview,
}: WorkspaceGitToolsEntryProps) {
  const { intl } = useZCodeIntl();
  const previousOpenRef = useRef(false);
  useEffect(() => {
    const opened = open && !previousOpenRef.current;
    previousOpenRef.current = open;
    // 主动打开绕过 watcher 静默窗口；重渲、回调换引用和关闭都不追加读取。
    if (opened) {
      onRefreshGit();
    }
  }, [onRefreshGit, open]);
  const title = intl.formatMessage({ id: "chat.statusPanel.environment" });
  const badge = resolveGitToolsBadge(gitTools);
  const badgeKindLabel = badge ? intl.formatMessage({ id: badgeKindMessageId(badge) }) : title;
  const badgeCount =
    badge?.count !== null && badge?.count !== undefined && badge.count > 0
      ? formatBadgeCount(badge.count)
      : null;
  const ariaLabel = badge
    ? intl.formatMessage(
        { id: "chat.statusPanel.gitChipAriaLabel" },
        { summary: badgeCount ? `${badgeKindLabel} ${badgeCount}` : badgeKindLabel },
      )
    : title;

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <ControlHintTooltip title={title} side="bottom">
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-md"
            data-testid={TID_GIT_TOOLS_ENTRY}
            aria-label={ariaLabel}
            aria-expanded={open}
            data-git-badge-kind={badge?.kind}
            data-git-badge-count={badgeCount ?? undefined}
            className="[app-region:no-drag] relative"
          >
            <GitBranchIcon className="size-4" />
            {badgeCount ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[9px] font-medium leading-none text-[var(--color-foreground)] tabular-nums"
              >
                {badgeCount}
              </span>
            ) : null}
          </Button>
        </PopoverTrigger>
      </ControlHintTooltip>
      <PopoverContent
        data-testid={TID_GIT_TOOLS_PANEL}
        align="end"
        side="bottom"
        sideOffset={6}
        // 浮层不要贴着会话正文向外伸；整体右移，落到标题栏图标簇下方。
        // align="end" 时 floating-ui 会对 alignmentAxis 取反，负值才是向右。
        alignOffset={-64}
        className="max-h-[min(60dvh,26rem)] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto p-0"
      >
        <GitToolsPanel
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          gitTools={gitTools}
          gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
          activeTaskChangeSummary={activeTaskChangeSummary}
          commitMessageModelSelection={commitMessageModelSelection}
          readCommitMessageModelSelection={readCommitMessageModelSelection}
          onRefreshGit={onRefreshGit}
          onOpenGitReview={onOpenGitReview}
        />
      </PopoverContent>
    </Popover>
  );
}
