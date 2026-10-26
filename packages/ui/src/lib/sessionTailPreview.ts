import type { V4ConversationTailPreviewResult } from "@zcode/shared/zcode-protocol-v4";

/**
 * 预览是否值得展示。
 *
 * 空列表有两种来源：会话本身没有可展示消息，或有 revert/branch cut 时服务端主动不提供
 * 预览。两者都必须回退到骨架，不能用一个空白预览代替加载态。
 */
export function hasTailPreviewContent(
  preview: V4ConversationTailPreviewResult | null,
): preview is V4ConversationTailPreviewResult {
  return preview !== null && preview.messages.length > 0;
}
