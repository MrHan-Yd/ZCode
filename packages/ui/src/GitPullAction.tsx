import { useCallback, useMemo, useRef, useState } from "react";
import { TID_GIT_PULL_TRIGGER, type GitPullResult, type GitRepositorySummary } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { readGitPullIssueCode } from "@/git-action-menu/display.js";
import { GitPullDialog, type GitPullErrorState } from "@/git-action-menu/GitPullDialog.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { ArrowDownToLine } from "lucide-react";

/**
 * 拉取成功的 toast 补充片段（文件数与增删行数）。toast 不像结果面板那样会被
 * 「工作区变干净 → 整块 Git 区卸载」带走，所以「拿回来多少」也要在这里留一份。
 * 作为独立的一句拼在主句后面，避免依赖各语言的连接符。
 */
function formatPullToastStats(
  intl: IntlInstance,
  result: GitPullResult,
  numberFormatter: Intl.NumberFormat,
): string {
  // fileCount / added / removed 同出一份 diff 统计：只要有一项拿不到就整句省略。
  if (
    !result.updated ||
    result.fileCount === null ||
    result.added === null ||
    result.removed === null
  ) {
    return "";
  }

  return intl.formatMessage(
    { id: "git.actionMenu.pullDialog.toast.successStats" },
    {
      files: numberFormatter.format(result.fileCount),
      added: numberFormatter.format(result.added),
      removed: numberFormatter.format(result.removed),
    },
  );
}

interface GitPullActionProps {
  workspacePath: string;
  gitSummary: GitRepositorySummary;
  onRefreshGit: () => void;
  className?: string;
}

/**
 * Git 工具里的「拉取」行（含拉取弹窗）。
 *
 * 拉取与提交、推送同级，所以在状态面板里占**独立一行**：塞进「提交或推送」的弹窗动作列表时，
 * 用户得先点进那个弹窗才能发现拉取，而拉取恰恰常常是工作区干净时唯一要做的事。
 *
 * 只在存在上游分支时渲染（`canPullGitBranch`）：没有上游时拉取必然失败，那种情况下
 * 「提交或推送」行会先把分支推上去、建立跟踪关系，这一行随后自然出现。
 */
export function GitPullAction({
  workspacePath,
  gitSummary,
  onRefreshGit,
  className,
}: GitPullActionProps) {
  const { gitService } = useServices();
  const { intl, locale } = useZCodeIntl();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [result, setResult] = useState<GitPullResult | null>(null);
  const [error, setError] = useState<GitPullErrorState | null>(null);
  const [mutationPending, setMutationPending] = useState(false);
  // 本次弹窗会话里是否真的跑过拉取（成功或失败）。决定关闭弹窗时要不要补那次被推迟的刷新。
  const settledRef = useRef(false);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const currentBranchLabel =
    gitSummary.branchName?.trim() || intl.formatMessage({ id: "git.branchSwitcher.label" });

  const closeDialog = useCallback(() => {
    setDialogOpen(false);
    setResult(null);
    setError(null);
    // 拉取期间刻意不刷新（见 handleSubmit 的说明），这里补上那一次。
    // 纯取消关闭没跑过拉取，不该多打一次 Git 读取。
    if (settledRef.current) {
      settledRef.current = false;
      onRefreshGit();
    }
  }, [onRefreshGit]);

  const openDialog = useCallback(() => {
    // 每次重新打开都要清掉上一次的结果，否则会拿旧结果冒充本次拉取。
    settledRef.current = false;
    setResult(null);
    setError(null);
    setDialogOpen(true);
  }, []);

  const handleSubmit = useCallback(async () => {
    setMutationPending(true);
    setError(null);
    setResult(null);

    try {
      const pullResult = await gitService.pull({ workspacePath });
      setResult(pullResult);
      settledRef.current = true;
      logger.info("[GitPullAction] 拉取更改成功", {
        workspacePath,
        branchName: pullResult.branchName,
        trackingBranchName: pullResult.trackingBranchName,
        updated: pullResult.updated,
        commitCount: pullResult.commitCount,
        fileCount: pullResult.fileCount,
      });
      // 结果面板是主要展示处，toast 是它的冗余通道：面板所在的整块 Git 区可能因为
      // 工作区变干净而卸载，toast 不受影响，「拿回来多少」不会因此丢失。
      const statsLine = formatPullToastStats(intl, pullResult, numberFormatter);
      toast(
        !pullResult.updated
          ? intl.formatMessage({ id: "git.actionMenu.pullDialog.toast.upToDate" })
          : // 拿不到提交数时不要说「拉取 0 个提交」——那是"不知道"，不是"没有"。
            [
              pullResult.commitCount === null
                ? intl.formatMessage({ id: "git.actionMenu.pullDialog.toast.updated" })
                : intl.formatMessage(
                    { id: "git.actionMenu.pullDialog.toast.success" },
                    {
                      target: pullResult.trackingBranchName?.trim() || currentBranchLabel,
                      count: numberFormatter.format(pullResult.commitCount),
                    },
                  ),
              statsLine,
            ]
              .filter(Boolean)
              .join(" "),
      );
      // 结果留在弹窗里（拉取的看点就是"拿回来多少"），所以这里不关弹窗、也不刷新：
      // 拉取成功后 behind 会归零，立即刷新会把刚渲染出的结果面板一起卸载掉。
      // 刷新改到弹窗关闭时执行。
    } catch (caught: unknown) {
      const code = readGitPullIssueCode(caught);
      const message = getErrorMessage(caught);
      logger.warn("[GitPullAction] 拉取更改失败", {
        workspacePath,
        code,
        error: message,
      });
      setError({ code, message });
      settledRef.current = true;
      // 失败同样不在这里刷新：弹窗是唯一能看到冲突原因与原始输出的地方，
      // 刷新会把它连同 Git 区一起卸载。关闭时再刷新。
    } finally {
      setMutationPending(false);
    }
  }, [currentBranchLabel, gitService, intl, numberFormatter, workspacePath]);

  return (
    <>
      <button
        type="button"
        data-testid={TID_GIT_PULL_TRIGGER}
        onClick={openDialog}
        className={cn(
          "flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground)] transition-colors hover:bg-[var(--color-hover)] hover:text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]",
          className,
        )}
      >
        <ArrowDownToLine className="size-4 shrink-0 text-[var(--color-foreground)]" />
        <span className="min-w-0 flex-1 truncate">
          {intl.formatMessage({ id: "git.actionMenu.pull" })}
        </span>
        {gitSummary.behind > 0 ? (
          <span className="shrink-0 font-mono tabular-nums text-[var(--color-foreground-subtle)]">
            {intl.formatMessage(
              { id: "git.actionMenu.pullRow.behind" },
              { count: numberFormatter.format(gitSummary.behind) },
            )}
          </span>
        ) : null}
      </button>

      <GitPullDialog
        open={dialogOpen}
        gitSummary={gitSummary}
        currentBranchLabel={currentBranchLabel}
        result={result}
        error={error}
        mutationPending={mutationPending}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closeDialog();
          }
        }}
        onSubmit={() => {
          void handleSubmit();
        }}
      />
    </>
  );
}
