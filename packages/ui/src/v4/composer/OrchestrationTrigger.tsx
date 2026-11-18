import { useState } from "react";
import { ChevronDownIcon, NetworkIcon } from "lucide-react";
import {
  TID_V4_COMPOSER_ORCHESTRATION_PICKER_TRIGGER,
  TID_V4_COMPOSER_ORCHESTRATION_TRIGGER,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent } from "@/components/ui/dialog.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useMediaQuery } from "@/hooks/useMediaQuery.js";
import type { OrchestrationComposerControls } from "@/v4/composer/OrchestrationControls.js";
import { OrchestrationTeamPicker } from "@/v4/composer/OrchestrationTeamPicker.js";

/**
 * 复合触发器：主按钮切开关，chevron 打开团队选择器。
 *
 * 开关与团队都只改草稿意图；SessionPane 在发送前决定是否下发 setOrchestration。
 * 运行中的 run 不因关闭而取消（取消只走时间线按钮或 interrupt 发送语义）。
 */
export function OrchestrationTrigger({
  controls,
  disabled,
}: {
  controls: OrchestrationComposerControls;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const [pickerOpen, setPickerOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 640px)");
  if (!controls.available) return null;

  const label = intl.formatMessage({ id: "chat.orchestration.trigger.label" });
  const tooltip = intl.formatMessage({
    id: controls.enabled
      ? "chat.orchestration.trigger.tooltipOn"
      : "chat.orchestration.trigger.tooltipOff",
  });
  const activeRunCount = controls.activeRuns.length;

  return (
    <div className="flex min-w-0 items-center">
      <ControlHintTooltip title={tooltip}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={() => {
            // 首次开启且还没有团队时直接打开选择器；已有团队则只切开关。
            if (!controls.enabled && controls.team.length === 0) setPickerOpen(true);
            controls.onToggleEnabled();
          }}
          data-testid={TID_V4_COMPOSER_ORCHESTRATION_TRIGGER}
          data-orchestration-enabled={controls.enabled ? "true" : "false"}
          data-orchestration-active-runs={activeRunCount}
          data-composer-collapse-priority="4"
          aria-pressed={controls.enabled}
          aria-label={tooltip}
          className="group/orchestration h-7 gap-1 rounded-lg px-2 text-ui-base data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
        >
          <NetworkIcon className="size-4 shrink-0" aria-hidden />
          <span className="inline whitespace-nowrap group-data-[composer-compact=true]/orchestration:hidden">
            {label}
          </span>
          {controls.enabled && activeRunCount > 0 ? (
            <span className="rounded-full bg-brand/15 px-1.5 text-ui-xs text-brand tabular-nums">
              {activeRunCount}
            </span>
          ) : null}
        </Button>
      </ControlHintTooltip>
      {isMobile ? (
        <ControlHintTooltip title={intl.formatMessage({ id: "chat.orchestration.trigger.team" })}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => setPickerOpen(true)}
            data-testid={TID_V4_COMPOSER_ORCHESTRATION_PICKER_TRIGGER}
            aria-label={intl.formatMessage({ id: "chat.orchestration.trigger.team" })}
            className="h-7 rounded-lg px-1 text-ui-base"
          >
            <ChevronDownIcon className="size-3.5" aria-hidden />
          </Button>
        </ControlHintTooltip>
      ) : (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <ControlHintTooltip
            title={intl.formatMessage({ id: "chat.orchestration.trigger.team" })}
            open={pickerOpen ? false : undefined}
          >
            <PopoverTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                data-testid={TID_V4_COMPOSER_ORCHESTRATION_PICKER_TRIGGER}
                aria-label={intl.formatMessage({ id: "chat.orchestration.trigger.team" })}
                className="h-7 rounded-lg px-1 text-ui-base"
              >
                <ChevronDownIcon className="size-3.5" aria-hidden />
              </Button>
            </PopoverTrigger>
          </ControlHintTooltip>
          <PopoverContent
            align="start"
            side="top"
            sideOffset={6}
            className="w-[min(448px,calc(100vw-2rem))] gap-2.5 p-3"
          >
            <OrchestrationTeamPicker
              team={controls.team}
              roles={controls.roles}
              onToggleRole={controls.onToggleRole}
              onApplyPreset={controls.onApplyPreset}
              onOpenRoleSettings={(role) => {
                setPickerOpen(false);
                controls.onOpenRoleSettings(role);
              }}
            />
          </PopoverContent>
        </Popover>
      )}
      {isMobile ? (
        <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
          <DialogContent
            showCloseButton
            className="fixed inset-x-0 bottom-0 top-auto left-0 max-h-[80vh] w-full max-w-none translate-x-0 translate-y-0 grid-rows-[auto] overflow-y-auto rounded-b-none rounded-t-2xl"
          >
            <OrchestrationTeamPicker
              team={controls.team}
              roles={controls.roles}
              onToggleRole={controls.onToggleRole}
              onApplyPreset={controls.onApplyPreset}
              onOpenRoleSettings={(role) => {
                setPickerOpen(false);
                controls.onOpenRoleSettings(role);
              }}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
