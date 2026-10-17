import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  countPlanEntries,
  type ConfigSyncError,
  type ConfigSyncErrorCode,
  type ConfigSyncDownloadPlan,
  type ConfigSyncPlanEntryKind,
  type ConfigSyncSecretWarning,
  type ConfigSyncStatus,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";

/** 计划里最多逐条列出多少个文件；再多的部分只报数量，避免弹窗被几百条规则撑爆。 */
const MAX_PLAN_ENTRIES = 50;

/**
 * 同步失败文案：句子按 code 本地化，服务返回的 message 只作技术细节填进 `{detail}`。
 * 与 `ModelSmartConfigSection` 处理 `view.error` 的方式一致：服务侧细节不翻译，模板走 i18n。
 */
const CONFIG_SYNC_MESSAGE_KEYS: Record<ConfigSyncErrorCode, string> = {
  not_authenticated: "settings.configSync.notLoggedIn",
  unauthorized: "settings.configSync.unauthorized",
  insufficient_scope: "settings.configSync.insufficientScope",
  not_found: "settings.configSync.notFound",
  rate_limited: "settings.configSync.rateLimited",
  network: "settings.configSync.networkError",
  timeout: "settings.configSync.timeout",
  remote_invalid: "settings.configSync.remoteInvalid",
  too_large: "settings.configSync.tooLarge",
  local_invalid: "settings.configSync.localInvalid",
  conflict: "settings.configSync.conflict",
  busy: "settings.configSync.busy",
  secret_warning: "settings.configSync.secretWarning",
  unknown: "settings.configSync.failed",
};

export function describeConfigSyncError(intl: IntlInstance, error: ConfigSyncError): string {
  return intl.formatMessage(
    { id: CONFIG_SYNC_MESSAGE_KEYS[error.code] },
    { detail: error.message },
  );
}

export function describeStateChange(
  intl: IntlInstance,
  change: {
    disabledAdded: readonly string[];
    disabledRemoved: readonly string[];
    overrideKeysChanged: readonly string[];
  },
): string | undefined {
  const count =
    change.disabledAdded.length + change.disabledRemoved.length + change.overrideKeysChanged.length;
  return count > 0
    ? intl.formatMessage({ id: "settings.configSync.stateChangeSummary" }, { count })
    : undefined;
}

/**
 * 配置同步（GitHub 私有 gist）的共用界面：状态行 + 下载确认弹窗 + 疑似密钥确认弹窗。
 * 子智能体与 MCP 服务器共用这套渲染；状态与副作用留在各自设置分区里，这里只回传用户选择。
 */
export function ConfigSyncStatusRow({
  status,
  busy,
  onOpenSyncConfigSettings,
  testId,
  goLoginTestId,
}: {
  status: ConfigSyncStatus;
  busy: boolean;
  onOpenSyncConfigSettings?: () => void;
  testId: string;
  goLoginTestId?: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const dateTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }),
    [locale],
  );

  const items: string[] = [];
  if (status.lastSyncedAt !== undefined) {
    items.push(
      intl.formatMessage(
        { id: "settings.configSync.statusLastSynced" },
        { time: dateTimeFormatter.format(new Date(status.lastSyncedAt)) },
      ),
    );
  }
  if (status.localChangedSinceLastSync) {
    items.push(intl.formatMessage({ id: "settings.configSync.statusLocalChanged" }));
  }
  if (status.skippedLocalFiles.length > 0) {
    items.push(
      intl.formatMessage(
        { id: "settings.configSync.statusSkippedLocal" },
        { count: status.skippedLocalFiles.length },
      ),
    );
  }

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface px-3 py-2 text-ui-base text-foreground-subtle"
      data-testid={testId}
    >
      {busy ? (
        <span className="inline-flex items-center gap-1.5 text-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          {intl.formatMessage({ id: "settings.configSync.inProgress" })}
        </span>
      ) : null}
      {!status.connected ? (
        <>
          <span>{intl.formatMessage({ id: "settings.configSync.statusNotConnected" })}</span>
          {onOpenSyncConfigSettings ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-5 px-0 text-ui-base"
              data-testid={goLoginTestId}
              onClick={onOpenSyncConfigSettings}
            >
              {intl.formatMessage({ id: "settings.configSync.goToLogin" })}
            </Button>
          ) : null}
        </>
      ) : (
        <>
          {status.gistIdShort ? (
            <a
              className="font-mono text-foreground hover:underline"
              href={status.gistUrl}
              rel="noreferrer"
              target="_blank"
            >
              {intl.formatMessage(
                { id: "settings.configSync.statusGist" },
                { id: status.gistIdShort },
              )}
            </a>
          ) : (
            <span>{intl.formatMessage({ id: "settings.configSync.statusNoGist" })}</span>
          )}
          {items.map((item) => (
            <span key={item}>{item}</span>
          ))}
        </>
      )}
    </div>
  );
}

export function ConfigSyncDownloadDialog({
  plan,
  applying,
  extraSummary,
  onCancel,
  onConfirm,
  testId,
  replaceAckTestId,
}: {
  plan: ConfigSyncDownloadPlan;
  applying: boolean;
  /** 功能自己的额外变更摘要（子智能体：启用状态与模型覆盖）；没有就不渲染。 */
  extraSummary?: string;
  onCancel: () => void;
  onConfirm: (params: { strategy: "merge" | "replace" }) => void;
  testId: string;
  replaceAckTestId: string;
}) {
  const { intl } = useZCodeIntl();
  // 由父组件按需挂载，勾选状态随弹窗关闭一起消失，不会把上一次的「镜像远端」带到下一次。
  const [mirrorRemote, setMirrorRemote] = useState(false);

  const counts = countPlanEntries(plan.entries);
  const listed = plan.entries.filter((entry) => entry.kind !== "same");
  const localOnlyCount = counts.localOnly;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-lg" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.configSync.downloadTitle" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage(
              { id: "settings.configSync.downloadSummary" },
              {
                revision: plan.remoteRevision,
                added: counts.add,
                updated: counts.update,
                localOnly: counts.localOnly,
                same: counts.same,
              },
            )}
          </DialogDescription>
        </DialogHeader>

        {extraSummary ? (
          <p className="text-ui-base text-foreground-subtle">{extraSummary}</p>
        ) : null}
        {plan.localChangedSinceLastSync ? (
          <p className="text-ui-base text-warning">
            {intl.formatMessage({ id: "settings.configSync.localChangedWarning" })}
          </p>
        ) : null}
        {plan.remoteSkipped.length > 0 ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.configSync.remoteSkipped" },
              { count: plan.remoteSkipped.length },
            )}
          </p>
        ) : null}

        {listed.length > 0 ? (
          <ul className="max-h-64 space-y-1 overflow-auto rounded-lg border border-border bg-surface px-3 py-2">
            {listed.slice(0, MAX_PLAN_ENTRIES).map((entry) => (
              <li key={entry.name} className="flex items-center justify-between gap-3">
                <span className="min-w-0 flex-1 truncate font-mono text-ui-base text-foreground">
                  {entry.name}
                </span>
                <span className="shrink-0 text-ui-base text-foreground-subtle">
                  {intl.formatMessage({ id: planEntryLabelId(entry.kind) })}
                </span>
              </li>
            ))}
            {listed.length > MAX_PLAN_ENTRIES ? (
              <li className="text-ui-base text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.configSync.planMore" },
                  { count: listed.length - MAX_PLAN_ENTRIES },
                )}
              </li>
            ) : null}
          </ul>
        ) : null}

        {localOnlyCount > 0 ? (
          <label className="inline-flex cursor-pointer items-start gap-2 text-ui-base text-foreground">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              data-testid={replaceAckTestId}
              checked={mirrorRemote}
              onChange={(event) => setMirrorRemote(event.currentTarget.checked)}
            />
            <span>
              {intl.formatMessage(
                { id: "settings.configSync.replaceAck" },
                { count: localOnlyCount },
              )}
            </span>
          </label>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={applying}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            variant="default"
            disabled={applying}
            onClick={() => onConfirm({ strategy: mirrorRemote ? "replace" : "merge" })}
          >
            {applying ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {intl.formatMessage({ id: "settings.configSync.confirmDownload" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConfigSyncSecretWarningDialog({
  warnings,
  uploading,
  onCancel,
  onConfirm,
  testId,
}: {
  warnings: readonly ConfigSyncSecretWarning[];
  uploading: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  testId: string;
}) {
  const { intl } = useZCodeIntl();

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-lg" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "settings.configSync.secretTitle" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.configSync.secretDescription" })}
          </DialogDescription>
        </DialogHeader>
        {/* 只列位置与规则名：命中值既不上屏也不进日志。 */}
        <ul className="max-h-48 space-y-1 overflow-auto rounded-lg border border-border bg-surface px-3 py-2 font-mono text-ui-base text-foreground">
          {warnings.map((warning) => (
            <li key={`${warning.fileName}:${warning.line}:${warning.pattern}`}>
              {warning.fileName}:{warning.line} · {warning.pattern}
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={uploading}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button type="button" variant="default" disabled={uploading} onClick={onConfirm}>
            {uploading ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {intl.formatMessage({ id: "settings.configSync.secretConfirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function planEntryLabelId(kind: ConfigSyncPlanEntryKind): string {
  switch (kind) {
    case "add":
      return "settings.configSync.planAdd";
    case "update":
      return "settings.configSync.planUpdate";
    case "localOnly":
      return "settings.configSync.planLocalOnly";
    default:
      return "settings.configSync.planSame";
  }
}
