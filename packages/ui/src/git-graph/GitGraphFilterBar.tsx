import type { GitCommitGraphFilterOptions } from "@zcode/shared";
import { SearchIcon } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group.js";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { gitGraphAuthorKey, readGitGraphAuthorKey, type GitGraphFilterDraft } from "./filters.js";

interface GitGraphFilterBarProps {
  draft: GitGraphFilterDraft;
  options: GitCommitGraphFilterOptions;
  validationMessage: string | null;
  onChange: (patch: Partial<GitGraphFilterDraft>) => void;
  onApply: () => void;
}
const ALL = "__git_graph_all__";

export function GitGraphFilterBar({
  draft,
  options,
  validationMessage,
  onChange,
  onApply,
}: GitGraphFilterBarProps) {
  const { intl } = useZCodeIntl();
  const selectedBranch = options.branches.find((branch) => branch.ref === draft.branchRef);
  const selectedAuthor = options.authors.find(
    (author) => gitGraphAuthorKey(author) === draft.authorKey,
  );
  const retainedAuthor = selectedAuthor ?? readGitGraphAuthorKey(draft.authorKey);
  const branchLabel =
    selectedBranch?.name ??
    (draft.branchRef
      ? draft.branchRef.replace(/^refs\/(?:heads|remotes)\//u, "")
      : intl.formatMessage({ id: "gitGraph.filter.all" }));
  const authorLabel = retainedAuthor
    ? `${retainedAuthor.name} <${retainedAuthor.email}>`
    : intl.formatMessage({ id: "gitGraph.filter.all" });
  const textLabel = intl.formatMessage({ id: "gitGraph.filter.text" });
  const toggle = (kind: "regex" | "caseSensitive", label: string, glyph: string) => (
    <ControlHintTooltip title={label}>
      <InputGroupButton
        size="icon-xs"
        aria-label={label}
        aria-pressed={draft[kind]}
        data-testid={`git-graph-filter-${kind}`}
        className={cn(
          "shrink-0 font-mono text-ui-sm",
          draft[kind] && "bg-selected text-foreground",
        )}
        onClick={() => onChange({ [kind]: !draft[kind] })}
      >
        {glyph}
      </InputGroupButton>
    </ControlHintTooltip>
  );
  return (
    <div className="shrink-0 border-b border-border bg-background">
      <div
        data-testid="git-graph-filters-scroll"
        className="min-w-0 overflow-x-auto overscroll-x-contain"
      >
        <div
          data-testid="git-graph-filters"
          className="flex min-w-max items-center gap-2 px-3 py-2"
        >
          <InputGroup className="h-8 min-w-48 flex-1 rounded-lg border-input-border bg-input">
            <InputGroupAddon>
              <SearchIcon className="size-3.5" />
            </InputGroupAddon>
            <InputGroupInput
              value={draft.text}
              placeholder={textLabel}
              aria-label={textLabel}
              data-testid="git-graph-filter-text"
              aria-invalid={Boolean(validationMessage)}
              aria-describedby={validationMessage ? "git-graph-filter-error" : undefined}
              className="min-w-0 text-ui-base max-sm:text-mobile-input-safe"
              onChange={(event) => onChange({ text: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onApply();
                }
              }}
            />
            <InputGroupAddon align="inline-end" className="gap-0.5">
              {toggle("regex", intl.formatMessage({ id: "gitGraph.filter.regex" }), ".*")}
              {toggle(
                "caseSensitive",
                intl.formatMessage({ id: "gitGraph.filter.caseSensitive" }),
                "Aa",
              )}
            </InputGroupAddon>
          </InputGroup>
          <Select
            value={draft.branchRef || ALL}
            onValueChange={(value) => onChange({ branchRef: value === ALL ? "" : value })}
          >
            <SelectTrigger
              aria-label={intl.formatMessage({ id: "gitGraph.filter.branch" })}
              data-testid="git-graph-filter-branch"
              className="h-8 max-w-40 shrink-0 rounded-lg"
            >
              <span className="min-w-0 truncate">
                {intl.formatMessage({ id: "gitGraph.filter.branch" })}: {branchLabel}
              </span>
            </SelectTrigger>
            <SelectContent position="popper" align="end" className="max-w-[calc(100vw-2rem)]">
              <SelectItem value={ALL}>
                {intl.formatMessage({ id: "gitGraph.filter.all" })}
              </SelectItem>
              {draft.branchRef && !selectedBranch ? (
                <SelectItem value={draft.branchRef}>{branchLabel}</SelectItem>
              ) : null}
              {options.branches.map((branch) => (
                <SelectItem key={branch.ref} value={branch.ref}>
                  {branch.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={draft.authorKey || ALL}
            onValueChange={(value) => onChange({ authorKey: value === ALL ? "" : value })}
          >
            <SelectTrigger
              aria-label={intl.formatMessage({ id: "gitGraph.filter.author" })}
              data-testid="git-graph-filter-author"
              className="h-8 max-w-44 shrink-0 rounded-lg"
            >
              <span className="min-w-0 truncate">
                {intl.formatMessage({ id: "gitGraph.filter.author" })}: {authorLabel}
              </span>
            </SelectTrigger>
            <SelectContent position="popper" align="end" className="max-w-[calc(100vw-2rem)]">
              <SelectItem value={ALL}>
                {intl.formatMessage({ id: "gitGraph.filter.all" })}
              </SelectItem>
              {retainedAuthor && !selectedAuthor ? (
                <SelectItem value={draft.authorKey}>{authorLabel}</SelectItem>
              ) : null}
              {options.authors.map((author) => (
                <SelectItem key={gitGraphAuthorKey(author)} value={gitGraphAuthorKey(author)}>
                  {author.name} &lt;{author.email}&gt;
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={draft.datePreset}
            onValueChange={(value) =>
              onChange({ datePreset: value as GitGraphFilterDraft["datePreset"] })
            }
          >
            <SelectTrigger
              aria-label={intl.formatMessage({ id: "gitGraph.filter.date" })}
              data-testid="git-graph-filter-date"
              className="h-8 shrink-0 rounded-lg"
            >
              <span>
                {intl.formatMessage({ id: "gitGraph.filter.date" })}:{" "}
                {intl.formatMessage({ id: `gitGraph.filter.date.${draft.datePreset}` })}
              </span>
            </SelectTrigger>
            <SelectContent position="popper" align="end">
              {(["all", "24h", "7d", "30d"] as const).map((preset) => (
                <SelectItem key={preset} value={preset}>
                  {intl.formatMessage({ id: `gitGraph.filter.date.${preset}` })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {validationMessage ? (
        <p
          id="git-graph-filter-error"
          role="alert"
          className="px-3 pb-2 text-ui-sm text-destructive"
        >
          {validationMessage}
        </p>
      ) : null}
    </div>
  );
}
