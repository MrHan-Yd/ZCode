import { useMemo, useReducer } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import {
  MODEL_REQUEST_LOG_RANGES,
  MODEL_REQUEST_LOG_STATUSES,
  MODEL_REQUEST_LOG_VIEWS,
  type ModelRequestLogRange,
  type ModelRequestLogStatus,
  type ModelRequestLogView,
} from "@zcode/shared";
import type { IProviderSettingsService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useModelRequestLogs } from "@/hooks/useModelRequestLogs.js";
import { useProviderSettingsServiceView } from "@/hooks/useProviderSettingsView.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import {
  buildProviderDisplayNames,
  initialModelRequestLogsQuery,
  reduceModelRequestLogsQuery,
} from "@/lib/modelRequestLogs.js";
import { RequestLogTable } from "./RequestLogTable.js";

export function RequestLogsSection({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath?: string | null;
  workspaceIdentity?: string;
}) {
  const { services, rpcReady, remoteSessionId } = useWorkspaceServicesResolution(
    workspacePath,
    undefined,
    workspaceIdentity,
  );
  return (
    <ServiceProvider services={services}>
      <RequestLogsPanel
        enabled={rpcReady}
        providerSettingsService={services.providerSettingsService}
        workspacePath={workspacePath ?? undefined}
        workspaceIdentity={workspaceIdentity}
        remoteSessionId={remoteSessionId ?? undefined}
      />
    </ServiceProvider>
  );
}

export function RequestLogsPanel({
  enabled = true,
  providerSettingsService,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
}: {
  enabled?: boolean;
  providerSettingsService: IProviderSettingsService;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}) {
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `settings.requestLogs.${key}` });
  const [query, dispatch] = useReducer(reduceModelRequestLogsQuery, initialModelRequestLogsQuery);
  const { snapshot, counts, totalCount, loading, error, refresh } = useModelRequestLogs(
    query,
    enabled,
    {
      workspacePath,
      workspaceIdentity,
      remoteSessionId,
    },
  );
  const providerSettings = useProviderSettingsServiceView(providerSettingsService);
  const providerNames = useMemo(
    () =>
      buildProviderDisplayNames(
        providerSettings.state.status === "ready" ? providerSettings.state.view.providers : null,
      ),
    [providerSettings.state],
  );
  const pages = Math.max(1, Math.ceil((totalCount ?? 0) / query.pageSize));

  return (
    <TooltipProvider delayDuration={250}>
      <section data-testid="request-logs-section" className="min-w-0 space-y-4" aria-busy={loading}>
        <p className="text-ui-sm text-foreground-subtle">{t("description")}</p>
        <Tabs
          value={query.view}
          onValueChange={(value) => dispatch({ type: "view", value: value as ModelRequestLogView })}
          className="gap-3"
        >
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
              <TabsList variant="line" className="h-8 max-w-full p-0" aria-label={t("title")}>
                {MODEL_REQUEST_LOG_VIEWS.map((view) => (
                  <TabsTrigger
                    key={view}
                    value={view}
                    data-testid={`request-logs-tab-${view}`}
                    className="h-8 gap-1.5 rounded-sm px-2 text-ui-base transition-colors after:bottom-0"
                  >
                    {t(view)}
                    <span
                      data-testid={`request-logs-count-${view}`}
                      className={`rounded-sm bg-surface px-1 text-ui-xs tabular-nums text-foreground-subtle transition-opacity ${
                        loading && counts ? "opacity-60" : ""
                      }`}
                    >
                      {counts?.[view] ?? "—"}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={query.range}
                  onValueChange={(value) =>
                    dispatch({ type: "range", value: value as ModelRequestLogRange })
                  }
                >
                  <SelectTrigger
                    size="lg"
                    // 固定最小宽度：选中项文字长度不同时工具条不横向跳动。
                    className="h-7 min-w-32 rounded-lg"
                    aria-label={t("range")}
                    data-testid="request-logs-range"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    {MODEL_REQUEST_LOG_RANGES.map((range) => (
                      <SelectItem key={range} value={range}>
                        {t(range)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={query.status ?? "all"}
                  onValueChange={(value) =>
                    dispatch({ type: "status", value: value as ModelRequestLogStatus | "all" })
                  }
                >
                  <SelectTrigger
                    size="lg"
                    className="h-7 min-w-32 rounded-lg"
                    aria-label={t("status")}
                    data-testid="request-logs-status"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectItem value="all">{t("allStatuses")}</SelectItem>
                    {MODEL_REQUEST_LOG_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {t(status)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="default"
                  className="rounded-lg"
                  data-testid="request-logs-refresh"
                  disabled={loading || !enabled}
                  onClick={() => void refresh()}
                >
                  <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
                  {intl.formatMessage({ id: "common.refresh" })}
                </Button>
              </div>
            </div>
            {/* 分页固定在工具条第二行右侧。行数与行高不随总数/页数位数、语言或窗口宽度变化，
                表格起始位置因此保持稳定；首帧未拿到总数时也占位，避免加载完成后再挤一次。 */}
            <div
              className="flex h-7 items-center justify-end"
              data-testid="request-logs-pagination-row"
            >
              {totalCount !== null ? (
                <div
                  data-testid="request-logs-pagination"
                  className={`flex items-center gap-1 text-ui-sm text-foreground-subtle transition-opacity ${
                    loading ? "opacity-60" : ""
                  }`}
                >
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    data-testid="request-logs-previous"
                    aria-label={t("previous")}
                    disabled={loading || query.page <= 1}
                    onClick={() => dispatch({ type: "page", value: query.page - 1 })}
                  >
                    <ChevronLeft className="size-4" />
                  </Button>
                  <span aria-live="polite" className="tabular-nums">
                    {intl.formatMessage(
                      { id: "settings.requestLogs.page" },
                      { page: query.page, pages, total: totalCount },
                    )}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    data-testid="request-logs-next"
                    aria-label={t("next")}
                    disabled={loading || query.page >= pages || query.page >= 100_000}
                    onClick={() => dispatch({ type: "page", value: query.page + 1 })}
                  >
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
          {MODEL_REQUEST_LOG_VIEWS.map((view) => (
            <TabsContent key={view} value={view} className="min-h-64 min-w-0">
              {!enabled ? (
                <p role="status" className="py-12 text-center text-ui-base text-foreground-subtle">
                  {t("connecting")}
                </p>
              ) : null}
              {error ? (
                <div
                  role="alert"
                  className="mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-ui-sm"
                >
                  <span>{t("loadError")}</span>
                  <Button variant="outline" disabled={loading} onClick={() => void refresh()}>
                    {intl.formatMessage({ id: "common.retry" })}
                  </Button>
                </div>
              ) : null}
              {enabled && loading && !snapshot ? (
                <p role="status" className="py-12 text-center text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: "common.loading" })}
                </p>
              ) : null}
              {snapshot ? (
                <RequestLogTable
                  snapshot={snapshot}
                  providerNames={providerNames}
                  sortDirection={query.sortDirection}
                  onSort={() => dispatch({ type: "sort" })}
                  loading={loading}
                />
              ) : null}
            </TabsContent>
          ))}
        </Tabs>
      </section>
    </TooltipProvider>
  );
}
