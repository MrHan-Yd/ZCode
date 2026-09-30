/**
 * 设置页的「提交消息模型」一行。
 *
 * 默认跟随当前会话模型；钉住一个固定模型后，生成提交消息不再看当前会话。
 * 这里只负责读写 AppSettings.gitCommitMessageModelSelection；解析顺序（设置 > 会话 > Host 默认）
 * 在 GitActionMenu 生成提交消息时统一执行，服务层不重复判断。
 */
import { memo, useCallback, useMemo } from "react";
import { ZCODE_AGENT_PROVIDER, TID_GIT_COMMIT_MESSAGE_MODEL_TRIGGER, type ModelSelection } from "@zcode/shared";
import { ModelConfigSelect, type ModelSelectFooterAction } from "@/ModelConfigSelect.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  buildRegistryModelSelectGroups,
  resolveModelDisplayName,
} from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 「跟随当前会话」哨兵值。它不是合法 ModelSelection，只存在于这个控件的值域；
 * 选中它写回 null 清除覆盖（不能用 undefined：RPC 传输会吞掉 undefined）。
 */
const INHERIT_MODEL_VALUE = "inherit";

/** 提交消息模型不参与任何锁定语义；用具名常量而不是每次 render 新建闭包，保住选择器的 memo。 */
const MODEL_ITEM_NEVER_LOCKED = () => false;

export const GitCommitMessageModelRow = memo(function GitCommitMessageModelRow() {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const { modelSelectionService } = useBaseWorkspaceServices();
  // 设置页只配置 Local Environment 的模型候选，与 Subagent 设置同一来源。
  const modelSelectionRead = useModelSelectionServiceView(modelSelectionService);
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;

  const modelGroups = useMemo(() => {
    if (!modelSelectionView) return [];
    return buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, modelSelectionView, {
      startPlanBadgeLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.startPlanBadge",
      }),
      apiKeyLabel: intl.formatMessage({
        id: "settings.modelProvider.apiKey",
      }),
      codingPlanLabel: intl.formatMessage({
        id: "settings.modelProvider.connectionMode.codingPlan",
      }),
    });
  }, [intl, modelSelectionView]);

  const pinnedSelection = settings?.gitCommitMessageModelSelection ?? null;
  const value = pinnedSelection
    ? encodeCustomModelValue(pinnedSelection.providerId, pinnedSelection.modelId)
    : INHERIT_MODEL_VALUE;

  const handleValueChange = useCallback(
    (nextValue: string) => {
      if (nextValue === INHERIT_MODEL_VALUE) {
        void update({ gitCommitMessageModelSelection: null });
        return;
      }
      const decoded = decodeCustomModelValue(nextValue);
      if (!decoded?.providerId?.trim() || !decoded.modelName?.trim()) {
        return;
      }
      const selection: ModelSelection = {
        providerId: decoded.providerId.trim(),
        modelId: decoded.modelName.trim(),
      };
      void update({ gitCommitMessageModelSelection: selection });
    },
    [update],
  );

  const inheritLabel = intl.formatMessage({ id: "settings.gitCommitMessageModel.followSession" });
  const triggerLabel = pinnedSelection
    ? (resolveModelDisplayName(modelGroups, value) ?? `${pinnedSelection.providerId} / ${pinnedSelection.modelId}`)
    : inheritLabel;

  // 与 Subagent 的「内置默认」一致：跟随会话作为可回到的默认项，而不是普通候选模型。
  const footerActions = useMemo<ModelSelectFooterAction[]>(
    () => [
      {
        key: "git-commit-message-model:follow-session",
        label: inheritLabel,
        onSelect: () => handleValueChange(INHERIT_MODEL_VALUE),
        selected: value === INHERIT_MODEL_VALUE,
      },
    ],
    [handleValueChange, inheritLabel, value],
  );

  const label = intl.formatMessage({ id: "settings.gitCommitMessageModel" });

  return (
    <SettingsRow
      label={label}
      description={intl.formatMessage({ id: "settings.gitCommitMessageModelDescription" })}
      control={
        <ModelConfigSelect
          modelGroups={modelGroups}
          normalizedValue={value}
          triggerLabel={triggerLabel}
          showManageModelsAction={false}
          lockReasonMessage=""
          isItemLocked={MODEL_ITEM_NEVER_LOCKED}
          onValueChange={handleValueChange}
          footerActions={footerActions}
          manageModelsLabel={intl.formatMessage({ id: "chat.toolbar.model.manageModels" })}
          contentSide="bottom"
          contentAlign="end"
          focusSelectorOnClose={null}
          labelVisibilityClassName="inline-flex min-w-0"
          triggerClassName="h-8 w-fit max-w-56 min-w-0 justify-between rounded-lg border border-input-border bg-input px-3 py-1.5 text-foreground hover:border-input-border-hover hover:bg-input focus-visible:border-input-border-focused focus-visible:bg-input-focused"
          triggerLabelClassName="inline-flex min-w-0 truncate text-left"
          triggerTestId={TID_GIT_COMMIT_MESSAGE_MODEL_TRIGGER}
          disabled={modelSelectionView === null}
        />
      }
    />
  );
});
