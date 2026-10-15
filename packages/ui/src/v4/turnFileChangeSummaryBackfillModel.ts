import type { TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";

/**
 * 冷恢复文件变更摘要「按需回填」的纯判定与映射。
 *
 * 逻辑独立于 React，是为了让「只对缺口轮发请求」这条承重规则能被差分测试锁住——它是整个
 * 信号存在的理由：一旦判定放宽，每个没有 fileChanges 的轮都会白发一次 RPC。
 */

export type TurnFileChanges = NonNullable<TurnHeaderRow["fileChanges"]>;

/** 按需 RPC 的结果里与轮尾胶囊相关的部分（`V4ConversationFileChangesResult` 的子集）。 */
export interface FetchedFileChangesSummary {
  files: number;
  additions: number;
  deletions: number;
  state?: "active" | "reverted";
}

export function shouldBackfillTurnFileChanges(input: {
  /** header 自带 fileChanges（hydration 算出来了，或有 live 事件）时为 true。 */
  hasHydratedFileChanges: boolean;
  isRunning: boolean;
  rowId: number | undefined;
  entityId: string | undefined;
  turnId: string | undefined;
  /** host 下发的缺口清单；不在清单里的轮一律不回填。 */
  unavailableTurnIds?: ReadonlySet<string>;
  hasFetchFileChanges: boolean;
}): boolean {
  return (
    !input.hasHydratedFileChanges &&
    !input.isRunning &&
    input.rowId !== undefined &&
    input.entityId !== undefined &&
    input.turnId !== undefined &&
    input.unavailableTurnIds?.has(input.turnId) === true &&
    input.hasFetchFileChanges
  );
}

/**
 * 把按需 RPC 的结果映射成轮尾胶囊的形状。
 *
 * `state` 只在确实有变更时补：投影对 hydration 侧有变更的轮一律标 `active`，这里保持同口径，
 * 让回填出来的轮与正常 hydrate 的轮不可区分；`files === 0` 不补，免得把没改文件的轮说成可回退。
 */
export function fileChangesFromFetchedSummary(result: FetchedFileChangesSummary): TurnFileChanges {
  return {
    additions: result.additions,
    deletions: result.deletions,
    files: result.files,
    ...(result.files > 0 ? { state: result.state ?? "active" } : {}),
  };
}
