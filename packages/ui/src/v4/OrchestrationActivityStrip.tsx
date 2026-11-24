import { useEffect, useMemo, useState } from "react";
import { ChevronRightIcon, NetworkIcon } from "lucide-react";
import type { OrchestrationRunProjection } from "@zcode/shared/zcode-protocol-v4";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 输入框上方的编排活动状态条。
 *
 * 编排 run 不属于会话轮次：主代理轮已经收口，但 scheduler 仍在派发子代理。只靠状态面板
 * 表达这件事时，面板一关（或用户根本没点开）会话看起来就是“已完成”。这里给一个常驻、
 * 单行、可点开的入口，数据只读 SessionPane 已有的 `orchestrationState` 投影，不新增 RPC，
 * 也不复制 run 状态。
 */
export function OrchestrationActivityStrip({
  runs,
  onOpen,
}: {
  runs: readonly OrchestrationRunProjection[];
  /** 打开状态面板并展开「编排计划」分区。 */
  onOpen: () => void;
}) {
  const { intl } = useZCodeIntl();
  const activeRun = runs.find((run) => run.active);
  const [now, setNow] = useState(() => Date.now());

  const counts = useMemo(() => {
    if (!activeRun) return { completed: 0, running: 0 };
    let completed = 0;
    let running = 0;
    for (const step of activeRun.steps) {
      if (step.status === "completed") completed += 1;
      else if (step.status === "running") running += 1;
    }
    return { completed, running };
  }, [activeRun]);

  useEffect(() => {
    if (!activeRun) return;
    // run 起止切换时立刻校准一次，避免沿用上一个 run 的旧时刻。
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeRun]);

  if (!activeRun) return null;

  const elapsed = formatElapsed(Math.max(0, now - activeRun.startedAt));
  const progressLabel = intl.formatMessage(
    { id: "chat.orchestration.progress" },
    {
      completed: String(counts.completed),
      total: String(activeRun.steps.length),
      running: String(counts.running),
    },
  );
  const runningAgentsLabel = intl.formatMessage(
    { id: "chat.orchestration.activity.runningAgents" },
    { count: String(counts.running) },
  );
  const ariaLabel = intl.formatMessage(
    { id: "chat.orchestration.activity.ariaLabel" },
    {
      progress: progressLabel,
      runningAgents: runningAgentsLabel,
    },
  );

  return (
    <button
      type="button"
      data-testid="v4-orchestration-activity-strip"
      data-orchestration-active-runs={runs.filter((run) => run.active).length}
      data-orchestration-running-steps={counts.running}
      aria-label={ariaLabel}
      onClick={onOpen}
      className="mb-1.5 flex w-full min-w-0 items-center gap-2 rounded-xl border border-brand/25 bg-brand/5 px-3 py-1.5 text-ui-sm text-foreground transition-colors hover:bg-brand/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <NetworkIcon className="size-3.5 shrink-0 text-brand" aria-hidden />
      <span className="shrink-0 font-medium text-brand">
        {intl.formatMessage({ id: "chat.orchestration.activity.label" })}
      </span>
      <span className="min-w-0 truncate text-foreground-subtle">{progressLabel}</span>
      <span className="min-w-0 truncate text-foreground-subtle @max-[520px]/conversation:hidden">
        {runningAgentsLabel}
      </span>
      <span className="ml-auto shrink-0 tabular-nums text-foreground-subtlest">{elapsed}</span>
      <span className="inline-flex shrink-0 items-center gap-0.5 text-brand">
        <span className="@max-[420px]/conversation:hidden">
          {intl.formatMessage({ id: "chat.orchestration.activity.details" })}
        </span>
        <ChevronRightIcon className="size-3.5" aria-hidden />
      </span>
    </button>
  );
}

/** 紧凑时长：`42s` / `3:05` / `1:02:09`，与状态面板的时长口径一致。 */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3_600);
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  if (minutes > 0) return `${minutes}:${String(seconds).padStart(2, "0")}`;
  return `${seconds}s`;
}
