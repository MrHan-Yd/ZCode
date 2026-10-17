import { useCallback, useEffect, useState } from "react";
import { ChevronRight, RefreshCw, SlidersHorizontal } from "lucide-react";
import type { ModelSmartConfigEntry, ModelSmartConfigView } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { toast } from "@/components/ui/toast.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import { modelSmartConfigListState } from "@/settings/modelSmartConfigListModel.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

/**
 * 模型智能配置分区：默认只读本地规则文件（不改模型行为），
 * 「从远端仓库同步」才拉取固定 gist 覆盖本地，并触发 provider 刷新使新规则生效。
 *
 * 「已配置规则」列表默认收起：同步回来的规则常有几百条，展开会把设置页撑得很长。
 * 展开状态由 Collapsible 自己持有（组件局部、不落盘），这里不另存一份副本。
 */
export function ModelSmartConfigSection() {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const service = services.modelSmartConfigService;
  const providerSettingsService = services.providerSettingsService;
  const [view, setView] = useState<ModelSmartConfigView | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    if (!service) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setView(await service.read());
    } catch (error) {
      logger.warn("[ModelSmartConfigSection] 读取本地模型智能配置失败", {
        error: getErrorMessage(error),
      });
      toast(intl.formatMessage({ id: "settings.modelSmartConfig.loadFailed" }));
    } finally {
      setLoading(false);
    }
  }, [intl, service]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSync = useCallback(async () => {
    if (!service) {
      return;
    }
    setSyncing(true);
    try {
      const next = await service.syncFromRemote();
      setView(next);
      // 新规则要重新读源才会进入 Registry；不改解析语义，只让它读到新文件。
      await providerSettingsService.refresh("model-smart-config-sync");
      toast(intl.formatMessage({ id: "settings.modelSmartConfig.synced" }));
    } catch (error) {
      logger.warn("[ModelSmartConfigSection] 远端同步失败", {
        error: getErrorMessage(error),
      });
      toast(
        intl.formatMessage(
          { id: "settings.modelSmartConfig.syncFailed" },
          { error: getErrorMessage(error) },
        ),
      );
    } finally {
      setSyncing(false);
    }
  }, [intl, providerSettingsService, service]);

  if (!service) {
    return (
      <p className="text-ui-base leading-6 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelSmartConfig.unavailable" })}
      </p>
    );
  }

  const entries = view?.entries ?? [];
  const listState = modelSmartConfigListState(view);
  const entriesTitle = intl.formatMessage(
    { id: "settings.modelSmartConfig.entriesTitle" },
    { count: entries.length },
  );

  return (
    <div className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.modelSmartConfig.description" })}
      </div>

      <SettingsGroupCard>
        <div className="space-y-3 px-4 py-3">
          <Field
            label={intl.formatMessage({ id: "settings.modelSmartConfig.localPath" })}
            value={view?.filePath ?? ""}
          />
          <Field
            label={intl.formatMessage({ id: "settings.modelSmartConfig.remoteUrl" })}
            value={view?.remoteUrl ?? ""}
          />
          <div className="flex items-center gap-2">
            <Button
              variant="default"
              size="sm"
              disabled={loading || syncing}
              onClick={() => void handleSync()}
              data-testid="model-smart-config-sync"
            >
              <RefreshCw className={syncing ? "size-4 animate-spin" : "size-4"} />
              {intl.formatMessage({ id: "settings.modelSmartConfig.sync" })}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={loading || syncing}
              onClick={() => void load()}
              data-testid="model-smart-config-reload"
            >
              {intl.formatMessage({ id: "settings.modelSmartConfig.reload" })}
            </Button>
          </div>
        </div>
      </SettingsGroupCard>

      <SettingsGroupCard>
        <div className="px-4 py-3" data-testid="model-smart-config-list">
          {listState === "list" ? (
            <Collapsible className="group/model-smart-config-list">
              <CollapsibleTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="default"
                  data-testid="model-smart-config-list-toggle"
                  /*
                   * 直接复用 ghost 变体的状态色：hover 和展开态各有一层 bg-hover 底色，不另外覆盖 aria-expanded。
                   * 负边距 + 加宽让这一行在卡片内左右对称铺满，而不是缩到文字宽度。
                   */
                  className="-mx-2 w-[calc(100%+1rem)] justify-start gap-2 font-medium"
                >
                  <ChevronRight
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-foreground-subtle transition-transform group-data-[state=open]/model-smart-config-list:rotate-90"
                  />
                  {entriesTitle}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="space-y-2 pt-2">
                  {entries.map((entry, index) => (
                    <ModelSmartConfigEntryRow key={entryKey(entry, index)} entry={entry} />
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ) : (
            <div className="space-y-2">
              <div className="text-ui-base font-medium text-foreground">{entriesTitle}</div>
              {view?.error ? (
                <p className="text-ui-base leading-6 text-warning">
                  {intl.formatMessage(
                    { id: "settings.modelSmartConfig.localInvalid" },
                    { error: view.error },
                  )}
                </p>
              ) : (
                <p className="text-ui-base leading-6 text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.modelSmartConfig.empty" })}
                </p>
              )}
            </div>
          )}
        </div>
      </SettingsGroupCard>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-20 shrink-0 text-ui-base text-foreground-subtle">{label}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-ui-base text-foreground" title={value}>
        {value}
      </span>
    </div>
  );
}

function ModelSmartConfigEntryRow({ entry }: { entry: ModelSmartConfigEntry }) {
  const target =
    entry.modelMatch !== undefined
      ? `modelMatch: ${entry.modelMatch}`
      : entry.templateId !== undefined
        ? `${entry.templateId} / ${entry.modelId}`
        : `${entry.providerId} / ${entry.modelId}`;
  return (
    <li className="rounded-lg border border-input-border px-3 py-2">
      <div className="flex items-center gap-2">
        <SlidersHorizontal className="size-3.5 shrink-0 text-foreground-subtle" />
        <span className="min-w-0 flex-1 break-all font-mono text-ui-base text-foreground">
          {target}
        </span>
      </div>
      {describeEntryFields(entry).length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-5.5 font-mono text-ui-base text-foreground-subtle">
          {describeEntryFields(entry).map((field) => (
            <span key={field}>{field}</span>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function entryKey(entry: ModelSmartConfigEntry, index: number): string {
  if (entry.modelMatch !== undefined) return `match:${entry.modelMatch}`;
  if (entry.templateId !== undefined) return `template:${entry.templateId}/${entry.modelId}:${index}`;
  return `exact:${entry.providerId}/${entry.modelId}:${index}`;
}

const FIELD_ORDER: ReadonlyArray<keyof ModelSmartConfigEntry> = [
  "enabled",
  "contextWindow",
  "maxOutputTokens",
  "reasoningLevels",
  "supportsText",
  "supportsImage",
  "supportsVideo",
  "supportsAudio",
  "supportsPdf",
  "supportsToolCall",
  "supportsJsonSchemaOutput",
  "supportsNativeWebSearch",
  "supportsMidConversationSystem",
];

function describeEntryFields(entry: ModelSmartConfigEntry): string[] {
  return FIELD_ORDER.flatMap((key) => {
    const value = entry[key];
    if (value === undefined) return [];
    return [`${key}=${Array.isArray(value) ? value.join("/") : String(value)}`];
  });
}
