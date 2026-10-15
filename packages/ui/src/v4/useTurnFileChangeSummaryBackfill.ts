import { useEffect, useMemo, useState } from "react";
import type { TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { logger } from "@/logger.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import {
  fileChangesFromFetchedSummary,
  shouldBackfillTurnFileChanges,
  type TurnFileChanges,
} from "@/v4/turnFileChangeSummaryBackfillModel.js";

/**
 * 冷恢复没能算出文件变更摘要的轮，按需回填。
 *
 * 投影刻意在 `files === 0` 时不给 turnHeader 挂 `fileChanges`，于是客户端无法从「没有
 * fileChanges」反推「这轮改过文件」——两者形态完全一样。host 因此用
 * `snapshot.fileChangeSummaryUnavailableTurnIds` 显式说明缺口，这里**只对缺口里的轮**发一次
 * RPC，取回后补齐轮尾面板与 rewind 门控。不在缺口里的轮一次 RPC 都不发，这正是该信号存在的
 * 唯一理由：否则每个无变更的轮都要白发一次请求。
 *
 * 复用的是 SessionPane 已建立的 `fileChangesRequestCache`（按 logEpoch/rowId/entityId 缓存
 * 终态结果），所以虚拟行卸载再挂载不会重复请求。
 */
export function useTurnFileChangeSummaryBackfill(input: {
  header: TurnHeaderRow | undefined;
  isRunning: boolean;
  unavailableTurnIds?: ReadonlySet<string>;
  fetchFileChanges?: ConversationRowRenderContext["fetchFileChanges"];
}): TurnFileChanges | undefined {
  const { header, isRunning, unavailableTurnIds, fetchFileChanges } = input;
  const hydrated = header?.fileChanges;
  const entityId = header?.entityId;
  const rowId = header?.rowId;
  const turnId = header?.turnId;
  const needsBackfill = shouldBackfillTurnFileChanges({
    hasHydratedFileChanges: hydrated !== undefined,
    isRunning,
    rowId,
    entityId,
    turnId,
    unavailableTurnIds,
    hasFetchFileChanges: fetchFileChanges !== undefined,
  });

  const target = useMemo(
    () =>
      needsBackfill && entityId !== undefined && rowId !== undefined ? { rowId, entityId } : null,
    [needsBackfill, entityId, rowId],
  );
  const requestKey = target ? `${target.rowId}:${target.entityId}` : undefined;
  const [fetched, setFetched] = useState<{ key: string; fileChanges: TurnFileChanges } | null>(
    null,
  );

  useEffect(() => {
    if (!target || !requestKey || !fetchFileChanges) return;
    let disposed = false;
    void fetchFileChanges(target, { cachePolicy: "terminal" }).then(
      (result) => {
        if (disposed) return;
        setFetched({ key: requestKey, fileChanges: fileChangesFromFetchedSummary(result) });
      },
      (error: unknown) => {
        // 回填失败不抛：缺口本身是降级态，UI 保持「没有该胶囊」即可，但必须留痕。
        logger.warn("[v4-pane] 回填文件变更摘要失败", {
          error: error instanceof Error ? error.message : String(error),
          rowId: target.rowId,
        });
      },
    );
    return () => {
      disposed = true;
    };
  }, [fetchFileChanges, requestKey, target]);

  if (hydrated !== undefined) return hydrated;
  return fetched !== null && fetched.key === requestKey ? fetched.fileChanges : undefined;
}
