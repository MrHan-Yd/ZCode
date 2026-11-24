import { TID_CHAT_STATUS_ENTRY } from "@zcode/shared";
import { ListChecksIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  toggleStatusPanelOverlay,
  useStatusPanelOverlayOpen,
} from "@/v4/statusPanelOverlayStore.js";
import { useSessionIndexSummary } from "@/v4/useSessionIndexSummary.js";

/**
 * 工作区标题栏的「会话状态」入口：与 Git 工具同排的图标按钮，点击唤醒/收起
 * pane 内的状态面板（进程 / 终端 / 工作流 / 编排 / 智能体）。
 *
 * 图标常驻（有 active session 即渲染），面板内容仍由 SessionPane 的会话投影提供；
 * 这里只写 `statusPanelOverlayStore` 的开关意图，不复制任何状态事实。角标里的
 * 编排活动读 sessions-index 摘要（列表级权威），与面板/通知同一份事实。
 */
export function WorkspaceStatusEntry({
  sessionId,
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
}: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
}) {
  const { intl } = useZCodeIntl();
  const open = useStatusPanelOverlayOpen(sessionId);
  const summary = useSessionIndexSummary(
    { workspacePath, workspaceIdentity, remoteSessionId },
    sessionId,
  );
  const orchestrationActivity = summary?.orchestrationActivity;
  const runningStepCount = orchestrationActivity?.runningStepCount ?? 0;
  const hasOrchestration = (orchestrationActivity?.activeRunCount ?? 0) > 0;
  const label = hasOrchestration
    ? intl.formatMessage(
        { id: "chat.statusEntry.runningLabel" },
        { count: String(Math.max(runningStepCount, orchestrationActivity?.activeRunCount ?? 0)) },
      )
    : intl.formatMessage({ id: "chat.statusEntry.label" });

  return (
    <ControlHintTooltip title={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-testid={TID_CHAT_STATUS_ENTRY}
        data-status-entry-open={open ? "true" : "false"}
        data-status-entry-running-orchestration={hasOrchestration ? "true" : "false"}
        data-status-entry-running-steps={runningStepCount}
        aria-label={label}
        aria-expanded={open}
        className="relative [app-region:no-drag]"
        onClick={() => toggleStatusPanelOverlay(sessionId)}
      >
        <ListChecksIcon className="size-4" />
        {hasOrchestration ? (
          // 常驻运行角标：面板关着也能看出编排仍在派发子代理。
          <span
            data-status-entry-badge="orchestration"
            className="pointer-events-none absolute -top-0.5 -right-0.5 inline-flex min-w-4 items-center justify-center rounded-full bg-brand px-1 text-[10px] leading-4 font-medium text-foreground-inverse tabular-nums"
            aria-hidden
          >
            {Math.max(1, runningStepCount)}
          </span>
        ) : null}
      </Button>
    </ControlHintTooltip>
  );
}
