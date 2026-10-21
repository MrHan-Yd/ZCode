export function isImeComposingKeyEvent(event: {
  compositionActive?: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
}): boolean {
  return Boolean(event.compositionActive || event.isComposing || event.nativeEvent?.isComposing);
}

/**
 * IME 组合期间（拼音未上屏）是否冻结触发面板重算：中间态字母会被当作 query 逐字过滤一轮，
 * 面板闪烁且中间态结果错误；composition 提交后 Lexical 会再派发一次 update 完成重算。
 * Android 例外：Chrome + Gboard 对拉丁词也走 composition（整词到空格才 compositionend），
 * 冻结会让手机 Web 的 mention / 提示词面板失去逐字过滤，因此 Android 保持实时重算。
 *
 * @/mentions/MentionPlugin 与 @/mentions/PromptLibraryPlugin 共用同一判定，避免两套组合态语义漂移。
 */
export function shouldFreezeMentionRecalcWhileComposing(
  isComposing: boolean,
  userAgent: string,
): boolean {
  return isComposing && !/Android/i.test(userAgent);
}
