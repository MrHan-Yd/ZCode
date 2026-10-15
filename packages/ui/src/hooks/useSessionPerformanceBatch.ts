import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionPerformanceSnapshot } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";

const REFRESH_INTERVAL_MS = 1000;

/**
 * 批量会话统计的只读轮询：调用方给一组 sessionId，1 秒一次读回各自的累计。
 *
 * 与 `useSessionPerformance`（单会话）同一条设计线，但有三个批量特有的收口：
 *
 * - **次数与并发无关**：一次请求覆盖全部运行中的子智能体，所以子代理并发数只影响请求
 *   大小、不影响请求频率（大小上限由 wire schema 约束，见 `SESSION_PERFORMANCE_MAX_SESSIONS`）。
 * - **归位靠 scopeKey**：workspace 身份 + 本次 id 集合构成 key，key 不匹配的响应整体丢弃，
 *   否则切会话/切 workspace 后旧读数会落到新面板上。
 * - **结束即丢键**：调用方下一次传入的 id 集合就是唯一有效的键集，旧 id 的读数不残留。
 *
 * `enabled` 由调用方按「分区已挂载 + 有运行中子智能体」决定：两条都不满足时不发请求，
 * 远程 workspace 因此没有常驻流量。失败**不终止**轮询——冷启动时 agent 往往还没就绪，
 * 前几次必然失败；放弃会让行上的数字"刚才还有、现在没了"。失败时保留上一次成功读数，
 * 但对端整个方法不存在时调用方永远拿不到读数（旧 CLI 的降级形态）。
 */
export function useSessionPerformanceBatch({
  workspacePath,
  workspaceIdentity,
  sessionIds,
  enabled,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionIds: readonly string[];
  enabled: boolean;
}): { entries: readonly SessionPerformanceSnapshot[] | null; error: boolean } {
  const { zcodeAgentService } = useServices();
  const identity = workspaceIdentity?.trim() || workspacePath;
  // 同一集合内的顺序变化不该重开轮询循环，因此 key 用排序后的集合；请求本身用最新数组。
  const idsKey = useMemo(() => [...new Set(sessionIds)].sort().join("\u0000"), [sessionIds]);
  const scopeKey = JSON.stringify([identity, idsKey]);
  // 与 useSessionSubagents 同一写法：轮询闭包读 ref 里的最新值，effect 只按集合 key 重开，
  // 避免「数组每次渲染都是新引用」把循环变成每帧重开。
  const requestedIdsRef = useRef<readonly string[]>(sessionIds);
  requestedIdsRef.current = sessionIds;
  const [result, setResult] = useState<{
    key: string;
    service: typeof zcodeAgentService;
    entries: readonly SessionPerformanceSnapshot[] | null;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    if (!enabled || idsKey.length === 0) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      const requestedIds = [...new Set(requestedIdsRef.current)];
      if (requestedIds.length === 0) return;
      try {
        const response = await zcodeAgentService.readSessionPerformanceBatch({
          workspacePath,
          workspaceIdentity,
          sessionIds: requestedIds,
        });
        if (disposed) return;
        setResult({
          key: scopeKey,
          service: zcodeAgentService,
          entries: response.entries,
          error: false,
        });
      } catch {
        if (disposed) return;
        // 瞬时失败不该让行上的数字闪回空值：只有 key 还对得上才沿用上一次成功读数。
        setResult((previous) => ({
          key: scopeKey,
          service: zcodeAgentService,
          entries:
            previous?.key === scopeKey && previous.service === zcodeAgentService
              ? previous.entries
              : null,
          error: true,
        }));
      }
      if (!disposed) timer = setTimeout(() => void refresh(), REFRESH_INTERVAL_MS);
    };
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [enabled, scopeKey, idsKey, workspacePath, workspaceIdentity, zcodeAgentService]);

  const current = result?.key === scopeKey && result.service === zcodeAgentService ? result : null;
  return { entries: current?.entries ?? null, error: current?.error ?? false };
}
