import {
  createSessionId,
  selectActiveConversationBranch,
  SessionEventType,
  type MessageWithParts,
  type SessionEvent,
  type SessionInfo,
  type ToolPart,
} from "@zcode/contracts";
import { parseZCodeBackgroundTaskNotificationText } from "@zcode/shared";

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);
const SUBAGENT_UNNAMED_TYPE = "subagent";
const TASK_NOTIFICATION_PATTERN = /<task-notification>[\s\S]*?(?=<task-notification>|$)/gu;
const AGENT_NOTIFICATION_SUMMARY_PATTERN =
  /^Agent (\S+) task "([\s\S]+?)" (?:completed|failed|stopped)\./u;

type TerminalStatus = "success" | "failed" | "cancelled" | "lost";

export interface SubagentCandidate {
  agentId?: string;
  childSessionId: string;
  runInBackground: boolean;
  output: Record<string, unknown> | null;
  toolCallId: string;
  toolState?: ToolPart["state"];
  subagentType: string;
  summary?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: TerminalStatus;
  title: string;
}

interface SubagentEventRelation {
  agentId?: string;
  childSessionId?: string;
  description?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: TerminalStatus;
  subagentType?: string;
  summary?: string;
}

export function asSubagentRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function subagentStringField(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function terminalStatus(status: string | undefined): TerminalStatus | undefined {
  switch (status) {
    case "completed":
    case "success":
      return "success";
    case "failed":
    case "error":
    case "timed_out":
    case "spawn_error":
      return "failed";
    case "cancelled":
    case "stopped":
    case "killed":
      return "cancelled";
    case "lost":
      return "lost";
    default:
      return undefined;
  }
}

function subagentEventRelations(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  notifications: readonly SubagentCandidate[],
  events: readonly SessionEvent[] | undefined,
): ReadonlyMap<string, SubagentEventRelation> {
  const relations = new Map<string, SubagentEventRelation>();
  const activeTurnIds = new Set(
    messages.flatMap((message) =>
      message.info.anchor?.turnId ? [String(message.info.anchor.turnId)] : [],
    ),
  );
  const activeToolCallIds = new Set([
    ...messages.flatMap((message) =>
      message.parts.flatMap((part) => (part.type === "tool" ? [String(part.callID)] : [])),
    ),
    ...notifications.map((candidate) => candidate.toolCallId),
  ]);
  for (const event of events ?? []) {
    if (
      event.sessionId !== session.id ||
      (event.type !== SessionEventType.SubagentSpawned &&
        event.type !== SessionEventType.SubagentStopped)
    )
      continue;
    const payload = asSubagentRecord(event.payload);
    const toolCallId = subagentStringField(payload, "parentToolCallId");
    if (!toolCallId) continue;
    // rewind 后的事件账本仍可能留有旧分支；只有活动消息或通知证明归属的关系才可补回。
    if (
      session.revert?.targetMessageID &&
      !activeToolCallIds.has(toolCallId) &&
      (!event.turnId || !activeTurnIds.has(String(event.turnId)))
    )
      continue;
    const current = relations.get(toolCallId) ?? {};
    const common = {
      ...current,
      agentId: subagentStringField(payload, "agentId") ?? current.agentId,
      childSessionId: subagentStringField(payload, "childSessionId") ?? current.childSessionId,
      subagentType: subagentStringField(payload, "agentType") ?? current.subagentType,
      description: subagentStringField(payload, "description", "prompt") ?? current.description,
    };
    relations.set(
      toolCallId,
      event.type === SessionEventType.SubagentSpawned
        ? {
            ...common,
            startedAt: event.timestamp.getTime(),
          }
        : {
            ...common,
            stoppedAt: event.timestamp.getTime(),
            stoppedStatus: terminalStatus(subagentStringField(payload, "status")) ?? "success",
            summary:
              subagentStringField(payload, "summaryText", "result", "error") ?? current.summary,
          },
    );
  }
  return relations;
}

function candidateFromToolPart(
  part: ToolPart,
  relation?: SubagentEventRelation,
): SubagentCandidate | null {
  if (!SUBAGENT_TOOL_NAMES.has(part.tool)) return null;
  const completedOutput = part.state.status === "completed" ? part.state.output?.trim() : undefined;
  let output: Record<string, unknown> | null = null;
  if (completedOutput) {
    try {
      output = asSubagentRecord(JSON.parse(completedOutput));
    } catch {
      /* 后台 launch ACK 是纯文本。 */
    }
  }
  const input = asSubagentRecord(part.state.input);
  const metadata = {
    ...asSubagentRecord(part.metadata),
    ...("metadata" in part.state ? asSubagentRecord(part.state.metadata) : {}),
  };
  const agentId =
    subagentStringField(output ?? {}, "agentId") ??
    completedOutput?.match(/(?:^|\n)agentId:\s*([^\s(]+)/u)?.[1] ??
    subagentStringField(metadata, "agentId") ??
    relation?.agentId;
  const childSessionId =
    subagentStringField(output ?? {}, "childSessionId") ??
    subagentStringField(metadata, "childSessionId") ??
    relation?.childSessionId ??
    (agentId ? createSessionId(`subagent_${agentId}`) : undefined);
  if (!childSessionId) return null;
  const content = Array.isArray(output?.content)
    ? output.content
        .map((block) => subagentStringField(asSubagentRecord(block), "text"))
        .filter(Boolean)
        .join("\n\n")
    : undefined;
  return {
    childSessionId,
    runInBackground: input.run_in_background === true,
    output,
    toolCallId: part.callID,
    toolState: part.state,
    agentId: agentId ?? part.callID,
    title:
      subagentStringField(output ?? {}, "description") ??
      subagentStringField(input, "description") ??
      subagentStringField(metadata, "description") ??
      relation?.description ??
      subagentStringField(input, "prompt") ??
      "Subagent",
    subagentType:
      subagentStringField(output ?? {}, "agentType") ??
      subagentStringField(metadata, "agentType") ??
      relation?.subagentType ??
      subagentStringField(input, "subagent_type", "agent", "agentType") ??
      SUBAGENT_UNNAMED_TYPE,
    summary:
      content ||
      subagentStringField(output ?? {}, "result", "summary") ||
      (part.state.status === "error" ? part.state.error.trim() : undefined) ||
      relation?.summary,
    startedAt: relation?.startedAt ?? ("time" in part.state ? part.state.time.start : undefined),
    // Agent 产物写入可能晚于 child 完成才失败；冷查询比较终态必须保留真实工具结束时间，而非把 ACK 当终态。
    stoppedAt:
      relation?.stoppedAt ??
      ("time" in part.state && "end" in part.state.time ? part.state.time.end : undefined),
    stoppedStatus: relation?.stoppedStatus,
  };
}

function candidatesFromNotification(message: MessageWithParts): SubagentCandidate[] {
  if (
    message.info.role !== "user" ||
    message.info.synthetic !== true ||
    message.info.source !== "background_task"
  )
    return [];
  const origin = asSubagentRecord(
    message.info.metadata?.originMeta ??
      message.parts.find((part) => part.type === "text")?.metadata?.originMeta,
  );
  const workId = subagentStringField(origin, "workId");
  if (!workId) return [];
  const text = message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n\n");
  // formatter 会截断大结果的尾部；身份和终态在通知头，缺外层闭合标签不等于没有历史。
  const notifications = [...text.matchAll(TASK_NOTIFICATION_PATTERN)].flatMap((match) => {
    const parsed = parseZCodeBackgroundTaskNotificationText(match[0]);
    return parsed ? [parsed] : [];
  });
  // 批量只保留首项的展示 metadata，来源可能是 Bash；逐条识别系统 Agent 通知，不能按代表来源过滤整批。
  if (!notifications.some(({ notification }) => notification.taskId === workId)) return [];
  const isBatch = notifications.length > 1;
  return notifications.flatMap(({ toolUseId, notification }) => {
    const agentId = notification.taskId;
    const stoppedStatus = terminalStatus(notification.status);
    if (!agentId || !stoppedStatus) return [];
    const summaryIdentity = notification.summary?.match(AGENT_NOTIFICATION_SUMMARY_PATTERN);
    if ((!isBatch && origin.backgroundSource !== "subagent") || (isBatch && !summaryIdentity))
      return [];
    return [
      {
        agentId,
        childSessionId: createSessionId(`subagent_${agentId}`),
        toolCallId: toolUseId,
        runInBackground: true,
        output: null,
        subagentType: summaryIdentity?.[1] ?? SUBAGENT_UNNAMED_TYPE,
        title:
          (!isBatch && agentId === workId ? subagentStringField(origin, "title") : undefined) ??
          summaryIdentity?.[2] ??
          "Subagent",
        summary:
          stoppedStatus === "failed" || stoppedStatus === "lost"
            ? (notification.error ?? notification.result ?? notification.summary)
            : (notification.result ?? notification.error ?? notification.summary),
        stoppedStatus,
        stoppedAt: message.info.time.created,
      },
    ];
  });
}

function mergeCandidate(
  current: SubagentCandidate | undefined,
  next: SubagentCandidate,
): SubagentCandidate {
  if (!current) return next;
  const latestStop = (next.stoppedAt ?? 0) >= (current.stoppedAt ?? 0) ? next : current;
  return {
    ...next,
    ...current,
    subagentType:
      current.subagentType === SUBAGENT_UNNAMED_TYPE ? next.subagentType : current.subagentType,
    startedAt: current.startedAt ?? next.startedAt,
    stoppedAt: latestStop.stoppedAt,
    stoppedStatus: latestStop.stoppedStatus ?? current.stoppedStatus ?? next.stoppedStatus,
    summary:
      latestStop.stoppedAt !== undefined ? latestStop.summary : (current.summary ?? next.summary),
  };
}

export function collectSubagentCandidates(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): SubagentCandidate[] {
  const activeMessages = selectActiveConversationBranch(messages, {
    branchCutAfterMessageId: session.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session.revert?.createdMessageID,
    rewindKeptMessageIds: session.revert?.keptMessageIDs,
    rewindTargetMessageId: session.revert?.targetMessageID,
  });
  const notifications = activeMessages.flatMap(candidatesFromNotification);
  const relations = subagentEventRelations(session, activeMessages, notifications, parentEvents);
  const candidates = new Map<string, SubagentCandidate>();
  for (const message of activeMessages) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const candidate = candidateFromToolPart(part, relations.get(part.callID));
      if (candidate)
        candidates.set(
          candidate.childSessionId,
          mergeCandidate(candidates.get(candidate.childSessionId), candidate),
        );
    }
  }
  for (const candidate of notifications)
    candidates.set(
      candidate.childSessionId,
      mergeCandidate(candidates.get(candidate.childSessionId), candidate),
    );
  // 编排直接派发没有 Agent/Task part，事件与持久完成通知本身就是子会话关联，不能要求工具行配对。
  for (const [toolCallId, relation] of relations) {
    const childSessionId =
      relation.childSessionId ??
      (relation.agentId ? createSessionId(`subagent_${relation.agentId}`) : undefined);
    if (!childSessionId) continue;
    const candidate: SubagentCandidate = {
      ...relation,
      childSessionId,
      toolCallId,
      runInBackground: true,
      output: null,
      title: relation.description ?? "Subagent",
      subagentType: relation.subagentType ?? SUBAGENT_UNNAMED_TYPE,
    };
    candidates.set(childSessionId, mergeCandidate(candidates.get(childSessionId), candidate));
  }
  return [...candidates.values()];
}
