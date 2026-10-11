import { useCallback, useState, type ReactNode } from "react";
import {
  TID_GIT_PULL_CONFIRM,
  TID_GIT_PULL_DIALOG,
  TID_GIT_PULL_RESULT,
  type GitPullIssueCode,
  type GitPullResult,
  type GitRepositorySummary,
} from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Textarea } from "@/components/ui/textarea.js";
import { toast } from "@/components/ui/toast.js";
import { resolveGitPullErrorMessageId } from "@/git-action-menu/display.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AlertCircleIcon, ArrowDownToLine, GitBranchIcon, LoaderIcon } from "lucide-react";

export interface GitPullErrorState {
  code: GitPullIssueCode | null;
  message: string;
}

/** 拉取弹窗的「标签 + 取值」行。弹窗里这类行有六处，统一在这里收敛对齐方式。 */
function GitPullDetailRow({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="text-ui-base font-medium text-foreground">{label}</div>
      <div className={cn("text-foreground-subtle", valueClassName)}>{value}</div>
    </div>
  );
}

interface GitPullDialogProps {
  open: boolean;
  gitSummary: GitRepositorySummary;
  currentBranchLabel: string;
  result: GitPullResult | null;
  error: GitPullErrorState | null;
  mutationPending: boolean;
  onOpenChange: (nextOpen: boolean) => void;
  onSubmit: () => void;
}

export function GitPullDialog({
  open,
  gitSummary,
  currentBranchLabel,
  result,
  error,
  mutationPending,
  onOpenChange,
  onSubmit,
}: GitPullDialogProps) {
  const { intl, locale } = useZCodeIntl();
  const numberFormatter = new Intl.NumberFormat(locale);
  const [errorCopied, setErrorCopied] = useState(false);
  const descriptionId = gitSummary.trackingBranchName
    ? "git.actionMenu.pullDialog.description.tracked"
    : "git.actionMenu.pullDialog.description.untracked";
  // 已知失败码走本地化文案；识别不出来的失败直接展示原始 Git 输出，比一句笼统的「拉取失败」更可诊断。
  const failureMessageId = resolveGitPullErrorMessageId(error?.code ?? null);
  const finished = Boolean(error) || Boolean(result);

  const handleCopyError = useCallback(() => {
    if (!error) {
      return;
    }

    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      toast(
        intl.formatMessage(
          { id: "git.actionMenu.pullDialog.error.copyFailed" },
          { error: "clipboard-unavailable" },
        ),
      );
      return;
    }

    void navigator.clipboard.writeText(error.message).then(
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
            { id: "git.actionMenu.pullDialog.error.copyFailed" },
            { error: message },
          ),
        );
      },
    );
  }, [error, intl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid={TID_GIT_PULL_DIALOG}
        className="max-w-lg gap-0 rounded-2xl p-0 overflow-hidden"
      >
        <DialogHeader className="gap-2 px-6 py-5 pb-0">
          <DialogTitle className="text-lg font-medium text-foreground">
            {intl.formatMessage({ id: "git.actionMenu.pullDialog.title" })}
          </DialogTitle>
          <DialogDescription className="text-ui-base leading-6 text-foreground-subtle">
            {intl.formatMessage({ id: descriptionId })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-6 py-6">
          {!finished ? (
            <div className="rounded-xl bg-background/30">
              <div className="flex items-start justify-between p-4">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({
                    id: "git.actionMenu.pullDialog.currentBranchLabel",
                  })}
                </div>
                <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
                  <GitBranchIcon className="size-4 text-foreground-subtle" />
                  <span>{currentBranchLabel}</span>
                </div>
              </div>

              <div className="space-y-3 border-t border-border/50 p-4 text-ui-base">
                <GitPullDetailRow
                  label={intl.formatMessage({
                    id: "git.actionMenu.pullDialog.upstreamLabel",
                  })}
                  value={
                    gitSummary.trackingBranchName
                      ? gitSummary.trackingBranchName
                      : intl.formatMessage({
                          id: "git.actionMenu.pullDialog.upstreamPending",
                        })
                  }
                />
                <GitPullDetailRow
                  label={intl.formatMessage({
                    id: "git.actionMenu.pullDialog.aheadBehindLabel",
                  })}
                  value={intl.formatMessage(
                    { id: "git.actionMenu.pullDialog.aheadBehindValue" },
                    {
                      ahead: numberFormatter.format(gitSummary.ahead),
                      behind: numberFormatter.format(gitSummary.behind),
                    },
                  )}
                />
                <div className="flex items-center justify-between gap-4 border-t border-border/50 pt-3">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pullDialog.pullLabel",
                    })}
                  </div>
                  <div className="flex items-center gap-2 text-foreground-subtle">
                    <ArrowDownToLine className="size-4" />
                    <span>
                      {intl.formatMessage({
                        id: "git.actionMenu.pullDialog.pullValue",
                      })}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {result ? (
            <div data-testid={TID_GIT_PULL_RESULT}>
              {result.updated ? (
                <div className="rounded-xl bg-background/30">
                  <div className="flex items-start justify-between p-4">
                    <div className="text-ui-base font-medium text-foreground">
                      {intl.formatMessage({
                        id: "git.actionMenu.pullDialog.success.summary",
                      })}
                    </div>
                    <div className="flex items-center gap-2 text-ui-base font-medium text-foreground">
                      <ArrowDownToLine className="size-4 text-foreground-subtle" />
                      <span>{result.trackingBranchName ?? currentBranchLabel}</span>
                    </div>
                  </div>

                  {result.commitCount !== null ||
                  result.fileCount !== null ||
                  (result.added !== null && result.removed !== null) ? (
                    <div className="space-y-3 border-t border-border/50 p-4 text-ui-base">
                      {result.commitCount !== null ? (
                        <GitPullDetailRow
                          label={intl.formatMessage({
                            id: "git.actionMenu.pullDialog.success.commitsLabel",
                          })}
                          value={intl.formatMessage(
                            { id: "git.actionMenu.pullDialog.success.commitsValue" },
                            { count: numberFormatter.format(result.commitCount) },
                          )}
                        />
                      ) : null}
                      {result.fileCount !== null ? (
                        <GitPullDetailRow
                          label={intl.formatMessage({
                            id: "git.actionMenu.pullDialog.success.filesLabel",
                          })}
                          value={intl.formatMessage(
                            { id: "git.actionMenu.pullDialog.success.filesValue" },
                            { count: numberFormatter.format(result.fileCount) },
                          )}
                        />
                      ) : null}
                      {result.added !== null && result.removed !== null ? (
                        <GitPullDetailRow
                          label={intl.formatMessage({
                            id: "git.actionMenu.pullDialog.success.linesLabel",
                          })}
                          valueClassName="font-mono"
                          value={
                            <>
                              <span className="text-diff-added">
                                +{numberFormatter.format(result.added)}
                              </span>{" "}
                              <span className="text-diff-removed">
                                -{numberFormatter.format(result.removed)}
                              </span>
                            </>
                          }
                        />
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="flex items-start gap-3 rounded-xl bg-background/30 px-4 py-3 text-ui-base text-foreground-subtle">
                  <ArrowDownToLine className="mt-0.5 size-4 shrink-0" />
                  <span>
                    {intl.formatMessage({
                      id: "git.actionMenu.pullDialog.upToDate",
                    })}
                  </span>
                </div>
              )}
            </div>
          ) : null}

          {error ? (
            <>
              <div className="flex items-start gap-3 rounded-xl bg-warning/10 px-4 py-3 text-ui-base text-warning">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                <span>
                  {failureMessageId
                    ? intl.formatMessage({ id: failureMessageId })
                    : intl.formatMessage({
                        id: "git.actionMenu.pullDialog.error.summary",
                      })}
                </span>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-ui-base font-medium text-foreground">
                    {intl.formatMessage({
                      id: "git.actionMenu.pullDialog.error.detailsLabel",
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
                        ? "git.actionMenu.pullDialog.error.copy.copied"
                        : "git.actionMenu.pullDialog.error.copy",
                    })}
                  </Button>
                </div>
                <Textarea
                  // 与推送弹窗一致：固定尺寸 + 换行，长错误文本不会把弹窗撑爆。
                  className="field-sizing-fixed w-full max-w-full min-h-40 rounded-lg border-input-border bg-background/50 px-3 py-3 text-ui-base text-foreground whitespace-pre-wrap break-words placeholder:text-foreground-subtlest focus-visible:border-input-border-focused focus-visible:bg-input-focused focus-visible:ring-0 md:text-ui-base"
                  readOnly
                >
                  {error.message}
                </Textarea>
              </div>
            </>
          ) : null}

          <DialogFooter className="gap-2 pt-4">
            {finished ? (
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
                  data-testid={TID_GIT_PULL_CONFIRM}
                  size="lg"
                  onClick={onSubmit}
                  disabled={mutationPending}
                  className="h-10 min-w-0 px-5"
                >
                  {mutationPending ? <LoaderIcon className="size-4 animate-spin" /> : null}
                  {intl.formatMessage({
                    id: "git.actionMenu.pullDialog.confirm",
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
