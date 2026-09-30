import type { Locale } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

function formatDurationUnit(
  value: number,
  messageId: string,
  intl: IntlInstance,
  locale: Locale,
): string {
  const unit = intl.formatMessage({ id: messageId });
  // 中文时长单位需要空格；英文单位本身已带缩写，不额外插入空格。
  return `${value}${locale === "zh-CN" ? " " : ""}${unit}`;
}

/** Desktop 与 Share 共用的工作时长文案，避免同一轮在两个 surface 显示不同单位。 */
export function formatConversationWorkDuration(
  durationMs: number | undefined,
  intl: IntlInstance,
  locale: Locale,
): string | null {
  if (durationMs === undefined) return null;

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];

  if (days > 0) parts.push(formatDurationUnit(days, "chat.history.duration.day", intl, locale));
  if (hours > 0) parts.push(formatDurationUnit(hours, "chat.history.duration.hour", intl, locale));
  if (minutes > 0)
    parts.push(formatDurationUnit(minutes, "chat.history.duration.minute", intl, locale));
  if (seconds > 0 || parts.length === 0) {
    parts.push(formatDurationUnit(seconds, "chat.history.duration.second", intl, locale));
  }

  return parts.slice(0, 2).join(" ");
}

/**
 * 秒级精度时长，用于 TTFT、工具耗时这类通常只有几秒的读数：取整会把 6.4 秒读成 6 秒。
 * 单位与空格规则沿用上方同一函数，不另立一套时长文案。
 */
export function formatPreciseDuration(
  durationMs: number,
  intl: IntlInstance,
  locale: Locale,
): string {
  return formatDurationUnit(
    Number((durationMs / 1000).toFixed(1)),
    "chat.history.duration.second",
    intl,
    locale,
  );
}
