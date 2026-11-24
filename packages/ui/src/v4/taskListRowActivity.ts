import type { ZCodeTaskMeta } from "@zcode/shared";
import type {
  PendingInteractionSummary,
  SessionOrchestrationActivity,
  SessionSummary,
  SessionWorkflowActivity,
} from "@zcode/shared/zcode-protocol-v4";

// UI-only sidecar：不进入 shared task meta/schema，也不写回 tasks-index。
// 字段名使用明确的内部前缀，避免调用方把它误当成持久化 task 属性。
const TASK_LIST_ROW_ACTIVITY_FIELD = "__zcodeSessionActivity" as const;

export interface TaskListRowActivity {
  phase: SessionSummary["phase"];
  lastActivityAt: number;
  hasBackgroundWork: boolean;
  pendingInteractions?: PendingInteractionSummary;
  /** 侧栏工作流运行行的数据；无 run 时缺席。 */
  workflowActivity?: SessionWorkflowActivity;
  /** 活动编排 run 摘要；主代理轮收口后仍算运行中。缺席 = 无活动 run。 */
  orchestrationActivity?: SessionOrchestrationActivity;
}

export type TaskListMetaWithActivity = ZCodeTaskMeta & {
  [TASK_LIST_ROW_ACTIVITY_FIELD]: TaskListRowActivity;
};

export function attachTaskListRowActivity<T extends ZCodeTaskMeta>(
  task: T,
  activity: TaskListRowActivity,
): T & TaskListMetaWithActivity {
  return {
    ...task,
    [TASK_LIST_ROW_ACTIVITY_FIELD]: activity,
  };
}

export function getTaskListRowActivity(task: ZCodeTaskMeta): TaskListRowActivity | null {
  const activity = (task as Partial<TaskListMetaWithActivity>)[TASK_LIST_ROW_ACTIVITY_FIELD];
  return activity ?? null;
}

/** 只采信 sessions-index 的实时 phase；tasks-index 残留 status=running 不能置顶历史任务。 */
function isTaskListRowRunning(task: ZCodeTaskMeta): boolean {
  const activity = getTaskListRowActivity(task);
  const phase = activity?.phase;
  if (phase === "prewarming" || phase === "running") return true;
  // 编排 run 在后台派发子代理时父会话 phase 已是 completedSuccess，但会话并未真正结束。
  // 运行态口径与通知一致：有活动编排 run 就仍然算运行中。
  return (activity?.orchestrationActivity?.activeRunCount ?? 0) > 0;
}

/**
 * 列表运行层的成员判定：回合在跑（prewarming/running）**或**挂着后台工作（hasBackgroundWork）。
 *
 * 动态工作流 run 是后台工作——启动轮收口后父会话 phase 已回到 completedSuccess，
 * 但每条 run 进度事件仍会推进 lastActivityAt。运行层若只看 phase，两个各跑一个 run 的会话
 * 都落在按 updatedAt 排序的非运行层，随进度事件互相换位。后台 bash / 分离子代理同理。
 * 转圈图标仍只认 phase（isTaskListRowRunning），这里只决定排序层。
 */
export function isTaskListRowActive(task: ZCodeTaskMeta): boolean {
  return isTaskListRowRunning(task) || getTaskListRowActivity(task)?.hasBackgroundWork === true;
}

export function getTaskListAttention(
  task: ZCodeTaskMeta,
): { kind: "permission" | "userInput"; count: number } | null {
  const summary = getTaskListRowActivity(task)?.pendingInteractions;
  if (!summary) {
    return null;
  }
  const count = summary.permissionCount + summary.userInputCount;
  if (count === 0) {
    return null;
  }
  return {
    kind: summary.userInputCount > 0 ? "userInput" : "permission",
    count,
  };
}

export function mergeTaskListMembershipFields(
  activityTask: ZCodeTaskMeta,
  membershipTask: ZCodeTaskMeta,
): ZCodeTaskMeta {
  const activity = getTaskListRowActivity(activityTask);
  if (!activity) {
    return membershipTask;
  }
  const membershipOwnsUnreadAt = Object.prototype.hasOwnProperty.call(membershipTask, "unreadAt");
  // rename/pin/archive/unread 的 tasks-index 响应会携带自己的 updatedAt/status，
  // 但侧栏 activity 与 Updated 排序只属于 sessions-index。mutation 只能覆盖 membership/meta
  // 字段，不能把整行替换后让任务无真实活动却跳序或丢掉实时 phase。
  return attachTaskListRowActivity(
    {
      ...activityTask,
      ...membershipTask,
      createdAt: activityTask.createdAt,
      updatedAt: activity.lastActivityAt,
      status: activityTask.status,
      unreadAt: membershipOwnsUnreadAt ? membershipTask.unreadAt : activityTask.unreadAt,
    },
    activity,
  );
}
