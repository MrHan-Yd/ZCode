import type { LiveOutputTokenReading } from "./liveOutputTokens.js";

/** 1 秒时钟下保留约 3 个采样点：读数反映最近 2~3 秒，逐帧重算会跳得没法看。 */
export const LIVE_OUTPUT_SAMPLE_WINDOW_MS = 3_000;
/** 观测窗口不足时不出数值：极短窗口会把首帧速度算得高得离谱。 */
export const LIVE_OUTPUT_MIN_SPAN_MS = 600;

export interface OutputSpeedSample extends LiveOutputTokenReading {
  at: number;
}

/**
 * 追加一个 1 秒采样点，返回新的样本窗。
 *
 * 切会话、换轮、补历史或裁切窗口会改变累计读数的基线；即使新读数更大，也不能把差值
 * 当成一秒输出。作用域变化或读数回落时必须整窗丢弃重开，新作用域首个样本只作基线。
 *
 * 读数为 0 或作用域为空表示此刻没有可采样的输出：样本窗同样清空。
 */
export function appendOutputSpeedSample(
  previous: readonly OutputSpeedSample[],
  next: OutputSpeedSample,
): readonly OutputSpeedSample[] {
  if (next.scopeKey === null || next.tokens <= 0) return previous.length === 0 ? previous : [];
  const latest = previous.at(-1);
  if (latest !== undefined && (next.scopeKey !== latest.scopeKey || next.tokens < latest.tokens)) {
    return [next];
  }
  return [
    ...previous.filter(
      (sample) => sample.at !== next.at && next.at - sample.at <= LIVE_OUTPUT_SAMPLE_WINDOW_MS,
    ),
    next,
  ];
}

/**
 * 用窗口两端的读数差算速度；窗口不足、或窗口内没有新增输出（读数没涨）时返回 null，
 * 调用方据此显示 `--`：没有内容在产出时不该给出「当前速度」。
 */
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
