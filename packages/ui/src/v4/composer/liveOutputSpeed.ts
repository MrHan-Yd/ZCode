/** 1 秒时钟下保留约 3 个采样点：读数反映最近 2~3 秒，逐帧重算会跳得没法看。 */
export const LIVE_OUTPUT_SAMPLE_WINDOW_MS = 3_000;
/** 观测窗口不足时不出数值：极短窗口会把首帧速度算得高得离谱。 */
export const LIVE_OUTPUT_MIN_SPAN_MS = 600;

export interface OutputSpeedSample {
  at: number;
  tokens: number;
}

/** 用窗口两端的读数差算速度；窗口不足或读数没涨时返回 null，由调用方沿用上一个显示值。 */
export function resolveLiveOutputSpeed(samples: readonly OutputSpeedSample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last) return null;
  const spanMs = last.at - first.at;
  if (spanMs < LIVE_OUTPUT_MIN_SPAN_MS) return null;
  const tokenDelta = last.tokens - first.tokens;
  if (tokenDelta <= 0) return null;
  return tokenDelta / (spanMs / 1_000);
}
