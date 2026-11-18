import { useMemo, useState } from "react";
import {
  BanIcon,
  CheckIcon,
  CircleDashedIcon,
  ExternalLinkIcon,
  Loader2Icon,
  NetworkIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import {
  TID_V4_ORCHESTRATION_RUN_BAR,
  TID_V4_ORCHESTRATION_RUN_STEP,
  TID_V4_ORCHESTRATION_RUN_STOP,
  TID_V4_ORCHESTRATION_RUN_TIMELINE,
  testId,
} from "@zcode/shared";
import type {
  OrchestrationRunProjection,
  OrchestrationStepProjection,
} from "@zcode/shared/zcode-protocol-v4";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import type {
  OrchestrationComposerControls,
  OrchestrationInputMode,
} from "@/v4/composer/OrchestrationControls.js";

const INPUT_MODE_IDS = {
  guide: "chat.orchestration.input.guide",
  queue: "chat.orchestration.input.queue",
  interrupt: "chat.orchestration.input.interrupt",
} as const;

const STEP_STATUS_IDS = {
  pending: "chat.orchestration.step.pending",
  running: "chat.orchestration.step.running",
  completed: "chat.orchestration.step.completed",
  failed: "chat.orchestration.step.failed",
  blocked: "chat.orchestration.step.blocked",
  cancelled: "chat.orchestration.step.cancelled",
  interrupted: "chat.orchestration.step.interrupted",
} as const;

/**
 * 运行中状态条 + 时间线。
 *
 * 状态条只在有活动 run 时出现；运行数仍由后台徽标负责，这里不重复计数。
 * 时间线是只读投影 + 两个显式动作（停止 / 重排），不承担队列或子会话所有权。
 */
export function OrchestrationRunBar({ controls }: { controls: OrchestrationComposerControls }) {
  const { intl } = useZCodeIntl();
  const [timelineOpen, setTimelineOpen] = useState(false);
  const activeRuns = controls.activeRuns;
  const activeRun = activeRuns[0];
  if (!activeRun) return null;

  const summary = summarizeRun(activeRun);
  const progressText = intl.formatMessage(
    { id: "chat.orchestration.bar.progress" },
    {
      completed: String(summary.completed),
      total: String(summary.total),
      running: String(summary.running),
    },
  );

  return (
    <div
      data-testid={TID_V4_ORCHESTRATION_RUN_BAR}
      className="mb-2 flex w-full min-w-0 flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-surface px-2.5 py-1.5 text-ui-sm"
    >
      <span className="flex min-w-0 items-center gap-1.5 text-foreground-subtle">
        <NetworkIcon className="size-3.5 shrink-0 text-brand" aria-hidden />
        <span className="truncate">
          {intl.formatMessage({ id: "chat.orchestration.bar.label" })} · {progressText}
        </span>
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 rounded-md px-1.5 text-ui-xs"
          >
            {intl.formatMessage({ id: INPUT_MODE_IDS[controls.inputMode] })}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" sideOffset={4} className="w-56">
          <DropdownMenuLabel>
            {intl.formatMessage({ id: "chat.orchestration.input.label" })}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={controls.inputMode}
            onValueChange={(value) => controls.onInputModeChange(value as OrchestrationInputMode)}
          >
            {(["guide", "queue", "interrupt"] as const).map((mode) => (
              <DropdownMenuRadioItem key={mode} value={mode} className="items-start">
                <span className="flex flex-col gap-0.5">
                  <span>{intl.formatMessage({ id: INPUT_MODE_IDS[mode] })}</span>
                  <span className="text-ui-xs text-foreground-subtle">
                    {intl.formatMessage({ id: `${INPUT_MODE_IDS[mode]}.description` })}
                  </span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <span className="flex-1" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 rounded-md px-1.5 text-ui-xs"
        onClick={() => setTimelineOpen(true)}
      >
        {intl.formatMessage({ id: "chat.orchestration.bar.view" })}
      </Button>
      <ControlHintTooltip title={intl.formatMessage({ id: "chat.orchestration.bar.stop" })}>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          data-testid={testId(TID_V4_ORCHESTRATION_RUN_STOP, activeRun.runId)}
          aria-label={intl.formatMessage({ id: "chat.orchestration.bar.stop" })}
          onClick={() => controls.onStopRun(activeRun.runId)}
          className="h-6 w-6"
        >
          <SquareIcon className="size-3 fill-current" aria-hidden />
        </Button>
      </ControlHintTooltip>
      <Dialog open={timelineOpen} onOpenChange={setTimelineOpen}>
        <DialogContent className="max-h-[80vh] w-full max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {intl.formatMessage({ id: "chat.orchestration.timeline.title" })}
            </DialogTitle>
          </DialogHeader>
          <div data-testid={TID_V4_ORCHESTRATION_RUN_TIMELINE} className="flex flex-col gap-4">
            {controls.runs.map((run) => (
              <RunSection
                key={run.runId}
                run={run}
                controls={controls}
                onRequestReplan={() => {
                  setTimelineOpen(false);
                  controls.onRequestReplan();
                }}
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function RunSection({
  run,
  controls,
  onRequestReplan,
}: {
  run: OrchestrationRunProjection;
  controls: OrchestrationComposerControls;
  onRequestReplan: () => void;
}) {
  const { intl } = useZCodeIntl();
  const stepById = useMemo(
    () => new Map(run.steps.map((step) => [step.stepId, step])),
    [run.steps],
  );
  const runningCount = run.steps.filter((step) => step.status === "running").length;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-ui-base font-medium text-foreground">
          {run.planId} · r{run.revision}
        </span>
        <span className="rounded-full bg-surface px-1.5 text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: `chat.orchestration.run.${run.status}` })}
        </span>
        <span className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage(
            { id: "chat.orchestration.timeline.team" },
            { count: String(run.team.length), concurrency: String(run.maxConcurrency) },
          )}
        </span>
        {runningCount > 1 ? (
          <span className="text-ui-xs text-foreground-subtle">
            {intl.formatMessage(
              { id: "chat.orchestration.timeline.parallel" },
              { count: String(runningCount) },
            )}
          </span>
        ) : null}
        <span className="flex-1" />
        {run.active ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 rounded-md px-1.5 text-ui-xs"
              onClick={() => controls.onStopRun(run.runId)}
            >
              {intl.formatMessage({ id: "chat.orchestration.timeline.stop" })}
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="h-6 rounded-md px-1.5 text-ui-xs"
              onClick={onRequestReplan}
            >
              <RotateCcwIcon className="size-3" aria-hidden />
              {intl.formatMessage({ id: "chat.orchestration.timeline.replan" })}
            </Button>
          </>
        ) : null}
      </div>
      <ol className="flex flex-col gap-1">
        {run.steps.map((step) => (
          <StepRow
            key={step.stepId}
            step={step}
            stepById={stepById}
            onViewChild={controls.onViewChild}
          />
        ))}
      </ol>
    </section>
  );
}

function StepRow({
  step,
  stepById,
  onViewChild,
}: {
  step: OrchestrationStepProjection;
  stepById: ReadonlyMap<string, OrchestrationStepProjection>;
  onViewChild: (childSessionId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const waitingOn = step.dependsOn.filter((dependency) => {
    const state = stepById.get(dependency)?.status;
    return state !== "completed" && state !== "failed" && state !== "cancelled";
  });

  return (
    <li
      data-testid={testId(TID_V4_ORCHESTRATION_RUN_STEP, step.stepId)}
      data-step-status={step.status}
      className="flex items-start gap-2 rounded-lg border border-border/50 px-2 py-1.5"
    >
      <StepStatusIcon status={step.status} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="truncate text-ui-base text-foreground">{step.title}</span>
          <span className="text-ui-xs text-foreground-subtle">{step.role}</span>
          {step.attempts > 1 ? (
            <span className="text-ui-xs text-warning">
              {intl.formatMessage(
                { id: "chat.orchestration.step.attempts" },
                { count: String(step.attempts) },
              )}
            </span>
          ) : null}
        </span>
        <span className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: STEP_STATUS_IDS[step.status] })}
          {step.status === "pending" && waitingOn.length > 0
            ? ` · ${intl.formatMessage(
                { id: "chat.orchestration.step.waiting" },
                { steps: waitingOn.join(", ") },
              )}`
            : ""}
          {step.error ? ` · ${step.error}` : ""}
        </span>
      </span>
      {step.childSessionId ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 rounded-md px-1.5 text-ui-xs"
          onClick={() => onViewChild(step.childSessionId!)}
        >
          <ExternalLinkIcon className="size-3" aria-hidden />
          {intl.formatMessage({ id: "chat.orchestration.step.viewChild" })}
        </Button>
      ) : null}
    </li>
  );
}

function StepStatusIcon({ status }: { status: OrchestrationStepProjection["status"] }) {
  const className = "mt-0.5 size-3.5 shrink-0";
  switch (status) {
    case "running":
      return <Loader2Icon className={cn(className, "animate-spin text-brand")} aria-hidden />;
    case "completed":
      return <CheckIcon className={cn(className, "text-success")} aria-hidden />;
    case "failed":
      return <XIcon className={cn(className, "text-danger")} aria-hidden />;
    case "blocked":
    case "cancelled":
    case "interrupted":
      return <BanIcon className={cn(className, "text-foreground-subtle")} aria-hidden />;
    default:
      return <CircleDashedIcon className={cn(className, "text-foreground-subtle")} aria-hidden />;
  }
}

function summarizeRun(run: OrchestrationRunProjection): {
  total: number;
  completed: number;
  running: number;
} {
  return {
    total: run.steps.length,
    completed: run.steps.filter((step) => step.status === "completed").length,
    running: run.steps.filter((step) => step.status === "running").length,
  };
}
