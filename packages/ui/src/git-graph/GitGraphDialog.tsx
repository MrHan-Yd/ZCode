import type { RefObject } from "react";
import { GitGraphIcon, LoaderIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { GitGraphPane } from "@/git-graph/GitGraphPane.js";
import { GitGraphFilterBar } from "@/git-graph/GitGraphFilterBar.js";
import { useGitGraphQuery } from "@/hooks/useGitGraphQuery.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";

interface GitGraphDialogProps {
  open: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
  onOpenChange: (nextOpen: boolean) => void;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}

export function GitGraphDialog({
  open,
  workspacePath,
  workspaceIdentity,
  onOpenChange,
  returnFocusRef,
}: GitGraphDialogProps) {
  const { intl } = useZCodeIntl();
  const query = useGitGraphQuery({ open, workspacePath, workspaceIdentity });
  const validationMessage = query.validation
    ? intl.formatMessage({
        id:
          query.validation === "invalid-regex"
            ? "gitGraph.filter.invalidRegex"
            : "gitGraph.filter.invalidQuery",
      })
    : null;
  const error = query.error ?? query.optionsError;
  const errorMessage = error
    ? intl.formatMessage({ id: "gitGraph.error.requestFailed" }, { error: getErrorMessage(error) })
    : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-testid="git-graph-dialog"
        className="flex h-[min(78dvh,720px)] w-[calc(100vw-2rem)] max-w-5xl flex-col gap-0 overflow-hidden rounded-2xl p-0"
        onCloseAutoFocus={(event) => {
          if (!returnFocusRef?.current) return;
          event.preventDefault();
          returnFocusRef.current.focus();
        }}
      >
        <DialogHeader className="sr-only">
          <DialogTitle>{intl.formatMessage({ id: "gitGraph.title" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "gitGraph.dialogDescription" })}
          </DialogDescription>
        </DialogHeader>
        <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
          <GitGraphIcon className="size-4" />
          <h2 className="min-w-0 flex-1 truncate text-ui-base font-medium">
            {intl.formatMessage({ id: "gitGraph.title" })}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-testid="git-graph-refresh"
            aria-label={intl.formatMessage({ id: "gitGraph.refresh" })}
            onClick={query.refresh}
          >
            <RefreshCwIcon className="size-3.5" />
          </Button>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={intl.formatMessage({ id: "common.close" })}
            >
              <XIcon className="size-3.5" />
            </Button>
          </DialogClose>
        </header>
        <GitGraphFilterBar
          draft={query.draft}
          options={query.options}
          validationMessage={validationMessage}
          onChange={query.updateDraft}
          onApply={query.applyNow}
        />
        {errorMessage ? (
          <p role="alert" className="shrink-0 px-3 py-2 text-ui-sm text-warning">
            {errorMessage}
          </p>
        ) : null}
        <div className="min-h-0 min-w-0 flex-1">
          {query.loading ? (
            <div
              role="status"
              className="flex h-full items-center justify-center bg-background text-foreground-subtle"
            >
              <LoaderIcon className="size-5 animate-spin" />
            </div>
          ) : validationMessage ? (
            <div className="flex h-full items-center justify-center bg-background px-3 text-ui-base text-foreground-subtle">
              {validationMessage}
            </div>
          ) : query.error && query.commits.length === 0 ? (
            <div className="flex h-full items-center justify-center bg-background px-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "gitGraph.filter.retry" })}
            </div>
          ) : (
            <GitGraphPane
              key={query.generation}
              showHeader={false}
              filtered={query.filtered}
              commits={query.commits}
              hasMore={query.hasMore}
              loadingMore={query.loadingMore}
              selectedCommitHash={query.selectedHash}
              onSelectCommit={query.selectCommit}
              onLoadMore={query.loadMore}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
