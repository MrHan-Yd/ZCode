import { useCallback, useEffect, useState } from "react";
import {
  TID_MODEL_CONFIG_DOWNLOAD,
  TID_MODEL_CONFIG_RESTORE,
  TID_MODEL_CONFIG_UPLOAD,
} from "@zcode/shared";
import type {
  ConfigSyncBackupList,
  ConfigSyncDownloadPlan,
  ConfigSyncSecretWarning,
  ConfigSyncStatus,
} from "@zcode/services";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { describeConfigSyncError } from "@/settings/ConfigSyncParts.js";

/**
 * 模型设置（个人 Provider 配置层）与 GitHub 私有 gist 的同步状态与副作用。
 *
 * 状态是页面局部事实（服务端只给 gistId / 时间 / 是否变化），不进 store；
 * 页面固定消费本机 Local Host，因此不需要像 MCP 页那样额外排除远程 workspace。
 * 条目内容不含 API Key：上传前剥离、下载后补回本机值（见 `specs/model-provider-config-sync.md`）。
 */
export function useProviderConfigSync(options: { onApplied: () => Promise<void> | void }) {
  const { providerSettingsService } = useServices();
  const { intl } = useZCodeIntl();
  const onApplied = options.onApplied;

  const [status, setStatus] = useState<ConfigSyncStatus | null>(null);
  const [phase, setPhase] = useState<"idle" | "uploading" | "previewing" | "applying">("idle");
  const [downloadPlan, setDownloadPlan] = useState<ConfigSyncDownloadPlan | null>(null);
  const [secretWarnings, setSecretWarnings] = useState<readonly ConfigSyncSecretWarning[] | null>(
    null,
  );
  const [restoreBackups, setRestoreBackups] = useState<ConfigSyncBackupList | null>(null);
  const busy = phase !== "idle";

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await providerSettingsService.getConfigSyncStatus());
    } catch (error) {
      logger.warn("[model-provider] read config sync status failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [providerSettingsService]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const upload = useCallback(
    async (params?: { confirmSecretUpload?: boolean }) => {
      setPhase("uploading");
      try {
        const result = await providerSettingsService.syncConfigToGist(params);
        if (result.status === "error") {
          if (result.error.code === "secret_warning") {
            setSecretWarnings(result.error.secretWarnings ?? []);
            return;
          }
          if (result.error.code !== "busy") toast(describeConfigSyncError(intl, result.error));
          return;
        }
        setSecretWarnings(null);
        toast(
          result.status === "unchanged"
            ? intl.formatMessage({ id: "settings.configSync.unchanged" })
            : intl.formatMessage(
                { id: "settings.configSync.uploadedModel" },
                { count: result.itemCount },
              ),
        );
        await loadStatus();
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      } finally {
        setPhase("idle");
      }
    },
    [intl, loadStatus, providerSettingsService],
  );

  const openRestore = useCallback(async () => {
    setPhase("previewing");
    try {
      const backups = await providerSettingsService.listConfigSyncBackups();
      if (backups.backups.length === 0) {
        toast(intl.formatMessage({ id: "settings.configSync.restoreEmpty" }));
        return;
      }
      setRestoreBackups(backups);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setPhase("idle");
    }
  }, [intl, providerSettingsService]);

  const restore = useCallback(
    async (params: { backupDir: string }) => {
      setPhase("applying");
      try {
        const result = await providerSettingsService.restoreConfigSyncBackup(params);
        if (result.status === "error") {
          if (result.error.code !== "busy") toast(describeConfigSyncError(intl, result.error));
          return;
        }
        setRestoreBackups(null);
        toast(
          intl.formatMessage(
            { id: "settings.configSync.restored" },
            { count: result.itemCount ?? 0 },
          ),
        );
        await Promise.all([Promise.resolve(onApplied()), loadStatus()]);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      } finally {
        setPhase("idle");
      }
    },
    [intl, loadStatus, onApplied, providerSettingsService],
  );

  const preview = useCallback(async () => {
    setPhase("previewing");
    try {
      const result = await providerSettingsService.previewConfigFromGist();
      if (result.status === "error") {
        if (result.error.code !== "busy") toast(describeConfigSyncError(intl, result.error));
        return;
      }
      setDownloadPlan(result);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error));
    } finally {
      setPhase("idle");
    }
  }, [intl, providerSettingsService]);

  const apply = useCallback(
    async (params: { strategy: "merge" | "replace" }) => {
      if (!downloadPlan) return;
      setPhase("applying");
      try {
        const result = await providerSettingsService.applyConfigFromGist({
          strategy: params.strategy,
          expectedRemoteRevision: downloadPlan.remoteRevision,
          confirmReplace: params.strategy === "replace",
        });
        if (result.status === "error") {
          if (result.error.code !== "busy") toast(describeConfigSyncError(intl, result.error));
          return;
        }
        setDownloadPlan(null);
        toast(
          result.status === "up_to_date"
            ? intl.formatMessage({ id: "settings.configSync.upToDate" })
            : intl.formatMessage(
                { id: "settings.configSync.downloaded" },
                {
                  added: result.applied.added,
                  updated: result.applied.updated,
                  removed: result.applied.removed,
                  kept: result.applied.kept,
                },
              ),
        );
        await Promise.all([Promise.resolve(onApplied()), loadStatus()]);
      } catch (error) {
        toast(error instanceof Error ? error.message : String(error));
      } finally {
        setPhase("idle");
      }
    },
    [downloadPlan, intl, loadStatus, onApplied, providerSettingsService],
  );

  return {
    status,
    busy,
    downloadPlan,
    secretWarnings,
    restoreBackups,
    upload,
    preview,
    apply,
    openRestore,
    restore,
    cancelDownload: () => setDownloadPlan(null),
    cancelSecret: () => setSecretWarnings(null),
    cancelRestore: () => setRestoreBackups(null),
    testIds: {
      upload: TID_MODEL_CONFIG_UPLOAD,
      download: TID_MODEL_CONFIG_DOWNLOAD,
      restore: TID_MODEL_CONFIG_RESTORE,
    },
  };
}
