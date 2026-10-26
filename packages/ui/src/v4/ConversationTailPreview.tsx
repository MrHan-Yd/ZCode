import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TID_SESSION_TAIL_PREVIEW } from "@zcode/shared";
import type { V4ConversationTailPreviewResult } from "@zcode/shared/zcode-protocol-v4";
import { getConversationContentWidthClassName } from "@/v4/conversationLayout.js";

interface ConversationTailPreviewProps {
  preview: V4ConversationTailPreviewResult;
  /** 与真实消息列同口径的宽度裁决，避免预览替换时宽度跳变。 */
  summaryPanelLayout?: "none" | "auto" | "inline";
  className?: string;
}

/**
 * 冷开 connecting 期间的只读尾部预览。
 *
 * 只读展示，不进入 ConversationProjectionStore、不产生 rowId/revision、不接受命令。
 * 权威 snapshot 到达后由 SessionPane 卸载，正式时间线接管；两者不做行级合并。
 */
export function ConversationTailPreview({
  preview,
  summaryPanelLayout = "auto",
  className,
}: ConversationTailPreviewProps) {
  const { intl } = useZCodeIntl();
  const contentWidthClassName = getConversationContentWidthClassName({
    centeredEmptyLayout: false,
    statusPanelLayout: summaryPanelLayout,
  });

  return (
    <div
      data-testid={TID_SESSION_TAIL_PREVIEW}
      // 与骨架同口径贴底：首帧内容从底部接上时不会出现整屏跳变。
      className={cn("mx-auto mt-auto w-full", contentWidthClassName, className)}
    >
      <div
        role="status"
        className="flex items-center gap-2 px-4 pb-3 text-ui-caption text-foreground-subtlest"
      >
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 motion-safe:animate-pulse rounded-full bg-foreground-subtlest"
        />
        <span>{intl.formatMessage({ id: "chat.tailPreview.restoring" })}</span>
      </div>
      <div className="flex flex-col gap-4 px-4 pb-5">
        {preview.messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "flex flex-col gap-1",
              message.role === "user" ? "items-end" : "items-start",
            )}
          >
            {message.text ? (
              <div
                className={cn(
                  "max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-4 py-2 text-ui-base",
                  message.role === "user"
                    ? "bg-surface text-foreground"
                    : "text-foreground-subtle",
                )}
              >
                {message.text}
              </div>
            ) : null}
            {message.toolCallCount > 0 ? (
              <span className="px-1 text-ui-caption text-foreground-subtlest">
                {intl.formatMessage(
                  { id: "chat.tailPreview.toolCalls" },
                  { count: message.toolCallCount },
                )}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
