/**
 * 读取某会话在 sessions-index 中的摘要（标题 / 上一轮回复预览）。
 *
 * 用途：会话冷恢复期间给「首帧加载占位」提供已有的标题与上一轮回复预览，让等待期不再是纯空白。
 *
 * 为什么走 sessions-index 而不是新开一条读消息的 RPC：侧栏已经订阅了同一 workspace 的
 * sessions-index，`lastAssistantPreview` 就在它的 SessionSummary 里；这里经 registry 的
 * refCount 复用同一个 store，既不新增订阅、也不新增协议方法，权威仍是 CLI 的 sessions-index。
 *
 * 生命周期：只有 sessionId 非空（调用方仅在 connecting 期间传入）时才持有 store 引用，
 * 用完即 release；live 之后不再占用资源。
 */
import { useLayoutEffect, useState } from "react";
import { useServices } from "@/hooks/useServices.js";
import type { SessionSummary } from "@zcode/shared/zcode-protocol-v4";
import { paneWorkspaceKey } from "@/v4/paneLayoutTree.js";
import {
  acquireSessionsIndex,
  releaseSessionsIndex,
  type SessionsIndexScope,
} from "@/v4/sessionsIndexRegistry.js";

interface SessionIndexSummaryScope {
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  remoteSessionId?: string | null | undefined;
}

export function useSessionIndexSummary(
  scope: SessionIndexSummaryScope,
  sessionId: string | null,
): SessionSummary | null {
  const { zcodeAgentService } = useServices();
  const { workspacePath, workspaceIdentity, remoteSessionId } = scope;
  const [summary, setSummary] = useState<SessionSummary | null>(null);

  useLayoutEffect(() => {
    if (!sessionId || !zcodeAgentService) {
      setSummary(null);
      return undefined;
    }
    const indexScope: SessionsIndexScope = {
      workspaceKey: paneWorkspaceKey({ workspacePath, workspaceIdentity }),
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { endpointKey: remoteSessionId } : {}),
    };
    const store = acquireSessionsIndex(indexScope, zcodeAgentService);
    let disposed = false;
    const read = () => {
      if (disposed) return;
      // workspaceId 为空 = 该 scope 还没拿到首个真 snapshot：此时「查不到」代表未知，
      // 不能当成「该会话不存在」，否则会把占位误判成已删除会话。
      const next =
        store.getState().workspaceId === null
          ? null
          : (store.getSessions().find((item) => item.sessionId === sessionId) ?? null);
      setSummary((current) => (current === next ? current : next));
    };
    const unsubscribe = store.subscribe(read);
    // 同步读一次再订阅：占位首帧就带上预览，避免先渲染一帧空预览再补上。
    read();
    return () => {
      disposed = true;
      unsubscribe();
      releaseSessionsIndex(indexScope, store);
    };
  }, [
    zcodeAgentService,
    sessionId,
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
  ]);

  return summary;
}
