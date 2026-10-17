import {
  CloudDownload,
  CloudUpload,
  Download,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCcw,
  SquareArrowRightEnter,
} from "lucide-react";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

interface SettingsResourceHeaderActionsProps {
  onRefresh?: () => void;
  onImport?: () => void;
  onExport?: () => void;
  /** 上传到 GitHub（当前登录账号的私有 gist）。 */
  onUploadToGithub?: () => void;
  /** 从 GitHub 下载并同步到本地。 */
  onDownloadFromGithub?: () => void;
  onNew?: () => void;
  refreshing?: boolean;
  refreshDisabled?: boolean;
  importDisabled?: boolean;
  exportDisabled?: boolean;
  uploadToGithubDisabled?: boolean;
  downloadFromGithubDisabled?: boolean;
  newDisabled?: boolean;
  refreshTestId?: string;
  newTestId?: string;
  uploadToGithubTestId?: string;
  downloadFromGithubTestId?: string;
  refreshLabel?: string;
  newLabel?: string;
  importActionId?: string;
  exportActionId?: string;
  newActionId?: string;
}

export function SettingsResourceHeaderActions({
  onRefresh,
  onImport,
  onExport,
  onUploadToGithub,
  onDownloadFromGithub,
  onNew,
  refreshing = false,
  refreshDisabled = false,
  importDisabled = false,
  exportDisabled = false,
  uploadToGithubDisabled = false,
  downloadFromGithubDisabled = false,
  newDisabled = false,
  refreshTestId,
  newTestId,
  uploadToGithubTestId,
  downloadFromGithubTestId,
  refreshLabel,
  newLabel: customNewLabel,
  importActionId,
  exportActionId,
  newActionId,
}: SettingsResourceHeaderActionsProps) {
  const { intl } = useZCodeIntl();
  const resolvedRefreshLabel = refreshLabel ?? intl.formatMessage({ id: "common.refresh" });
  const importLabel = intl.formatMessage({
    id: "settings.resourceActions.import",
  });
  const exportLabel = intl.formatMessage({
    id: "settings.resourceActions.export",
  });
  const uploadToGithubLabel = intl.formatMessage({
    id: "settings.resourceActions.uploadToGithub",
  });
  const downloadFromGithubLabel = intl.formatMessage({
    id: "settings.resourceActions.downloadFromGithub",
  });
  const moreActionsLabel = intl.formatMessage({
    id: "settings.resourceActions.more",
  });
  const newLabel = customNewLabel ?? intl.formatMessage({ id: "settings.create.action" });
  const hasGithubActions = Boolean(onUploadToGithub || onDownloadFromGithub);
  const hasOverflowActions = Boolean(onImport || onExport) || hasGithubActions;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {hasOverflowActions ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="outline" size="icon-md" aria-label={moreActionsLabel}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onImport ? (
              <DropdownMenuItem
                data-settings-import-action={importActionId}
                disabled={importDisabled}
                onSelect={onImport}
              >
                <SquareArrowRightEnter aria-hidden="true" />
                {importLabel}
              </DropdownMenuItem>
            ) : null}
            {onExport ? (
              <DropdownMenuItem
                data-settings-export-action={exportActionId}
                disabled={exportDisabled}
                onSelect={onExport}
              >
                <Download aria-hidden="true" />
                {exportLabel}
              </DropdownMenuItem>
            ) : null}
            {/* 本地文件（导入/导出）与远端同步（GitHub）语义不同，用分隔线分开，避免误当成同一类操作。 */}
            {hasGithubActions && (onImport || onExport) ? <DropdownMenuSeparator /> : null}
            {onUploadToGithub ? (
              <DropdownMenuItem
                data-settings-sync-action="upload"
                data-testid={uploadToGithubTestId}
                disabled={uploadToGithubDisabled}
                onSelect={onUploadToGithub}
              >
                <CloudUpload aria-hidden="true" />
                {uploadToGithubLabel}
              </DropdownMenuItem>
            ) : null}
            {onDownloadFromGithub ? (
              <DropdownMenuItem
                data-settings-sync-action="download"
                data-testid={downloadFromGithubTestId}
                disabled={downloadFromGithubDisabled}
                onSelect={onDownloadFromGithub}
              >
                <CloudDownload aria-hidden="true" />
                {downloadFromGithubLabel}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {onRefresh ? (
        <ControlHintTooltip title={resolvedRefreshLabel}>
          <Button
            type="button"
            variant="outline"
            size="icon-md"
            aria-label={resolvedRefreshLabel}
            data-testid={refreshTestId}
            disabled={refreshDisabled || refreshing}
            onClick={onRefresh}
          >
            {refreshing ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCcw aria-hidden="true" />
            )}
          </Button>
        </ControlHintTooltip>
      ) : null}
      {onNew ? (
        <Button
          type="button"
          variant="default"
          size="default"
          className="rounded-lg"
          data-settings-create-action={newActionId}
          aria-label={newLabel}
          data-testid={newTestId}
          disabled={newDisabled}
          onClick={onNew}
        >
          <Plus data-icon="inline-start" aria-hidden="true" />
          {newLabel}
        </Button>
      ) : null}
    </div>
  );
}
