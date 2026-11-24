import type { TaskNotificationPayload } from "@zcode/shared";
import type {
  ConversationSnapshot,
  PendingInteraction,
  SessionPhase,
  SessionSummary,
  UserInputRequestPayload,
} from "@zcode/shared/zcode-protocol-v4";
import { isSessionOrchestrationActive } from "@zcode/shared/zcode-protocol-v4";
import type { IntlInstance } from "@/i18n/index.js";

type FormatMessage = IntlInstance["formatMessage"];

function terminalStatusForPhase(
  phase: SessionPhase,
): Extract<TaskNotificationPayload["status"], "completed" | "failed"> | null {
  if (phase === "completedSuccess" || phase === "completedInterrupted") {
    return "completed";
  }
  if (phase === "error") {
    return "failed";
  }
  return null;
}

function taskTitleBody(
  title: string,
  fallbackMessageId: string,
  formatMessage: FormatMessage,
): string {
  const trimmedTitle = title.trim();
  if (trimmedTitle) {
    return formatMessage({ id: "notification.taskWithTitle" }, { title: trimmedTitle });
  }
  return formatMessage({ id: fallbackMessageId });
}

function terminalPayloadForSession(
  session: SessionSummary,
  status: Extract<TaskNotificationPayload["status"], "completed" | "failed">,
  formatMessage: FormatMessage,
): TaskNotificationPayload {
  if (status === "completed") {
    return {
      taskId: session.sessionId,
      status,
      title: formatMessage({ id: "notification.completed" }),
      body: taskTitleBody(session.title, "notification.completedBody", formatMessage),
    };
  }

  return {
    taskId: session.sessionId,
    status,
    title: formatMessage({ id: "notification.error" }),
    body: taskTitleBody(session.title, "notification.error", formatMessage),
  };
}

export function collectTerminalTaskNotificationPayloads(params: {
  previousBySessionId: ReadonlyMap<string, SessionSummary>;
  sessions: readonly SessionSummary[];
  formatMessage: FormatMessage;
}): TaskNotificationPayload[] {
  const payloads: TaskNotificationPayload[] = [];
  for (const session of params.sessions) {
    const status = terminalStatusForPhase(session.phase);
    if (!status) continue;

    // 主代理轮收口只代表这一轮结束，不代表整项工作结束：编排 run 仍在后台派发子代理时，
    // phase 已经是 completedSuccess。若此时弹「任务完成」，用户会在子代理仍在跑时收到
    // 错误的完成提示，run 结束唤醒的收尾轮再收口时又会弹第二次。这里把 completed 的
    // 判定收紧为「进入终态的 phase 边沿 + 无活动编排 run」；收尾轮完成时 activity 已离位，
    // 才会出现唯一一次完成通知。failed 仍然立即通知。
    if (status === "completed" && isSessionOrchestrationActive(session.orchestrationActivity)) {
      continue;
    }

    const previous = params.previousBySessionId.get(session.sessionId);
    if (!previous) continue;

    const previousStatus = terminalStatusForPhase(previous.phase);
    if (previousStatus === status) continue;

    payloads.push(terminalPayloadForSession(session, status, params.formatMessage));
  }
  return payloads;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlanApprovalInteraction(payload: UserInputRequestPayload): boolean {
  if (payload.toolName === "ExitPlanMode") {
    return true;
  }
  if (!isPlainRecord(payload.schema)) {
    return false;
  }
  return (
    payload.schema.interaction === "plan_approval" || payload.schema.toolName === "ExitPlanMode"
  );
}

function pendingInteractionPayload(params: {
  snapshot: ConversationSnapshot;
  interaction: PendingInteraction;
  formatMessage: FormatMessage;
}): TaskNotificationPayload | null {
  const { snapshot, interaction, formatMessage } = params;
  const requestId = interaction.interactionId;
  const taskId = snapshot.sessionId;
  const taskTitle = snapshot.meta.title;

  // workspace Hook review 的唯一入口是 Settings；不得把它伪装成
  // permission/elicitation 系统通知。
  if (interaction.payload.kind === "workspaceHookReview") {
    return null;
  }

  if (interaction.payload.kind === "permission") {
    return {
      taskId,
      status: "permission_request",
      requestId,
      title: formatMessage({ id: "notification.permissionRequired" }),
      body:
        interaction.payload.summary.trim() ||
        taskTitleBody(taskTitle, "notification.permissionRequired", formatMessage),
    };
  }

  if (isPlanApprovalInteraction(interaction.payload)) {
    return {
      taskId,
      status: "elicitation_request",
      requestId,
      title: formatMessage({ id: "notification.planApprovalRequired" }),
      body: formatMessage({ id: "notification.planApprovalBody" }),
    };
  }

  return {
    taskId,
    status: "elicitation_request",
    requestId,
    title: formatMessage({ id: "notification.inputRequired" }),
    body:
      interaction.payload.prompt.trim() ||
      taskTitleBody(taskTitle, "notification.inputRequired", formatMessage),
  };
}

export function collectPendingInteractionNotificationPayloads(params: {
  snapshot: ConversationSnapshot;
  seenRequestIds: ReadonlySet<string>;
  formatMessage: FormatMessage;
}): TaskNotificationPayload[] {
  return params.snapshot.pendingInteractions
    .filter((interaction) => !params.seenRequestIds.has(interaction.interactionId))
    .flatMap((interaction) => {
      const payload = pendingInteractionPayload({
        snapshot: params.snapshot,
        interaction,
        formatMessage: params.formatMessage,
      });
      return payload ? [payload] : [];
    });
}
