import { useEffect, useRef, useState } from "react";

import { createStreamingTextThrottle } from "../lib/streamingMarkdownThrottle.js";

/**
 * 流式文本渲染节流的 React 适配（语义见 specs/streaming-markdown-throttle.md）。
 *
 * - `active=false`（完成态）：旁路返回最新 `text`，并对节流核心 settle——历史消息
 *   重挂载永不节流、一次性完整渲染。
 * - `active=true`：leading 立即发射 + trailing 静默期满补发**当时最新**文本，保证
 *   尾帧不丢；重挂载首帧即当前文本，不出现空白闪帧。
 *
 * 定时器随 `text` 变化重排：每次文本更新都重新计算距可发射的剩余时间，最终总会在
 * 静默期满后用最新值补发一次。
 */
export function useStreamingTextThrottle(text: string, active: boolean, minIntervalMs: number): string {
  const [rendered, setRendered] = useState(text);
  const latestTextRef = useRef(text);
  latestTextRef.current = text;

  const throttleRef = useRef<ReturnType<typeof createStreamingTextThrottle> | null>(null);
  if (throttleRef.current === null) {
    throttleRef.current = createStreamingTextThrottle(minIntervalMs);
  }

  useEffect(() => {
    const throttle = throttleRef.current;
    if (!throttle) {
      return;
    }
    if (!active) {
      throttle.settle();
      setRendered(latestTextRef.current);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (): void => {
      const { value, retryInMs } = throttle.push(latestTextRef.current, Date.now());
      if (value !== null) {
        setRendered(value);
        return;
      }
      timer = setTimeout(attempt, retryInMs);
    };
    attempt();
    return () => clearTimeout(timer);
  }, [active, text]);

  return active ? rendered : text;
}
