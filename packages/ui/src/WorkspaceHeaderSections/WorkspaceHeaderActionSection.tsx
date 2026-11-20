import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import { WorkspaceTerminalToggleButton } from "@/WorkspaceTerminalToggleButton.js";
import { cn } from "@/components/lib/utils.js";
import type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { WorkspaceGitToolsEntry } from "@/WorkspaceGitToolsEntry.js";
import { WorkspaceStatusEntry } from "@/WorkspaceStatusEntry.js";
import { ConversationShareMenu } from "@/ConversationShareMenu.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";

export type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";

export function WorkspaceHeaderActionSection({
  variant = "task",
  activeTaskId,
  activeSessionId,
  user,
  readOnlyReason,
  workspaceAbsPath,
  workspaceIdentity,
  remoteTarget,
  isDesktop,
  isTerminalOpen,
  isSidePaneOpen,
  onToggleTerminal,
  onToggleSidePane,
  toggleSidePaneShortcutLabel,
  onSelectedEditorChange,
  simplifyForNarrowRemote = false,
  hideHelpMenu = false,
  showWindowControls = false,
  useWindowsCaptionSpacing = false,
  gitTools = null,
  gitToolsPanelOpen = false,
  onGitToolsPanelOpenChange,
  gitWorktreeReviewSourceId,
  activeTaskChangeSummary,
  onRefreshGit,
  onOpenGitReview,
}: WorkspaceHeaderActionSectionProps) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center [app-region:no-drag]",
        // Windows header 内容区有 p-2，普通工具栏按钮 hover 只覆盖 32px 高度。
        // 标题栏按钮需要抵消这层垂直内边距，和原生窗控/右侧菜单保持同一个 48px hover 面。
        useWindowsCaptionSpacing ? "-my-2 h-12 gap-0" : "gap-0.5",
      )}
    >
      {variant === "task" ? (
        <WorkspaceEditorButtonGroup
          disabledReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          remoteTarget={remoteTarget}
          onSelectedEditorChange={onSelectedEditorChange}
        />
      ) : null}
      {/* 分享发布接口依赖登录态；未登录时隐藏入口，避免用户打开后只能得到鉴权失败。 */}
      {activeTaskId && user && isDesktop !== false ? (
        <ConversationShareMenu
          taskId={activeTaskId}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {/* Git 入口紧邻帮助按钮：Git 有事可做（gitTools 非 null）时始终出现，点击展开浮层。
          `gitTools` 为 null 已覆盖 Office / 非仓库 / 无事可做。
          手机远控窄头部也保留这一个图标：Git 工具不再有 chip 作为窄屏入口。 */}
      {gitTools && onGitToolsPanelOpenChange && onRefreshGit ? (
        <WorkspaceGitToolsEntry
          workspacePath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          gitTools={gitTools}
          open={gitToolsPanelOpen}
          onOpenChange={onGitToolsPanelOpenChange}
          gitWorktreeReviewSourceId={gitWorktreeReviewSourceId}
          activeTaskChangeSummary={activeTaskChangeSummary}
          onRefreshGit={onRefreshGit}
          onOpenGitReview={onOpenGitReview}
        />
      ) : null}
      {/* 会话状态入口紧邻 Git 图标右侧：有 active session 就常驻，点击唤醒/收起状态面板。
          面板内容由 SessionPane 提供，这里只负责唤醒（与 Git 工具同一套交互）。 */}
      {activeSessionId ? <WorkspaceStatusEntry sessionId={activeSessionId} /> : null}
      {!simplifyForNarrowRemote ? (
        <>
          {!hideHelpMenu ? <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} /> : null}
          {/* 远程控制移动端头部空间过窄，终端入口在这里会和核心操作争抢宽度。*/}
          <WorkspaceTerminalToggleButton
            isTerminalOpen={isTerminalOpen}
            onToggleTerminal={onToggleTerminal}
            disabledReason={readOnlyReason}
            useWindowsCaptionSpacing={useWindowsCaptionSpacing}
          />
        </>
      ) : null}
      {/* 远程控制移动端只保留图标，避免 diff 数字把按钮撑宽导致标题拥挤。 */}
      {!isSidePaneOpen ? (
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen={isSidePaneOpen}
          onToggleSidePane={onToggleSidePane}
          shortcutLabel={toggleSidePaneShortcutLabel}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {showWindowControls && !isSidePaneOpen ? <DesktopWindowControls /> : null}
    </div>
  );
}
