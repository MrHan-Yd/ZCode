/**
 * 用户消息气泡的编排区分样式（specs/orchestrator-mode.md 5.8）。
 *
 * 事实来自 row.orchestrationEnabled：该轮开跑时 session 编排配置为 enabled。
 * 经典轮与编排轮只差边框色，不改变圆角、内边距或动作区，避免经典会话出现视觉漂移。
 */

export const USER_INPUT_BUBBLE_BASE_CLASS =
  "flex max-w-full flex-col gap-2 rounded-xl rounded-tr-xs border bg-surface px-4 py-3 text-ui-base text-foreground @min-[624px]/conversation:max-w-xl";

export const USER_INPUT_BUBBLE_DEFAULT_BORDER_CLASS = "border-border";

/** 浅蓝色边框：与经典消息的 --color-border 明确区分，同时保持明暗主题可辨。 */
export const USER_INPUT_BUBBLE_ORCHESTRATION_BORDER_CLASS = "border-sky-400/70";

export function resolveUserInputBubbleBorderClass(
  orchestrationEnabled: boolean | undefined,
): string {
  return orchestrationEnabled
    ? USER_INPUT_BUBBLE_ORCHESTRATION_BORDER_CLASS
    : USER_INPUT_BUBBLE_DEFAULT_BORDER_CLASS;
}
