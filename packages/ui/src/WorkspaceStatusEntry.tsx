import { TID_CHAT_STATUS_ENTRY } from "@zcode/shared";
import { ListChecksIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  toggleStatusPanelOverlay,
  useStatusPanelOverlayOpen,
} from "@/v4/statusPanelOverlayStore.js";

/**
 * 工作区标题栏的「会话状态」入口：与 Git 工具同排的图标按钮，点击唤醒/收起
 * pane 内的状态面板（进程 / 终端 / 工作流 / 编排 / 智能体）。
 *
 * 图标常驻（有 active session 即渲染），面板内容仍由 SessionPane 的会话投影提供；
 * 这里只写 `statusPanelOverlayStore` 的开关意图，不复制任何状态事实。
 */
export function WorkspaceStatusEntry({ sessionId }: { sessionId: string }) {
  const { intl } = useZCodeIntl();
  const open = useStatusPanelOverlayOpen(sessionId);
  const label = intl.formatMessage({ id: "chat.statusEntry.label" });

  return (
    <ControlHintTooltip title={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        data-testid={TID_CHAT_STATUS_ENTRY}
        data-status-entry-open={open ? "true" : "false"}
        aria-label={label}
        aria-expanded={open}
        className="[app-region:no-drag]"
        onClick={() => toggleStatusPanelOverlay(sessionId)}
      >
        <ListChecksIcon className="size-4" />
      </Button>
    </ControlHintTooltip>
  );
}
