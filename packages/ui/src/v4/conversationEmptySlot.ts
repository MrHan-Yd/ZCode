/**
 * 时间线「当前无行可渲染」时的内容槽位裁决。
 *
 * 为什么单独抽出来：草稿空态、冷恢复加载占位、订阅错误三者会同时争用同一块区域，
 * 优先级必须是一个可说清、可测的规则，而不是散落在巨型 JSX 里的三元表达式。
 *
 * 优先级：草稿 > 错误 > 冷恢复加载占位 > 空。
 * - 草稿（sessionId 为 null）永远走问候语空态；
 * - 错误由 SessionSubscriptionErrorPanel 接管消息区，槽位留空，不能残留骨架；
 * - 其余情况下 connecting（subscribe ACK 先到、首个 snapshot 未到）显示加载骨架。
 */
type ConversationEmptySlot = "draft" | "loading" | "none";

export function resolveConversationEmptySlot(params: {
  isDraft: boolean;
  connecting: boolean;
  errored: boolean;
}): ConversationEmptySlot {
  if (params.isDraft) return "draft";
  if (params.errored) return "none";
  return params.connecting ? "loading" : "none";
}

/**
 * 预览只取非空文本：sessions-index 的 lastAssistantPreview 可能缺失或只有空白，
 * 此时不渲染预览行——但骨架本身照常显示，预览始终是可选增强。
 */
export function resolveLoadingPreview(preview: string | null | undefined): string | null {
  const trimmed = preview?.trim();
  return trimmed ? trimmed : null;
}
