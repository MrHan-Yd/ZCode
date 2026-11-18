import { useCallback, useEffect, useRef, useState } from "react";
import type {
  OrchestrationConfigState,
  OrchestrationRunProjection,
  V4ConversationOrchestrationStateResult,
} from "@zcode/shared/zcode-protocol-v4";
import { useV4Conversation } from "@/v4/V4ConversationContext.js";
import { logger } from "@/logger.js";

/**
 * 编排状态读取。
 *
 * 权威在 CLI runtime；这里只是只读投影缓存。活动 run 或已开启编排时低频轮询，
 * 发送 ACK / 手动刷新会立即重取。旧 CLI 不支持该方法时进入 unsupported，入口
 * fail-closed 隐藏，不做本地猜测。
 */

export type OrchestrationStateStatus = "idle" | "loading" | "ready" | "unsupported" | "error";

export interface OrchestrationStateView {
  status: OrchestrationStateStatus;
  config: OrchestrationConfigState;
  runs: readonly OrchestrationRunProjection[];
  refresh: () => void;
}

const IDLE_CONFIG: OrchestrationConfigState = {
  enabled: false,
  team: [],
  maxConcurrency: 3,
};
const POLL_MS = 3_000;

export function useOrchestrationState(input: {
  sessionId: string | null;
  /** 会话仍在草稿态时不查询；预热会话可以查。 */
  enabled: boolean;
  /** 发送 ACK、停止、切换团队后抬升，触发立即重取。 */
  refreshKey?: number;
}): OrchestrationStateView {
  const { orchestrationState } = useV4Conversation();
  const { sessionId, enabled, refreshKey = 0 } = input;
  const [state, setState] = useState<{
    status: OrchestrationStateStatus;
    config: OrchestrationConfigState;
    runs: readonly OrchestrationRunProjection[];
    sessionId: string | null;
  }>({ status: "idle", config: IDLE_CONFIG, runs: [], sessionId: null });
  const [generation, setGeneration] = useState(0);
  const unsupportedSessionRef = useRef<string | null>(null);

  const refresh = useCallback(() => setGeneration((value) => value + 1), []);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setState({ status: "idle", config: IDLE_CONFIG, runs: [], sessionId });
      return;
    }
    if (unsupportedSessionRef.current === sessionId) {
      setState({ status: "unsupported", config: IDLE_CONFIG, runs: [], sessionId });
      return;
    }
    let alive = true;
    setState((current) =>
      current.sessionId === sessionId && current.status === "ready"
        ? current
        : { status: "loading", config: IDLE_CONFIG, runs: [], sessionId },
    );
    orchestrationState({ sessionId, limit: 8 }).then(
      (result: V4ConversationOrchestrationStateResult) => {
        if (!alive) return;
        setState({ status: "ready", config: result.config, runs: result.runs, sessionId });
      },
      (error: unknown) => {
        if (!alive) return;
        if (isOrchestrationCapabilityMissing(error)) {
          unsupportedSessionRef.current = sessionId;
          setState({ status: "unsupported", config: IDLE_CONFIG, runs: [], sessionId });
          return;
        }
        logger.warn("[orchestration] 读取状态失败", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
        setState({ status: "error", config: IDLE_CONFIG, runs: [], sessionId });
      },
    );
    return () => {
      alive = false;
    };
  }, [enabled, generation, orchestrationState, refreshKey, sessionId]);

  const shouldPoll =
    state.status === "ready" && (state.config.enabled || state.runs.some((run) => run.active));
  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(refresh, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, shouldPoll]);

  return { status: state.status, config: state.config, runs: state.runs, refresh };
}

function isOrchestrationCapabilityMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /capability|not supported|unsupported|method not found|-32601/i.test(message) ||
    /fault\.command\.capabilityUnsupported/i.test(message)
  );
}
