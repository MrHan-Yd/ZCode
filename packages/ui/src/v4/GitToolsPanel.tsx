import { FileDiffIcon, GitGraphIcon } from "lucide-react";
import type { GitChangeSourceId, ModelSelection, ZCodeTaskChangeSummary } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { GitActionMenu } from "@/GitActionMenu.js";
import { GitBranchSwitcher } from "@/GitBranchSwitcher.js";
import { GitPullAction } from "@/GitPullAction.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { GitToolsModel } from "@/v4/gitToolsModel.js";
import type { ComposerModelSelectionReader } from "@/v4/composer/composerModelSelectionPort.js";

interface GitToolsPanelProps {
  workspacePath: string;
  workspaceIdentity?: string;
  gitTools: GitToolsModel;
  gitWorktreeReviewSourceId?: GitChangeSourceId | null;
  activeTaskChangeSummary?: ZCodeTaskChangeSummary | null;
  commitMessageModelSelection?: ModelSelection | null;
  readCommitMessageModelSelection?: ComposerModelSelectionReader;
  onRefreshGit: () => void;
  onOpenGitReview?: (sourceId?: GitChangeSourceId) => void;
  onOpenGitGraph?: () => void;
}

/**
 * 标题栏 Git 浮层的内容。
 *
 * 这是全 UI 唯一的 Git 行渲染点：更改 → 分支切换 → Git 图谱 → 提交或推送 → 拉取。
 * 大数字只在浮层内出现，且用紧凑格式（5.8k / 1.2m）；精确值留在 title 与 aria-label。
 */
function formatDiffCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}b`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function GitToolsPanel({
  workspacePath,
  workspaceIdentity,
  gitTools,
  gitWorktreeReviewSourceId,
  activeTaskChangeSummary,
  commitMessageModelSelection = null,
  readCommitMessageModelSelection,
  onRefreshGit,
  onOpenGitReview,
  onOpenGitGraph,
}: GitToolsPanelProps) {
  const { intl } = useZCodeIntl();
  const hasChanges = gitTools.added + gitTools.removed > 0;
  // 「更改」行只在真的有改动时渲染；有上游的干净仓库也会打开浮层，
  // 继续挂一行「+0 -0」会让这段看起来是空的。
  const hasWorkspaceChanges = hasChanges || gitTools.dirtyFileCount > 0;
  const canOpenReview = Boolean(onOpenGitReview && gitTools.summary.isRepository);
  const preciseSummary = `+${gitTools.added} -${gitTools.removed}`;

  return (
    <div className="flex w-full flex-col">
      <div className="flex h-8 min-w-0 shrink-0 items-center gap-1.5 px-2">
        <span className="shrink-0 text-ui-base text-[var(--color-foreground-subtle)]">
          {intl.formatMessage({ id: "chat.statusPanel.environment" })}
        </span>
      </div>
      <div className="space-y-0 p-2 pt-0">
        {hasWorkspaceChanges ? (
          <button
            type="button"
            disabled={!canOpenReview}
            title={preciseSummary}
            aria-label={intl.formatMessage(
              { id: "chat.gitPanel.changesAriaLabel" },
              {
                files: String(gitTools.dirtyFileCount),
                added: String(gitTools.added),
                removed: String(gitTools.removed),
              },
            )}
            className={cn(
              "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground)] transition-colors",
              canOpenReview
                ? "hover:bg-[var(--color-hover)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
                : "cursor-default opacity-50",
            )}
            onClick={() => {
              onOpenGitReview?.(gitWorktreeReviewSourceId ?? undefined);
            }}
          >
            <FileDiffIcon className="size-4 shrink-0 text-[var(--color-foreground)]" />
            <span className="min-w-0 flex-1 truncate">
              {intl.formatMessage({ id: "chat.statusPanel.changes" })}
            </span>
            <span className="shrink-0 font-mono tabular-nums">
              <span className="text-[var(--color-diff-added)]">
                +{formatDiffCount(gitTools.added)}
              </span>{" "}
              <span className="text-[var(--color-diff-removed)]">
                -{formatDiffCount(gitTools.removed)}
              </span>
            </span>
          </button>
        ) : null}
        <GitBranchSwitcher
          workspacePath={workspacePath}
          gitSummary={gitTools.summary}
          dirtyFileCount={gitTools.dirtyFileCount}
          onRefreshGit={onRefreshGit}
          className="w-full px-0 pt-0"
          triggerClassName="flex h-8 w-full min-w-0 justify-start gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground)] hover:bg-[var(--color-hover)] hover:text-[var(--color-foreground)] [&>span]:max-w-[calc(100%-3.5rem)] [&_svg:first-child]:text-[var(--color-foreground)]"
          popoverClassName="w-72 max-w-[calc(100vw-2rem)]"
          branchListClassName="max-h-56"
          popoverSide="left"
          showFooterActions
        />
        {onOpenGitGraph ? (
          <button
            type="button"
            data-testid="git-graph-entry"
            onClick={onOpenGitGraph}
            className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui-base text-foreground hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
          >
            <GitGraphIcon className="size-4 shrink-0" />
            {intl.formatMessage({ id: "gitGraph.menuAction" })}
          </button>
        ) : null}
        <GitActionMenu
          workspacePath={workspacePath}
          workspaceIdentity={workspaceIdentity}
          gitSummary={gitTools.summary}
          activeTaskChangeSummary={activeTaskChangeSummary ?? null}
          commitMessageModelSelection={commitMessageModelSelection}
          readCommitMessageModelSelection={readCommitMessageModelSelection}
          onRefreshGit={onRefreshGit}
          triggerLayout="status-row"
          className="w-full"
        />
        {gitTools.canPull ? (
          <GitPullAction
            workspacePath={workspacePath}
            gitSummary={gitTools.summary}
            onRefreshGit={onRefreshGit}
            className="w-full"
          />
        ) : null}
      </div>
    </div>
  );
}
