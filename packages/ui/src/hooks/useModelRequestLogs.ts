import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ModelRequestLogsServiceRequest, ModelRequestLogsSnapshot } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import {
  canReuseRequestLogSnapshot,
  createRequestLogGeneration,
  type ModelRequestLogsQuery,
} from "@/lib/modelRequestLogs.js";
import { logger } from "@/logger.js";

export function useModelRequestLogs(
  query: ModelRequestLogsQuery,
  enabled: boolean,
  target: Pick<
    ModelRequestLogsServiceRequest,
    "workspacePath" | "workspaceIdentity" | "remoteSessionId"
  >,
) {
  const { usageStatsService } = useServices();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { workspacePath, workspaceIdentity, remoteSessionId } = target;
  const request = useMemo(
    () => ({ ...query, timeZone, workspacePath, workspaceIdentity, remoteSessionId }),
    [query, timeZone, workspacePath, workspaceIdentity, remoteSessionId],
  );
  const scope = useMemo(
    () => ({ service: usageStatsService, request, enabled }),
    [usageStatsService, request, enabled],
  );
  // 目标环境标识：只用于判断上一次结果能否继续展示，不参与请求参数。
  const targetKey = useMemo(
    () =>
      JSON.stringify([
        workspacePath ?? null,
        workspaceIdentity ?? null,
        remoteSessionId ?? null,
        timeZone,
      ]),
    [workspacePath, workspaceIdentity, remoteSessionId, timeZone],
  );
  const generation = useRef(createRequestLogGeneration()).current;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const [state, setState] = useState<{
    scope: typeof scope;
    targetKey: string;
    snapshot: ModelRequestLogsSnapshot | null;
    /** 产生该快照的查询标识：同一查询刷新失败可继续展示，换筛选后失败则不能。 */
    snapshotScope: typeof scope | null;
    loading: boolean;
    error: boolean;
  }>({ scope, targetKey, snapshot: null, snapshotScope: null, loading: enabled, error: false });

  const refresh = useCallback(async () => {
    if (!enabled) return;
    const version = generation.start();
    setState((previous) => {
      // 同一环境、同一视图的上一次结果在新响应到达前继续展示，避免筛选切换时
      // 表格整块卸载又重建（闪屏、滚动条抖动）。视图变化会换列结构，不能复用。
      const reusable =
        previous.snapshot !== null &&
        canReuseRequestLogSnapshot(
          { targetKey: previous.targetKey, view: previous.snapshot.view },
          { targetKey, view: request.view },
        );
      return {
        scope,
        targetKey,
        snapshot: reusable ? previous.snapshot : null,
        snapshotScope: reusable ? previous.snapshotScope : null,
        loading: true,
        error: false,
      };
    });
    try {
      const snapshot = await usageStatsService.getModelRequestLogs(request);
      if (generation.isCurrent(version) && currentScope.current === scope) {
        setState({
          scope,
          targetKey,
          snapshot,
          snapshotScope: scope,
          loading: false,
          error: false,
        });
      }
    } catch {
      if (generation.isCurrent(version) && currentScope.current === scope) {
        logger.warn("[useModelRequestLogs] 模型请求日志查询失败", {
          view: request.view,
          range: request.range,
        });
        setState((previous) => ({
          ...previous,
          loading: false,
          error: true,
          // 换筛选后失败时不能继续展示旧筛选的行，否则会被读成新筛选的结果。
          snapshot: previous.snapshotScope === scope ? previous.snapshot : null,
          snapshotScope: previous.snapshotScope === scope ? previous.snapshotScope : null,
        }));
      }
    }
  }, [enabled, generation, request, scope, targetKey, usageStatsService]);

  useEffect(() => {
    void refresh();
    return () => generation.invalidate();
  }, [generation, refresh]);

  const matching = state.scope === scope;
  // 切换视图/筛选后、新响应到达前，展示仍可复用的上一次结果（置灰由调用方处理）。
  const snapshot = enabled
    ? state.snapshot &&
      canReuseRequestLogSnapshot(
        { targetKey: state.targetKey, view: state.snapshot.view },
        { targetKey, view: request.view },
      )
      ? state.snapshot
      : null
    : null;
  // 计数与总数与视图无关：同一目标环境内切换视图/筛选/翻页时保留上一次成功结果，
  // 避免标签与分页栏的数字退回占位符导致整行宽度跳动。
  const retained = enabled && state.targetKey === targetKey ? state.snapshot : null;
  return {
    snapshot,
    counts: retained?.counts ?? null,
    totalCount: retained?.totalCount ?? null,
    loading: enabled && (!matching || state.loading),
    error: enabled && matching && state.error,
    refresh,
  };
}
