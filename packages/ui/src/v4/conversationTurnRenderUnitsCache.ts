// 会话 render units 的增量构建入口。
//
// 增量缓存由 createConversationTurnRenderUnitsBuilder() 为**每个调用点**各建一份槽：同一棵
// React 树里不同调用点常在同一帧以不同 options（nowMs/sessionPhase）调用同一份 rows，共用
// 模块级单槽会让后渲染者覆写前者的基线，增量路径永远落空。
// 依据 specs/conversation-render-units-incremental.md：流式期间 row.delta 只换目标行引用，
// 公共前缀/后缀 diff 后仅重建变化 turn 的 unit，未变 turn 保持对象引用稳定，
// 下游 memo 化组件因此跳过重渲染。语义基线（uncached）与纯函数区住在
// conversationTurnRenderUnits.ts，保证黄金不变量「增量 ≡ 全量」可对照阅读与差分测试。
import type { ConversationRow, SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import {
  aggregateDraftUnit,
  buildConversationTurnRenderUnitsUncached,
  materializeDraftUnit,
  normalizeRenderUnitPosition,
  shouldKeepRenderUnit,
  type BuildConversationTurnRenderUnitsOptions,
  type ConversationTurnRenderUnit,
} from "./conversationTurnRenderUnits.js";

interface RenderUnitsCache {
  rows: readonly ConversationRow[];
  nowMs: number | undefined;
  sessionPhase: SessionPhase | undefined;
  /** turn 顺序 = units 数组顺序（已通过 keep 过滤）。 */
  turnOrder: readonly string[];
  unitByTurnId: Map<string, ConversationTurnRenderUnit>;
}

/** 一个调用点持有的增量构建器；缓存槽状态封闭在闭包里，不与其他调用点共享。 */
export type ConversationTurnRenderUnitsBuilder = (
  rows: readonly ConversationRow[],
  options?: BuildConversationTurnRenderUnitsOptions,
) => ConversationTurnRenderUnit[];

function createRenderUnitsCache(
  rows: readonly ConversationRow[],
  nowMs: number | undefined,
  sessionPhase: SessionPhase | undefined,
  units: readonly ConversationTurnRenderUnit[],
): RenderUnitsCache {
  return {
    rows,
    nowMs,
    sessionPhase,
    turnOrder: units.map((unit) => unit.turnId),
    unitByTurnId: new Map(units.map((unit) => [unit.turnId, unit])),
  };
}

function rebuildRenderUnitsIncremental(
  rows: readonly ConversationRow[],
  cache: RenderUnitsCache,
  nowMs: number | undefined,
  sessionPhase: SessionPhase | undefined,
): { units: ConversationTurnRenderUnit[]; turnOrder: string[] } {
  // 1) 公共前缀/后缀 diff（引用比较）：变化区间内的行所属 turn 全部重建。
  //    tail window 滑动挤头、row.removed 裁尾、row.delta 换行引用都由这一步统一覆盖；
  //    snapshot 整体替换退化为全量重建（前缀后缀为 0）。
  const dirty = new Set<string>();
  const minLen = Math.min(rows.length, cache.rows.length);
  let prefix = 0;
  while (prefix < minLen && rows[prefix] === cache.rows[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    rows[rows.length - 1 - suffix] === cache.rows[cache.rows.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  for (let index = prefix; index < rows.length - suffix; index += 1) {
    dirty.add(rows[index]!.turnId);
  }
  for (let index = prefix; index < cache.rows.length - suffix; index += 1) {
    dirty.add(cache.rows[index]!.turnId);
  }

  // 2) 新 turn 顺序与每 turn 行聚合（单次遍历，只做引用比较与 push）。
  const turnOrder: string[] = [];
  const rowsByTurn = new Map<string, ConversationRow[]>();
  for (const row of rows) {
    let list = rowsByTurn.get(row.turnId);
    if (list === undefined) {
      list = [];
      rowsByTurn.set(row.turnId, list);
      turnOrder.push(row.turnId);
    }
    list.push(row);
  }

  // 3) 逐 turn 重建/复用。materialize 的 index/total 语义与 uncached 一致：keep 前的
  //    draft 序号与总数（isLastTurn 以 keep 前口径传入 workSegments 构建，再由
  //    normalize 修正 keep 后位置——与原全量路径相同）。
  const options: BuildConversationTurnRenderUnitsOptions = { nowMs, sessionPhase };
  const total = turnOrder.length;
  const materializedByTurnId = new Map<string, ConversationTurnRenderUnit>();
  const keptTurnIds: string[] = [];
  for (let index = 0; index < turnOrder.length; index += 1) {
    const turnId = turnOrder[index]!;
    if (!dirty.has(turnId)) {
      const cachedUnit = cache.unitByTurnId.get(turnId);
      if (cachedUnit !== undefined) {
        materializedByTurnId.set(turnId, cachedUnit);
        keptTurnIds.push(turnId);
      }
      // 缓存中不存在 = 上次构建时被 keep 过滤；行未变则这次同样过滤，跳过。
      continue;
    }
    const draft = aggregateDraftUnit(turnId, rowsByTurn.get(turnId) ?? []);
    const unit = materializeDraftUnit(draft, index, total, options);
    materializedByTurnId.set(turnId, unit);
    if (shouldKeepRenderUnit(unit)) {
      keptTurnIds.push(turnId);
    }
  }

  // 4) keep 后位置归一化：normalize 内部对位置属性未变的 unit 返回原引用，
  //    未受影响的 turn 因此保持引用稳定。
  const units = keptTurnIds.map((turnId) => materializedByTurnId.get(turnId)!);
  const normalized = units.map((unit, index) =>
    normalizeRenderUnitPosition(unit, index, units.length, options),
  );
  return { units: normalized, turnOrder: keptTurnIds };
}

/**
 * 为单个调用点创建增量构建器。缓存基线只在 options 完全相同时可复用，因此**必须**按调用点
 * 隔离：SessionPane（`{}`）与 ConversationTimeline（实时 `nowMs`）在同一棵树上每帧各调一次，
 * 共用一个槽会让后渲染者覆写前者的基线，增量路径永远进不去。
 */
export function createConversationTurnRenderUnitsBuilder(): ConversationTurnRenderUnitsBuilder {
  let renderUnitsCache: RenderUnitsCache | null = null;
  return function build(rows, options = {}) {
    const nowMs = options.nowMs;
    const sessionPhase = options.sessionPhase;
    // 捕获成 const：闭包内的回调里 `let` 的窄化会失效（TS18047）。
    const cache = renderUnitsCache;
    if (cache !== null && cache.nowMs === nowMs && cache.sessionPhase === sessionPhase) {
      if (cache.rows === rows) {
        return cache.turnOrder
          .map((turnId) => cache.unitByTurnId.get(turnId))
          .filter((unit): unit is ConversationTurnRenderUnit => unit !== undefined);
      }
      const rebuilt = rebuildRenderUnitsIncremental(rows, cache, nowMs, sessionPhase);
      renderUnitsCache = {
        rows,
        nowMs,
        sessionPhase,
        turnOrder: rebuilt.turnOrder,
        unitByTurnId: new Map(rebuilt.units.map((unit) => [unit.turnId, unit])),
      };
      return rebuilt.units;
    }
    const units = buildConversationTurnRenderUnitsUncached(rows, options);
    renderUnitsCache = createRenderUnitsCache(rows, nowMs, sessionPhase, units);
    return units;
  };
}
