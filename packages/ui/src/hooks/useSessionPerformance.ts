import { useEffect, useState } from "react";
import type { SessionPerformanceSummary } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";

const REFRESH_INTERVAL_MS = 1000;

/**
 * 会话统计只读轮询。`enabled` 由调用方按「运行中 / 面板打开 / settle 窗口」决定：
 * 空闲且面板关闭时不发请求，远程 workspace 因此没有常驻流量。
 * 快照按 scopeKey 归属，切会话后旧结果不能落到新会话上。
 *
 * 失败不终止轮询：app 冷启动时 agent 还没就绪，前几次必然失败；一旦在这里放弃，
 * 入口就要等下一次依赖变化才会再试，表现为「刚才还有、现在没了」。
 * 对端根本不支持该方法时按同样节奏重试即可——enabled 已经把空闲时段排除掉了。
 */
export function useSessionPerformance({
  workspacePath,
  workspaceIdentity,
  sessionId,
  enabled,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
  enabled: boolean;
}) {
  const { zcodeAgentService } = useServices();
  const scopeKey = JSON.stringify([workspaceIdentity?.trim() || workspacePath, sessionId]);
  const [result, setResult] = useState<{
    key: string;
    service: typeof zcodeAgentService;
    summary: SessionPerformanceSummary | null;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const snapshot = await zcodeAgentService.readSessionPerformance({
          workspacePath,
          workspaceIdentity,
          sessionId,
        });
        if (disposed) return;
        setResult({
          key: scopeKey,
          service: zcodeAgentService,
          summary: snapshot.summary,
          error: false,
        });
      } catch {
        if (disposed) return;
        // 保留上一次的成功读数：瞬时失败不该让入口数字闪回空值。
        setResult((previous) => ({
          key: scopeKey,
          service: zcodeAgentService,
          summary:
            previous?.key === scopeKey && previous.service === zcodeAgentService
              ? previous.summary
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
  }, [enabled, scopeKey, sessionId, workspaceIdentity, workspacePath, zcodeAgentService]);

  const current = result?.key === scopeKey && result.service === zcodeAgentService ? result : null;
  return { summary: current?.summary ?? null, error: current?.error ?? false };
}
