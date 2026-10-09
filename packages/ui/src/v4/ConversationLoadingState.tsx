/**
 * 会话首帧加载占位。
 *
 * 为什么需要它：冷恢复（拉起/复用 CLI → 读全量 transcript → 恢复 runtime → 水合投影 → 打帧）
 * 完成前，时间线既没有 rows 也没有空态内容，消息区是纯空白；长历史会话的等待尤其明显，
 * 用户无法区分「在加载」和「坏了」。这里用骨架表达「内容即将出现在这里」，并在拿得到时
 * 附带 sessions-index 已有的上一轮回复预览（≤120 字符），不新增任何请求。
 *
 * 纯 renderer 显示投影：不写状态、不持久化；首个 snapshot 到达后由 SessionPane 卸载。
 */
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { TID_V4_TIMELINE_LOADING, TID_V4_TIMELINE_LOADING_PREVIEW } from "@zcode/shared";
import { getConversationContentWidthClassName } from "@/v4/conversationLayout.js";
import { resolveLoadingPreview } from "@/v4/conversationEmptySlot.js";

/** 三组「用户输入 + 助手回复」轮廓：足够表达对话形态，不铺满整屏。 */
const LOADING_TURN_KEYS = ["loading-turn-1", "loading-turn-2", "loading-turn-3"] as const;

interface ConversationLoadingStateProps {
  /** 上一轮助手回复预览；空则不渲染预览行，不影响骨架本身。 */
  preview?: string | null;
  /** 与真实消息列同口径的宽度裁决，避免占位列与正文列宽度跳变。 */
  summaryPanelLayout?: "none" | "auto" | "inline";
  className?: string;
}

export function ConversationLoadingState({
  preview,
  summaryPanelLayout = "auto",
  className,
}: ConversationLoadingStateProps) {
  const { intl } = useZCodeIntl();
  const trimmedPreview = resolveLoadingPreview(preview);
  const contentWidthClassName = getConversationContentWidthClassName({
    centeredEmptyLayout: false,
    statusPanelLayout: summaryPanelLayout,
  });

  return (
    <div
      role="status"
      data-testid={TID_V4_TIMELINE_LOADING}
      // mt-auto 把占位贴到空态槽位底部：首帧内容是「尾窗 + 吸底」，占位若留在顶部
      // 就会出现「骨架在顶部 → 内容出现在底部」的整屏跳变。用 mt-auto 而不是父级
      // justify-end：内容高于可视高度时 mt-auto 退化为 0，占位回到顶部并随滚动可达，
      // justify-end 会把溢出部分顶到滚动起点之外、滚不回来。
      className={cn("mx-auto mt-auto w-full", contentWidthClassName, className)}
    >
      <span className="sr-only">{intl.formatMessage({ id: "chat.loading.preparing" })}</span>
      <div aria-hidden="true" className="motion-safe:animate-pulse flex flex-col gap-5 px-4 py-5">
        {LOADING_TURN_KEYS.map((key) => (
          <div key={key} className="flex flex-col gap-3">
            <div className="flex justify-end">
              <span className="h-9 w-2/5 rounded-xl bg-surface" />
            </div>
            <div className="flex flex-col gap-2">
              <span className="h-4 w-11/12 rounded-md bg-surface" />
              <span className="h-4 w-3/4 rounded-md bg-surface" />
            </div>
          </div>
        ))}
      </div>
      {trimmedPreview ? (
        <div
          data-testid={TID_V4_TIMELINE_LOADING_PREVIEW}
          // mb-5 与骨架自身的 py-5 同口径：有无预览行时贴底留白都是 20px，不贴住输入框。
          className="mx-4 mb-5 flex items-baseline gap-2 rounded-xl border border-card-border bg-surface/60 px-3 py-2"
        >
          <span className="shrink-0 text-ui-caption text-foreground-subtlest">
            {intl.formatMessage({ id: "chat.loading.lastReply" })}
          </span>
          <span className="min-w-0 flex-1 truncate text-ui-base text-foreground-subtle">
            {trimmedPreview}
          </span>
        </div>
      ) : null}
    </div>
  );
}
