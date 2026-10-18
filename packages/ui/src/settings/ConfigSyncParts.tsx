import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import {
  type ConfigSyncError,
  type ConfigSyncErrorCode,
  type ConfigSyncStatus,
} from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";

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
  if (status.backupCount > 0) {
    items.push(
      intl.formatMessage(
        { id: "settings.configSync.statusBackupCount" },
        { count: status.backupCount },
      ),
    );
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
