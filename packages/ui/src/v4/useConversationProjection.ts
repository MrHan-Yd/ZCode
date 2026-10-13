import { useCallback, useRef, useSyncExternalStore } from "react";
import type { ConversationStoreState } from "@/v4/conversationProjectionStore.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";

const CLOSED_STATE: ConversationStoreState = {
  status: "closed",
  snapshot: null,
  subscriptionId: null,
  lastError: null,
  optimisticCommands: [],
  loadingOlder: false,
  sessionPlans: [],
  planDirectoryRevision: 0,
  plansLoading: false,
  turnNavigatorDirectoryRevision: 0,
};

/** 订阅 per-session projection store（useSyncExternalStore，row 级 selector 在组件内再做）。 */
export function useConversationProjection(lease: SessionLease | null): ConversationStoreState {
  const store = lease?.store ?? null;
  return useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? (() => {}),
    () => store?.getState() ?? CLOSED_STATE,
    () => CLOSED_STATE,
  );
}

/**
 * 切片订阅：组件只在自己消费的字段变化时重渲染。
 *
 * 流式期间每个 delta 帧都会更新 `snapshot`，整桶订阅会让所有订阅者每帧重渲染。
 * `applyConversationDelta` 已做结构共享（`row.delta` 只重建 window 数组与目标行，
 * 其余键浅拷贝保留引用），因此返回 state 内部引用的 selector（字段、数组内对象、
 * find 结果）在切片未变化时引用稳定，订阅者跳过重渲染。
 *
 * 约束：selector 必须是纯函数且返回值来自 state 内部引用，不得构造新对象——
 * 否则引用永远不稳定，退化为整桶订阅。依据 specs/conversation-projection-slice-subscription.md。
 */
export function useConversationProjectionValue<T>(
  lease: SessionLease | null,
  selector: (state: ConversationStoreState) => T,
): T {
  const store = lease?.store ?? null;
  // (state 引用 → selector 结果) 缓存：state 未变时返回缓存值，保证 getSnapshot
  // 返回引用稳定，避免 useSyncExternalStore 的重渲染循环。
  const cacheRef = useRef<{ state: ConversationStoreState; value: T } | null>(null);
  const getSnapshot = useCallback(() => {
    const state = store?.getState() ?? CLOSED_STATE;
    const last = cacheRef.current;
    if (last && last.state === state) {
      return last.value;
    }
    const value = selector(state);
    cacheRef.current = { state, value };
    return value;
  }, [store, selector]);
  return useSyncExternalStore(
    (listener) => store?.subscribe(listener) ?? (() => {}),
    getSnapshot,
    () => selector(CLOSED_STATE),
  );
}
