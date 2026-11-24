import { useState } from "react";
import { ChevronDownIcon, NetworkIcon } from "lucide-react";
import {
  TID_V4_COMPOSER_ORCHESTRATION_PICKER_TRIGGER,
  TID_V4_COMPOSER_ORCHESTRATION_TRIGGER,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/components/lib/utils.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useMediaQuery } from "@/hooks/useMediaQuery.js";
import type { OrchestrationComposerControls } from "@/v4/composer/OrchestrationControls.js";
import { hasSelectedOrchestrationRole } from "@/v4/composer/orchestrationTeamModel.js";
import { OrchestrationTeamPicker } from "@/v4/composer/OrchestrationTeamPicker.js";

/**
 * 复合触发器：主按钮切开关，chevron 打开团队选择器。
 *
 * 两半共用一个 segmented shell（DESIGN.md「主操作在左、菜单在右」），读起来是一个控件。
 * 开关状态靠外壳底色区分：开启是品牌色底 + 品牌色文字，关闭保持中性；不能只靠 tooltip，
 * 否则没有活动 run 时两种状态在视觉上完全一样。
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

  const enabled = controls.enabled;
  const label = intl.formatMessage({ id: "chat.orchestration.trigger.label" });
  const tooltip = intl.formatMessage({
    id: enabled ? "chat.orchestration.trigger.tooltipOn" : "chat.orchestration.trigger.tooltipOff",
  });
  const teamTooltip = intl.formatMessage({ id: "chat.orchestration.trigger.team" });
  const activeRunCount = controls.activeRuns.length;

  // 外壳承载 hover/底色，两段按钮自身透明；否则两半各自 hover 会重新看成两个按钮。
  // 面板打开时外壳保持高亮，替代按钮自带的 aria-expanded 底色（那会在品牌色底上糊一块灰）。
  const shellClassName = cn(
    "group/orchestration flex min-w-0 items-center overflow-hidden rounded-lg transition-colors",
    enabled && (pickerOpen ? "bg-brand/20" : "bg-brand/15"),
    !enabled && pickerOpen && "bg-hover",
    !disabled && !pickerOpen && (enabled ? "hover:bg-brand/20" : "hover:bg-hover"),
  );
  const segmentClassName = cn(
    "h-7 rounded-none text-ui-base hover:bg-transparent aria-expanded:bg-transparent",
    enabled ? "font-medium text-brand hover:text-brand" : "text-foreground",
  );

  const chevronButton = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled}
      onClick={() => setPickerOpen(true)}
      data-testid={TID_V4_COMPOSER_ORCHESTRATION_PICKER_TRIGGER}
      aria-label={teamTooltip}
      className={cn(segmentClassName, "px-1")}
    >
      <ChevronDownIcon className="size-3.5" aria-hidden />
    </Button>
  );

  return (
    <>
      <div className={shellClassName} data-composer-collapse-priority="4">
        <ControlHintTooltip title={tooltip}>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              // 开启时没有任何专业角色（含首次开启与清空后重开）需要先补选角色，
              // 不能停留在一个“开着但零角色”的状态；有专业选择时不再自动弹。
              if (!enabled && !hasSelectedOrchestrationRole(controls.team)) setPickerOpen(true);
              controls.onToggleEnabled();
            }}
            data-testid={TID_V4_COMPOSER_ORCHESTRATION_TRIGGER}
            data-orchestration-enabled={enabled ? "true" : "false"}
            data-orchestration-active-runs={activeRunCount}
            aria-pressed={enabled}
            aria-label={tooltip}
            className={cn(
              segmentClassName,
              "gap-1 px-2",
              "group-data-[composer-compact=true]/orchestration:w-7 group-data-[composer-compact=true]/orchestration:px-0",
            )}
          >
            <NetworkIcon className="size-4 shrink-0" aria-hidden />
            <span className="inline whitespace-nowrap group-data-[composer-compact=true]/orchestration:hidden">
              {label}
            </span>
            {/* 活动 run 数不再画在这里：它是运行态而非配置态，统一由输入框后台徽标与
                常驻编排状态条表达，避免「编排 1」被读成团队人数。 */}
          </Button>
        </ControlHintTooltip>
        <span
          role="separator"
          aria-orientation="vertical"
          className={cn("h-3.5 w-px shrink-0", enabled ? "bg-brand/30" : "bg-border")}
        />
        {isMobile ? (
          <ControlHintTooltip title={teamTooltip}>{chevronButton}</ControlHintTooltip>
        ) : (
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <ControlHintTooltip title={teamTooltip} open={pickerOpen ? false : undefined}>
              <PopoverTrigger asChild>{chevronButton}</PopoverTrigger>
            </ControlHintTooltip>
            <PopoverContent
              align="start"
              side="top"
              sideOffset={6}
              // 专业角色的内容高度会超过 composer 上方空间；不给上限时面板会顶出窗口，
              // 列表的 overflow-y-auto 因为没有受限高度而不生效。用 Radix 暴露的可视区高度
              // 让面板整体收缩，内层列表才成为唯一滚动区。
              className="max-h-(--radix-popover-content-available-height) w-[min(448px,calc(100vw-2rem))] gap-2.5 p-3"
            >
              <OrchestrationTeamPicker
                team={controls.team}
                roles={controls.roles}
                onToggleRole={controls.onToggleRole}
                onToggleSelectAll={controls.onToggleSelectAll}
                onApplyPreset={controls.onApplyPreset}
                onOpenRoleSettings={(role) => {
                  setPickerOpen(false);
                  controls.onOpenRoleSettings(role);
                }}
              />
            </PopoverContent>
          </Popover>
        )}
      </div>
      {isMobile ? (
        <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
          <DialogContent
            showCloseButton
            className="fixed inset-x-0 bottom-0 top-auto left-0 flex max-h-[80dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col overflow-hidden rounded-b-none rounded-t-2xl"
          >
            <DialogTitle className="sr-only">
              {intl.formatMessage({ id: "chat.orchestration.picker.title" })}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {intl.formatMessage({ id: "chat.orchestration.picker.description" })}
            </DialogDescription>
            <OrchestrationTeamPicker
              team={controls.team}
              roles={controls.roles}
              onToggleRole={controls.onToggleRole}
              onToggleSelectAll={controls.onToggleSelectAll}
              onApplyPreset={controls.onApplyPreset}
              onOpenRoleSettings={(role) => {
                setPickerOpen(false);
                controls.onOpenRoleSettings(role);
              }}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}
