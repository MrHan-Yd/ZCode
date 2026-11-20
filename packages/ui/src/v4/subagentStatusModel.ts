import type { RunningSubagentSummary } from "@zcode/shared/zcode-protocol-v4";

/**
 * 「智能体」分区里运行中子智能体的状态。
 *
 * 状态事实的唯一来源是 CLI 会话投影 `snapshot.subagents.running[].status`；UI 不缓存、
 * 不推导第二份状态，也不根据时长、标题或 TPS 猜测（见 specs/status-panel-git-tools-split.md
 * 规则 13 与 specs/status-panel-subagent-identity.md）。
 */
export type RunningSubagentStatus = RunningSubagentSummary["status"];

/** 行渲染、摘要与 TPS 轮询共同使用的状态优先级：running → waiting → blocked。 */
export const SUBAGENT_STATUS_ORDER: readonly RunningSubagentStatus[] = [
  "running",
  "waiting",
  "blocked",
] as const;

const STATUS_RANK: Record<RunningSubagentStatus, number> = {
  running: 0,
  waiting: 1,
  blocked: 2,
};

/** 未知状态（旧/异常投影）排到已知状态之后，不抢到运行中前面。 */
function rankOf(status: RunningSubagentStatus): number {
  return STATUS_RANK[status] ?? SUBAGENT_STATUS_ORDER.length;
}

/** `startedAt` 缺失或非有限值不参与组内比较：它们固定排在该状态组末尾。 */
function isFiniteStartedAt(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 规则 11：状态优先级优先（running → waiting → blocked），同状态内按 `startedAt` 升序；
 * `startedAt` 缺失或非有限值排在该状态组末尾；`startedAt` 相同的保持投影原序。
 *
 * `Array.prototype.sort` 自 ES2019 起保证稳定，因此同值项不会因每次投影刷新而跳位。
 * 排序结果同时用于行渲染与 TPS 批量读的 id 顺序（32 上限因此优先保留运行中的子智能体）。
 */
export function sortRunningSubagentsByStatus<
  T extends { status: RunningSubagentStatus; startedAt?: number },
>(subagents: readonly T[]): T[] {
  return subagents.slice().sort((left, right) => {
    const rankDiff = rankOf(left.status) - rankOf(right.status);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    const leftValue = left.startedAt;
    const rightValue = right.startedAt;
    const leftStartedAt = isFiniteStartedAt(leftValue) ? leftValue : null;
    const rightStartedAt = isFiniteStartedAt(rightValue) ? rightValue : null;
    if (leftStartedAt === null && rightStartedAt === null) {
      return 0;
    }
    if (leftStartedAt === null) {
      return 1;
    }
    if (rightStartedAt === null) {
      return -1;
    }
    return leftStartedAt - rightStartedAt;
  });
}

export interface SubagentStatusCounts {
  running: number;
  waiting: number;
  blocked: number;
}

/** 分区头与收起态摘要的唯一计数实现；只统计三种运行态。 */
export function countSubagentStatuses(
  subagents: readonly { status: RunningSubagentStatus }[],
): SubagentStatusCounts {
  const counts: SubagentStatusCounts = { running: 0, waiting: 0, blocked: 0 };
  for (const subagent of subagents) {
    const status = subagent.status;
    if (status === "running" || status === "waiting" || status === "blocked") {
      counts[status] += 1;
    }
  }
  return counts;
}

/** 摘要只列非零项；三项都为零时不渲染摘要。 */
export function hasSubagentStatusSummary(counts: SubagentStatusCounts): boolean {
  return counts.running + counts.waiting + counts.blocked > 0;
}
