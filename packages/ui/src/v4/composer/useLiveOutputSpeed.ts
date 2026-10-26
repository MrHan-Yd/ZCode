import { useEffect, useMemo, useState } from "react";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";
import {
  appendOutputSpeedSample,
  resolveLiveOutputSpeed,
  type OutputSpeedSample,
} from "@/v4/composer/liveOutputSpeed.js";

/**
 * 当前轮的实时输出速度：只做显示投影，不写回任何事实。
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
    // 纯函数负责清空/回落重置，见 appendOutputSpeedSample 的注释。
    setSamples((previous) => appendOutputSpeedSample(previous, { at: tick, tokens }));
  }, [active, readOutputTokens, tick]);

  return useMemo(() => resolveLiveOutputSpeed(samples), [samples]);
}
