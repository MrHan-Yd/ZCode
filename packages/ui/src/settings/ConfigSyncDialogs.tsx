import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  countPlanEntries,
  type ConfigSyncBackupInfo,
  type ConfigSyncBackupList,
  type ConfigSyncDownloadPlan,
  type ConfigSyncPlanEntryKind,
  type ConfigSyncSecretWarning,
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
 * 配置同步的确认弹窗：下载计划、疑似密钥、从备份还原。
 * 子智能体与 MCP 服务器共用；状态与副作用留在各自设置分区里，这里只回传用户选择。
 */
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

/**
 * 「从备份还原」弹窗：列出可用备份（时间 + 条目数），并说明这是整份覆盖、且还原前会先备份当前状态。
 * 备份目录路径一并展示，方便用户自己去看/拷贝。
 */
export function ConfigSyncRestoreDialog({
  backups,
  restoring,
  onCancel,
  onConfirm,
  testId,
  optionTestId,
}: {
  backups: ConfigSyncBackupList;
  restoring: boolean;
  onCancel: () => void;
  onConfirm: (params: { backupDir: string }) => void;
  testId: string;
  optionTestId: string;
}) {
  const { intl, locale } = useZCodeIntl();
  const [selected, setSelected] = useState<string | null>(null);
  const dateTimeFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }),
    [locale],
  );

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="max-w-lg" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.configSync.restoreTitle" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "settings.configSync.restoreDescription" })}
          </DialogDescription>
        </DialogHeader>
        <p className="break-all font-mono text-ui-sm text-foreground-subtle">
          {backups.backupRoot}
        </p>
        <ul className="max-h-64 space-y-1 overflow-auto rounded-lg border border-border bg-surface px-3 py-2">
          {backups.backups.map((backup) => (
            <li key={backup.backupDir}>
              <label className="flex cursor-pointer items-center gap-2 text-ui-base text-foreground">
                <input
                  type="radio"
                  name="config-sync-restore-backup"
                  className="size-4"
                  data-testid={optionTestId}
                  checked={selected === backup.backupDir}
                  onChange={() => setSelected(backup.backupDir)}
                />
                <span>{dateTimeFormatter.format(new Date(backup.createdAt))}</span>
                <span className="text-foreground-subtle">{describeBackupItems(intl, backup)}</span>
              </label>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={restoring}>
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
          <Button
            type="button"
            variant="default"
            disabled={restoring || selected === null}
            onClick={() => {
              if (selected) onConfirm({ backupDir: selected });
            }}
          >
            {restoring ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {intl.formatMessage({ id: "settings.configSync.restoreConfirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function describeBackupItems(intl: IntlInstance, backup: ConfigSyncBackupInfo): string {
  return backup.itemCount === null
    ? intl.formatMessage({ id: "settings.configSync.restoreItemCountUnknown" })
    : intl.formatMessage(
        { id: "settings.configSync.restoreItemCount" },
        { count: backup.itemCount },
      );
}
