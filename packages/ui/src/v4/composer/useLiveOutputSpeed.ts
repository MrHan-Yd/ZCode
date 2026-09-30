import { useEffect, useMemo, useState } from "react";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";
import {
  LIVE_OUTPUT_SAMPLE_WINDOW_MS,
  resolveLiveOutputSpeed,
  type OutputSpeedSample,
} from "@/v4/composer/liveOutputSpeed.js";

/**
 * 流式输出的实时速度：只做显示投影，不写回任何事实。
 * `readOutputTokens` 读的是每帧更新的 ref 读数，本 hook 只在 1 秒时钟上采样，
 * 因此不会把逐 token 的渲染压力带进工具条。
 */
export function useLiveOutputSpeed({
  active,
  readOutputTokens,
}: {
  active: boolean;
  readOutputTokens: () => number;
}): number | null {
  const tick = useNowTicker(active);
  const [samples, setSamples] = useState<readonly OutputSpeedSample[]>([]);

  useEffect(() => {
    if (!active) {
      setSamples((previous) => (previous.length === 0 ? previous : []));
      return;
    }
    const tokens = readOutputTokens();
    setSamples((previous) => {
      // 0 表示当前没有流式输出（这一轮还没吐字，或刚刚结束）：采样从零重开。
      if (tokens <= 0) return previous.length === 0 ? previous : [];
      // 同一个 tick 只留一个样本，时钟只走 1 秒。
      const kept = previous.filter(
        (sample) => sample.at !== tick && tick - sample.at <= LIVE_OUTPUT_SAMPLE_WINDOW_MS,
      );
      return [...kept, { at: tick, tokens }];
    });
  }, [active, readOutputTokens, tick]);

  return useMemo(() => resolveLiveOutputSpeed(samples), [samples]);
}
