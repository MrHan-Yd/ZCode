import { useSyncExternalStore } from "react";

/**
 * 标题栏「会话状态」图标与 pane 内状态面板之间的唯一握手。
 *
 * 标题栏是 workspace 级、pane 是会话级，数据（plan / 子智能体 / 编排）只存在于
 * SessionPane 的会话投影里。这里只保存「哪个 session 的面板被图标唤醒」这一个
 * UI 意图，不复制任何业务事实；store 只保留一条记录，切到别的 session 时上一条
 * 自动失效，面板不会在返回旧会话时意外重开。
 */
export interface StatusPanelOverlayState {
  sessionId: string | null;
  open: boolean;
}

const EMPTY_STATE: StatusPanelOverlayState = { sessionId: null, open: false };
let state: StatusPanelOverlayState = EMPTY_STATE;
const listeners = new Set<() => void>();
// 打开跃迁的旁路订阅：标题栏 Git 浮层与状态面板互斥，shell 在这里收到「面板刚被
// 打开」的通知后收起 Git 浮层。只在 false → true 时触发，关闭与 reset 不通知。
const openedListeners = new Set<(sessionId: string) => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function emitOpened(sessionId: string): void {
  for (const listener of openedListeners) listener(sessionId);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeStatusPanelOpened(listener: (sessionId: string) => void): () => void {
  openedListeners.add(listener);
  return () => {
    openedListeners.delete(listener);
  };
}

/** 标题栏图标点击：同一 session 再点一次收起，切到别的 session 则直接打开。 */
export function toggleStatusPanelOverlay(sessionId: string): void {
  const nextOpen = state.sessionId === sessionId ? !state.open : true;
  state = { sessionId, open: nextOpen };
  emit();
  if (nextOpen) emitOpened(sessionId);
}

/** composer 的后台任务徽标等入口：明确要求打开。 */
export function openStatusPanelOverlay(sessionId: string): void {
  if (state.sessionId === sessionId && state.open) return;
  state = { sessionId, open: true };
  emit();
  emitOpened(sessionId);
}

/** 面板自己的关闭按钮。 */
export function closeStatusPanelOverlay(sessionId: string): void {
  if (state.sessionId !== sessionId || !state.open) return;
  state = { sessionId, open: false };
  emit();
}

export function useStatusPanelOverlayOpen(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => Boolean(sessionId) && state.sessionId === sessionId && state.open,
  );
}

/** 测试与冷恢复用：清空握手状态。 */
export function resetStatusPanelOverlay(): void {
  if (state === EMPTY_STATE) return;
  state = EMPTY_STATE;
  emit();
}
