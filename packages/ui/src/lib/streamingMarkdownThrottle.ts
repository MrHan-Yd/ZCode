/**
 * 流式文本渲染节流的框架无关决策核心。
 *
 * 依据 specs/streaming-markdown-throttle.md：流式 markdown 每 chunk 全量重解析是长消息
 * 卡顿的主要渲染端开销；把进入渲染管线的文本按时间间隔节流，可把全量解析频率从
 * chunk 频率（约 30fps）降到人眼无感知差异的 12fps 左右，且不丢内容（尾帧由调用方
 * 的 trailing 定时器与 settle 兜底）。
 *
 * 本核心不持有定时器/不依赖 React：`push` 输入显式时钟，纯同步可差分测试；定时器
 * 语义（leading 立即发射 + trailing 静默期满补发最新值）由 `useStreamingTextThrottle`
 * 适配层承担。
 */

export interface StreamingThrottlePush {
  /**
   * 应渲染的文本；null 表示本次输入被节流，调用方暂沿用上次发射值。
   * 发射时返回的就是本次 push 的 text（调用方无需再查引用）。
   */
  value: string | null;
  /** value 为 null 时，距下次可发射的毫秒数（>0）；value 非 null 时为 0。 */
  retryInMs: number;
}

export interface StreamingTextThrottle {
  /** 流式期间输入最新文本与当前时间，返回发射决策。 */
  push(text: string, nowMs: number): StreamingThrottlePush;
  /** 流式结束：复位内部状态，下次 push 视为首帧立即发射。 */
  settle(): void;
}

export function createStreamingTextThrottle(minIntervalMs: number): StreamingTextThrottle {
  if (!(minIntervalMs > 0) || !Number.isFinite(minIntervalMs)) {
    throw new RangeError(`minIntervalMs must be a positive finite number, got ${minIntervalMs}`);
  }
  let lastEmitAtMs: number | null = null;
  return {
    push(text: string, nowMs: number): StreamingThrottlePush {
      // lastEmitAtMs 为 null（首帧或 settle 后）或已过静默期 → 立即发射。
      if (lastEmitAtMs === null || nowMs - lastEmitAtMs >= minIntervalMs) {
        lastEmitAtMs = nowMs;
        return { value: text, retryInMs: 0 };
      }
      return { value: null, retryInMs: minIntervalMs - (nowMs - lastEmitAtMs) };
    },
    settle(): void {
      lastEmitAtMs = null;
    },
  };
}
