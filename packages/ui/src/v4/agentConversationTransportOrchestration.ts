// createAgentConversationTransport 的编排状态查询面。与 workflow-run 查询同族：
// 只读、无状态、超时重发安全；新方法对旧桌面天然偏斜安全。
import type { IZCodeAgentService } from "@zcode/services";
import type {
  V4ConversationOrchestrationStateParams,
  V4ConversationOrchestrationStateResult,
} from "@zcode/shared/zcode-protocol-v4";

export function createOrchestrationTransportMethods(input: {
  agentService: Pick<IZCodeAgentService, "conversationOrchestrationStateV4">;
  ensureHandshake: () => Promise<unknown>;
  workspace: { workspacePath: string; workspaceIdentity?: string };
}) {
  const { agentService, ensureHandshake, workspace } = input;
  return {
    async orchestrationState(
      params: V4ConversationOrchestrationStateParams,
    ): Promise<V4ConversationOrchestrationStateResult> {
      await ensureHandshake();
      return agentService.conversationOrchestrationStateV4({
        ...workspace,
        sessionId: params.sessionId,
        ...(params.limit !== undefined ? { limit: params.limit } : {}),
      });
    },
  };
}
