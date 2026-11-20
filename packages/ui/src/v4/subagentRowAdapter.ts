// 时间线复用 Agent 工具行：编排派发的 subagent 行没有对应的 Agent/Task 工具行，
// 因此不会与工具卡配对。这里在渲染派生层把它合成成 ToolCallBlock 可消费的节点，
// 与手动 Agent 行共用同一个 renderer。合成只发生在这里，不写回协议或投影。
import type { SubagentRow } from "@zcode/shared/zcode-protocol-v4";
import type { TaskChatToolCallTreeNode } from "@/lib/toolCallTree.js";

// subagent 投影状态 → 旧 ChatToolCall.status 词表（mapToolStatus 的输入）。
const SUBAGENT_STATUS_MAP: Record<SubagentRow["status"], string> = {
  running: "in_progress",
  success: "completed",
  failed: "failed",
  cancelled: "stopped",
};

/**
 * 把编排派发的 subagent 行派生为 Agent 工具节点。
 *
 * 标题、角色名、状态词全部交给既有 Agent 渲染器解析，保证与手动 Agent 行逐字一致；
 * 这里刻意不伪造 output / content / error / display：子智能体的详细步骤在状态面板
 * 「编排计划」分区查看，时间线只保留 Agent 工具行摘要。
 */
export function subagentRowToAgentToolCallNode(row: SubagentRow): TaskChatToolCallTreeNode {
  return {
    toolCall: {
      // childSessionId 是投影里最稳定的子会话身份；缺失时退回 rowId，保证同一行 key 稳定。
      toolId: row.childSessionId ? `subagent:${row.childSessionId}` : `subagent:${row.rowId}`,
      toolName: "Agent",
      kind: "Agent",
      input: {
        description: row.summaryText,
        subagent_type: row.subagentType,
      },
      status: SUBAGENT_STATUS_MAP[row.status],
      raw: { inputPreviewComplete: true, v4Status: row.status },
      // startedAt 只在投影给出时透传，避免写入 undefined 冒充投影事实。
      ...(typeof row.startedAt === "number" ? { startedAt: row.startedAt } : {}),
    },
    // 详细步骤由状态面板展示，时间线不内嵌伪造的 child 工具。
    childToolCalls: [],
  };
}
