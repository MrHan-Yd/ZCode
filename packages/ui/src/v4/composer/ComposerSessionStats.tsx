import { GaugeIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { TID_CHAT_SESSION_STATS_PANEL, TID_CHAT_SESSION_STATS_TRIGGER } from "@zcode/shared";
import type { Locale, SessionPerformanceSummary } from "@zcode/shared";
import type { SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { useSessionPerformance } from "@/hooks/useSessionPerformance.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatConversationWorkDuration,
  formatPreciseDuration,
} from "@/v4/conversationWorkDuration.js";
import { useLiveOutputSpeed } from "@/v4/composer/useLiveOutputSpeed.js";

/** 一轮结束后的补取窗口：刚结束那轮要立刻计进统计，之后就把轮询关掉。 */
const SETTLE_GRACE_MS = 2_000;
/** 一分钟以下用一位小数：TTFT 与工具耗时通常只有几秒，取整会把 6.4 秒读成 6 秒。 */
const PRECISE_DURATION_LIMIT_MS = 60_000;

function useSettleGrace(running: boolean): boolean {
  const [grace, setGrace] = useState(false);
  useEffect(() => {
    if (running) {
      setGrace(false);
      return;
    }
    // 挂载时也走一次：打开会话要立刻拿到持久层里的累计值。
    setGrace(true);
    const timer = window.setTimeout(() => setGrace(false), SETTLE_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [running]);
  return grace;
}

function formatSpeedValue(speed: number, intl: IntlInstance): string {
  return intl.formatMessage({ id: "chat.sessionStats.speedValue" }, { speed: Math.round(speed) });
}

function formatDurationValue(
  durationMs: number | null | undefined,
  intl: IntlInstance,
  locale: Locale,
): string {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) {
    return intl.formatMessage({ id: "chat.sessionStats.emptyValue" });
  }
  if (durationMs < PRECISE_DURATION_LIMIT_MS)
    return formatPreciseDuration(durationMs, intl, locale);
  return (
    formatConversationWorkDuration(durationMs, intl, locale) ??
    intl.formatMessage({ id: "chat.sessionStats.emptyValue" })
  );
}

function SessionStatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 text-ui-sm">
      <span className="min-w-0 truncate text-foreground-subtle">{label}</span>
      <span className="ml-auto shrink-0 font-mono text-ui-sm tabular-nums text-foreground">
        {value}
      </span>
    </div>
  );
}

function SessionStatsPanel({
  intl,
  locale,
  summary,
}: {
  intl: IntlInstance;
  locale: Locale;
  summary: SessionPerformanceSummary | null;
}) {
  const emptyValue = intl.formatMessage({ id: "chat.sessionStats.emptyValue" });
  return (
    <div className="w-full bg-menu p-3" data-testid={TID_CHAT_SESSION_STATS_PANEL}>
      <div className="mb-3 flex items-center gap-2 text-ui-base font-medium text-foreground">
        <GaugeIcon aria-hidden="true" className="size-3.5 text-foreground-subtle" />
        {intl.formatMessage({ id: "chat.sessionStats.title" })}
      </div>
      <div className="space-y-1.5">
        <SessionStatRow
          label={intl.formatMessage({ id: "chat.sessionStats.modelDuration" })}
          value={formatDurationValue(summary?.modelMs, intl, locale)}
        />
        <SessionStatRow
          label={intl.formatMessage({ id: "chat.sessionStats.toolDuration" })}
          value={formatDurationValue(summary?.toolMs, intl, locale)}
        />
        <SessionStatRow
          label={intl.formatMessage({ id: "chat.sessionStats.averageTtft" })}
          value={formatDurationValue(summary?.averageTtftMs, intl, locale)}
        />
        <SessionStatRow
          label={intl.formatMessage({ id: "chat.sessionStats.outputSpeed" })}
          value={
            summary?.tokensPerSecond === null || summary?.tokensPerSecond === undefined
              ? emptyValue
              : formatSpeedValue(summary.tokensPerSecond, intl)
          }
        />
      </div>
    </div>
  );
}

/**
 * 工具条上的会话统计入口：常驻显示输出速度，悬停/聚焦展开整个会话的累计口径。
 * 运行中显示流式实时估算，空闲时回到持久层的累计值；两个都拿不到就不渲染入口。
 * 数据与口径见 specs/session-performance-stats.md。
 */
export function ComposerSessionStats({
  workspacePath,
  workspaceIdentity,
  sessionId,
  phase,
  readOutputTokens,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  phase: SessionPhase | null;
  /** 读当前流式输出的估算 token 数；调用方用 ref 提供，避免工具条随每个 token 批次重建。 */
  readOutputTokens: () => number;
}) {
  const { intl, locale } = useZCodeIntl();
  const [open, setOpen] = useState(false);
  const running = phase === "running";
  const settleGrace = useSettleGrace(running);
  const { summary } = useSessionPerformance({
    workspacePath,
    workspaceIdentity,
    sessionId,
    enabled: Boolean(sessionId) && (running || open || settleGrace),
  });
  const liveSpeed = useLiveOutputSpeed({
    active: Boolean(sessionId) && running,
    readOutputTokens,
  });

  const settledSpeed = summary?.tokensPerSecond ?? null;
  // 实时估算优先：它才是用户此刻看到的输出速度；停下来的那一秒回落到累计值。
  const displaySpeed = liveSpeed ?? settledSpeed;
  const hasSessionData =
    summary !== null && (summary.modelRequestCount > 0 || summary.toolCallCount > 0);
  if (!sessionId || (!hasSessionData && displaySpeed === null)) return null;

  const speedLabel = displaySpeed === null ? null : formatSpeedValue(displaySpeed, intl);

  return (
    <HoverCard closeDelay={0} openDelay={0} open={open} onOpenChange={setOpen}>
      <HoverCardTrigger asChild>
        <button
          aria-label={intl.formatMessage(
            { id: "chat.sessionStats.triggerAriaLabel" },
            { speed: speedLabel ?? intl.formatMessage({ id: "chat.sessionStats.emptyValue" }) },
          )}
          className="inline-flex min-w-0 shrink-0 items-center rounded-md px-1.5 py-0.5 font-mono text-ui-sm tabular-nums text-foreground-subtle transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          data-chat-toolbar-popover-trigger="true"
          data-testid={TID_CHAT_SESSION_STATS_TRIGGER}
          onPointerDown={(event) => {
            // Radix HoverCard 会在 touchstart 中阻止后续 click，手机端无法打开面板；
            // 触摸 pointerdown 阶段先打开，桌面端继续保持 hover/focus 语义。
            if (
              !event.defaultPrevented &&
              event.pointerType === "touch" &&
              typeof window !== "undefined" &&
              window.matchMedia?.("(hover: none)").matches
            ) {
              setOpen(true);
            }
          }}
          type="button"
        >
          {speedLabel ?? intl.formatMessage({ id: "chat.sessionStats.emptyValue" })}
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        align="end"
        className="!w-56 overflow-hidden !rounded-xl border border-popover-border bg-popover p-0 !shadow-md"
        side="top"
        sideOffset={6}
      >
        <SessionStatsPanel intl={intl} locale={locale} summary={summary} />
      </HoverCardContent>
    </HoverCard>
  );
}
