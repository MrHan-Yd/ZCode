import { useMemo, useState } from "react";
import { CheckIcon, Settings2Icon, SparklesIcon } from "lucide-react";
import {
  TID_V4_ORCHESTRATION_TEAM_PICKER,
  TID_V4_ORCHESTRATION_TEAM_ROLE,
  testId,
} from "@zcode/shared";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import {
  ORCHESTRATION_TEAM_PRESETS,
  describeOrchestrationRoleModel,
  filterOrchestrationRoles,
  getOrchestrationTeamLimits,
  matchOrchestrationPreset,
  orchestrationTeamSizeNotice,
  type OrchestrationRoleView,
  type OrchestrationTeamPreset,
} from "@/v4/composer/orchestrationTeamModel.js";

export interface OrchestrationTeamPickerProps {
  team: readonly string[];
  roles: readonly OrchestrationRoleView[];
  onToggleRole: (role: string) => void;
  onApplyPreset: (preset: OrchestrationTeamPreset) => void;
  onOpenRoleSettings: (role?: string) => void;
}

/**
 * 团队选择器内容。桌面由 Popover 承载、手机由 bottom sheet 承载；两者共用这一份
 * 渲染与纯模型（预设/搜索/上限/不可用态）。
 */
export function OrchestrationTeamPicker({
  team,
  roles,
  onToggleRole,
  onApplyPreset,
  onOpenRoleSettings,
}: OrchestrationTeamPickerProps) {
  const { intl } = useZCodeIntl();
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(team), [team]);
  const presetId = matchOrchestrationPreset(team);
  const visibleRoles = useMemo(() => filterOrchestrationRoles(roles, query), [query, roles]);
  const sizeNotice = orchestrationTeamSizeNotice(team);
  const limits = getOrchestrationTeamLimits();

  return (
    <div data-testid={TID_V4_ORCHESTRATION_TEAM_PICKER} className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "chat.orchestration.picker.title" })}
        </h3>
        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "chat.orchestration.picker.description" })}
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {ORCHESTRATION_TEAM_PRESETS.map((preset) => (
          <Button
            key={preset.id}
            type="button"
            size="sm"
            variant={presetId === preset.id ? "secondary" : "ghost"}
            className="h-7 rounded-lg px-2 text-ui-sm"
            onClick={() => onApplyPreset(preset)}
            title={intl.formatMessage({ id: preset.descriptionKey })}
          >
            <SparklesIcon className="size-3.5" aria-hidden />
            {intl.formatMessage({ id: preset.labelKey })}
          </Button>
        ))}
      </div>

      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={intl.formatMessage({ id: "chat.orchestration.picker.search" })}
        aria-label={intl.formatMessage({ id: "chat.orchestration.picker.search" })}
        className="h-8"
      />

      <div className="flex min-h-0 flex-col gap-1 overflow-y-auto pr-0.5">
        {visibleRoles.map((role) => {
          const checked = selected.has(role.name);
          const model = describeOrchestrationRoleModel(role);
          return (
            <div
              key={role.name}
              data-testid={testId(TID_V4_ORCHESTRATION_TEAM_ROLE, role.name)}
              className={cn(
                "group flex min-h-11 items-start gap-2.5 rounded-lg px-2 py-1.5",
                checked ? "bg-selected" : "hover:bg-hover",
                !role.available && "opacity-60",
              )}
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={checked}
                aria-label={role.name}
                disabled={!role.available}
                onClick={() => onToggleRole(role.name)}
                className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border border-input-border bg-input text-foreground-inverse disabled:cursor-not-allowed"
              >
                {checked ? <CheckIcon className="size-3" aria-hidden /> : null}
              </button>
              <button
                type="button"
                disabled={!role.available}
                onClick={() => onToggleRole(role.name)}
                className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left disabled:cursor-not-allowed"
              >
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-ui-base text-foreground">{role.name}</span>
                  {role.canWrite ? (
                    <Badge variant="secondary" className="h-4 px-1 text-ui-xs">
                      {intl.formatMessage({ id: "chat.orchestration.picker.writable" })}
                    </Badge>
                  ) : null}
                  {!role.available ? (
                    <Badge variant="outline" className="h-4 px-1 text-ui-xs">
                      {intl.formatMessage({ id: "chat.orchestration.picker.unavailable" })}
                    </Badge>
                  ) : null}
                </span>
                <span className="line-clamp-2 text-ui-sm text-foreground-subtle">
                  {role.description}
                </span>
                <span className="flex flex-wrap items-center gap-1 text-ui-xs text-foreground-subtle">
                  <span>
                    {intl.formatMessage(
                      {
                        id:
                          model.kind === "inherit"
                            ? "chat.orchestration.picker.model.inherit"
                            : "chat.orchestration.picker.model.value",
                      },
                      model.kind === "model" ? { model: model.modelId ?? "" } : {},
                    )}
                  </span>
                  {role.tags.slice(0, 3).map((tag) => (
                    <span key={tag} className="rounded-full bg-surface px-1.5">
                      {tag}
                    </span>
                  ))}
                </span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={intl.formatMessage({ id: "chat.orchestration.picker.editModel" })}
                title={intl.formatMessage({ id: "chat.orchestration.picker.editModel" })}
                onClick={() => onOpenRoleSettings(role.name)}
              >
                <Settings2Icon className="size-3.5" aria-hidden />
              </Button>
            </div>
          );
        })}
        {visibleRoles.length === 0 ? (
          <p className="px-2 py-6 text-center text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "chat.orchestration.picker.empty" })}
          </p>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-border/60 pt-2 text-ui-xs text-foreground-subtle">
        <span>
          {intl.formatMessage(
            { id: "chat.orchestration.picker.count" },
            { count: String(team.length), max: String(limits.hard) },
          )}
        </span>
        {sizeNotice ? (
          <span className={sizeNotice === "hard" ? "text-warning" : "text-foreground-subtle"}>
            {intl.formatMessage({
              id:
                sizeNotice === "hard"
                  ? "chat.orchestration.picker.limit.hard"
                  : "chat.orchestration.picker.limit.soft",
            })}
          </span>
        ) : null}
      </div>
    </div>
  );
}
