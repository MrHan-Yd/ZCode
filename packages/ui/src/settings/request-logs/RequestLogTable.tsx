import { ArrowDown, ArrowUp, CircleHelp } from "lucide-react";
import type { ModelRequestLogsSnapshot } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatRequestLogCache,
  formatRequestLogDuration,
  formatRequestLogPercent,
  formatRequestLogSpeed,
  resolveProviderDisplayName,
} from "@/lib/modelRequestLogs.js";

/** 紧凑单元格：表格要在设置页宽度内放下，不靠横向滚动。 */
const CELL = "whitespace-nowrap px-2 py-1.5 text-ui-sm";
const NUMERIC = `${CELL} text-right tabular-nums`;
const STATUS_COLORS = {
  completed: "text-success",
  error: "text-destructive",
  cancelled: "text-foreground-subtle",
  running: "text-warning",
};

function Header({
  label,
  hint,
  numeric = true,
}: {
  label: string;
  hint?: string;
  numeric?: boolean;
}) {
  return (
    <th scope="col" className={`${numeric ? NUMERIC : CELL} font-medium text-foreground-subtle`}>
      <span className="inline-flex items-center gap-1">
        {label}
        {hint ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={hint}
                className="rounded-sm text-foreground-subtlest hover:text-foreground"
              >
                <CircleHelp className="size-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">{hint}</TooltipContent>
          </Tooltip>
        ) : null}
      </span>
    </th>
  );
}

export function RequestLogTable({
  snapshot,
  providerNames,
  sortDirection,
  onSort,
  loading,
}: {
  snapshot: ModelRequestLogsSnapshot;
  providerNames: ReadonlyMap<string, string>;
  sortDirection: "asc" | "desc";
  onSort: () => void;
  loading: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `settings.requestLogs.${key}` });
  const number = new Intl.NumberFormat(locale);
  const time = new Intl.DateTimeFormat(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: snapshot.timeZone,
  });
  const detail = snapshot.view === "requests";
  return (
    <div
      data-testid="request-logs-scroll"
      aria-busy={loading}
      // 新结果到达前继续展示上一次结果并轻微置灰：表格不卸载，避免切换筛选时闪屏。
      className={`min-w-0 overflow-x-auto rounded-xl border border-border bg-card transition-opacity ${
        loading ? "opacity-60" : "opacity-100"
      }`}
    >
      <table data-testid="request-logs-table" className="w-full text-left text-foreground">
        <thead className="sticky top-0 z-10 border-b border-border bg-surface">
          <tr>
            {detail ? (
              <>
                <Header label={t("time")} numeric={false} />
                <Header label={t("model")} numeric={false} />
                <Header label={t("input")} hint={t("inputHint")} />
                <Header label={t("output")} />
                <Header label={t("cacheRead")} hint={t("cacheHint")} />
                <Header label={t("speed")} hint={t("speedHint")} />
                <Header label={t("firstToken")} hint={t("firstTokenHint")} />
                <Header label={t("duration")} />
                <Header label={t("status")} numeric={false} />
              </>
            ) : (
              <>
                <Header
                  label={t(snapshot.view === "providers" ? "provider" : "model")}
                  numeric={false}
                />
                <th
                  scope="col"
                  aria-sort={sortDirection === "desc" ? "descending" : "ascending"}
                  className={NUMERIC}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onSort}
                    disabled={loading}
                    aria-label={t("sortCount")}
                    data-testid="request-logs-sort"
                  >
                    {t("requestCount")}
                    {sortDirection === "desc" ? (
                      <ArrowDown className="size-3" />
                    ) : (
                      <ArrowUp className="size-3" />
                    )}
                  </Button>
                </th>
                <Header label={t("tokens")} />
                <Header label={t("successRate")} />
                <Header label={t("speed")} hint={t("speedHint")} />
                <Header label={t("firstToken")} hint={t("firstTokenHint")} />
              </>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {detail
            ? snapshot.requests.map((row) => (
                <tr key={row.id} data-request-log-id={row.id} className="hover:bg-hover">
                  <td className={CELL} title={new Date(row.startedAt).toISOString()}>
                    {time.format(row.startedAt)}
                  </td>
                  <td className={`${CELL} max-w-56`}>
                    <span className="block truncate font-mono" title={row.modelId}>
                      {row.modelId}
                    </span>
                    <span className="block truncate text-foreground-subtle" title={row.providerId}>
                      {resolveProviderDisplayName(row.providerId, providerNames)}
                    </span>
                  </td>
                  <td className={NUMERIC}>{number.format(row.uncachedInputTokens)}</td>
                  <td className={NUMERIC}>{number.format(row.outputTokens)}</td>
                  <td className={NUMERIC}>
                    {formatRequestLogCache(row.cacheReadTokens, row.cacheHitRate, locale)}
                  </td>
                  <td className={NUMERIC}>{formatRequestLogSpeed(row.tokensPerSecond, locale)}</td>
                  <td className={NUMERIC}>
                    {formatRequestLogDuration(row.timeToFirstTokenMs, locale)}
                  </td>
                  <td className={NUMERIC}>{formatRequestLogDuration(row.durationMs, locale)}</td>
                  <td className={CELL}>
                    <span className={STATUS_COLORS[row.status]}>
                      {t(row.status)}
                      {row.httpStatus !== null ? ` (${row.httpStatus})` : ""}
                    </span>
                    {row.retryCount > 0 ? (
                      <span className="block text-foreground-subtle">
                        {intl.formatMessage(
                          { id: "settings.requestLogs.retryCount" },
                          { count: row.retryCount },
                        )}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))
            : snapshot.groups.map((group) => (
                <tr
                  key={JSON.stringify([group.providerId, group.modelId])}
                  data-request-log-group={group.providerId}
                  className="hover:bg-hover"
                >
                  <td className={`${CELL} max-w-56`}>
                    <span
                      className={`block truncate ${group.modelId ? "font-mono" : ""}`}
                      title={group.modelId ?? group.providerId}
                    >
                      {group.modelId ?? resolveProviderDisplayName(group.providerId, providerNames)}
                    </span>
                    {group.modelId ? (
                      <span
                        className="block truncate text-foreground-subtle"
                        title={group.providerId}
                      >
                        {resolveProviderDisplayName(group.providerId, providerNames)}
                      </span>
                    ) : null}
                  </td>
                  <td className={NUMERIC}>{number.format(group.requestCount)}</td>
                  <td className={NUMERIC}>{number.format(group.totalTokens)}</td>
                  <td className={NUMERIC}>{formatRequestLogPercent(group.successRate, locale)}</td>
                  <td className={NUMERIC}>
                    {formatRequestLogSpeed(group.tokensPerSecond, locale)}
                  </td>
                  <td className={NUMERIC}>
                    {formatRequestLogDuration(group.timeToFirstTokenMs, locale)}
                  </td>
                </tr>
              ))}
          {snapshot.requests.length === 0 && snapshot.groups.length === 0 ? (
            <tr>
              <td
                colSpan={detail ? 9 : 6}
                className="px-4 py-12 text-center text-ui-base text-foreground-subtle"
              >
                {t("empty")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}
