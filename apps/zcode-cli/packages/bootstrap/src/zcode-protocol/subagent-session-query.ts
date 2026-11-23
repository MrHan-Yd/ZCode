import { Buffer } from "node:buffer";
import {
  type BackgroundTaskInfo,
  type MessageWithParts,
  type SessionEvent,
  type SessionInfo,
  type SessionProjection,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
} from "@zcode/contracts";
import type { ZCodeSessionEndedSubagent, ZCodeSessionRunningSubagent } from "@zcode/shared";
import {
  asSubagentRecord as asRecord,
  collectSubagentCandidates,
  subagentStringField as stringField,
  type SubagentCandidate,
} from "./subagent-session-candidates.js";

const CANCELLATION_PATTERN = /abort|cancel|interrupt|stop/i;

interface SessionSubagentProjection {
  revision: number;
  running: ZCodeSessionRunningSubagent[];
  ended: ZCodeSessionEndedSubagent[];
}

interface ProjectSessionSubagentsInput {
  revision: number;
  parentSession: SessionInfo;
  messages: readonly MessageWithParts[];
  childSessionsById: ReadonlyMap<string, SessionInfo>;
  childMessagesById: ReadonlyMap<string, readonly MessageWithParts[]>;
  childProjectionsById: ReadonlyMap<string, SessionProjection>;
  parentProjection?: SessionProjection;
  parentEvents?: readonly SessionEvent[];
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function collectSubagentChildSessionIds(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): string[] {
  return collectSubagentCandidates(session, messages, parentEvents).map(
    (candidate) => candidate.childSessionId,
  );
}

function lastChildOutcome(messages: readonly MessageWithParts[] | undefined): {
  endedAt?: number;
  status?: "success" | "failed" | "cancelled";
  summary?: string;
} {
  if (!messages || messages.length === 0) return {};
  const assistantMessages = messages.filter((message) => message.info.role === "assistant");
  const last = assistantMessages.at(-1);
  if (!last || last.info.role !== "assistant") return {};
  // stream recovery 作废的半截 assistant 带 error 落盘，但子会话紧接着会从锚点
  // 重发；它是最后一条只说明恢复仍在进行或进程已退出，都不是「子会话失败」的终态。
  if (last.info.error && last.info.error.name === STREAM_RECOVERY_DISCARDED_ERROR_NAME) {
    return {};
  }
  const text = last.parts
    .flatMap((part) => (part.type === "text" && part.ignored !== true ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n");
  const errorName = last.info.error?.name;
  const errorSummary = last.info.error
    ? (stringField(last.info.error.data ?? {}, "message", "error", "detail") ?? errorName)
    : undefined;
  const hasToolRound = last.parts.some((part) => part.type === "tool");
  return {
    ...(last.info.time.completed ? { endedAt: last.info.time.completed } : {}),
    ...(text || errorSummary ? { summary: text || errorSummary } : {}),
    ...(errorName
      ? { status: CANCELLATION_PATTERN.test(errorName) ? "cancelled" : "failed" }
      : // assistant 发出 tool call 后，该 model step 也会写 completed/finish；
        // 但 child session 仍在执行 Bash 等工具，不能把“本轮结束”当成“子会话终态”。
        // 只有不含 tool part 的最终 assistant message 才能提供成功 outcome。
        !hasToolRound && (last.info.time.completed || last.info.finish)
        ? { status: "success" }
        : {}),
  };
}

function findBackgroundTask(
  projection: SessionProjection | undefined,
  candidate: SubagentCandidate,
): BackgroundTaskInfo | undefined {
  return projection?.backgroundTasks.find(
    (task) =>
      task.taskKind === "subagent" &&
      (task.childSessionId === candidate.childSessionId ||
        task.toolCallId === candidate.toolCallId ||
        task.taskId === candidate.agentId),
  );
}

function runningStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
  parentProjection?: SessionProjection;
}): ZCodeSessionRunningSubagent["status"] | undefined {
  if (input.background?.status === "running") {
    return input.background.blocked ? "blocked" : "running";
  }
  if (input.childProjection?.status === "waiting") return "waiting";
  if (input.childProjection?.status === "running") return "running";
  // async Agent 的父 tool part 在 launch ACK 后立即标成 completed，
  // partial parent projection 又可能暂时不带仍运行的 background task。此时仅按
  // tool part 会把 child 误判为 ended，并在 cold seed 时清空 V4 running 行。
  // child 还没有终态输出、spawn relation 也没有 stop 时，background input 本身
  // 是可恢复的 running 事实；真实终态仍由 background/child projection/outcome 优先。
  if (
    input.candidate.runInBackground &&
    input.background === undefined &&
    input.childProjection === undefined &&
    input.candidate.stoppedStatus === undefined &&
    input.childOutcome.status === undefined
  ) {
    return "running";
  }
  if (
    input.parentProjection?.activeToolCalls.some(
      (tool) =>
        tool.toolCallId === input.candidate.toolCallId &&
        (tool.status === "pending" || tool.status === "running"),
    )
  ) {
    return "running";
  }
  return input.parentProjection &&
    (input.candidate.toolState?.status === "pending" ||
      input.candidate.toolState?.status === "running")
    ? "running"
    : undefined;
}

function terminalBackgroundStatus(
  task: BackgroundTaskInfo | undefined,
): ZCodeSessionEndedSubagent["status"] | undefined {
  switch (task?.status) {
    case "completed":
      return "success";
    case "cancelled":
      return "cancelled";
    case "failed":
    case "timed_out":
    case "spawn_error":
      return "failed";
    case "lost":
      return "lost";
    default:
      return undefined;
  }
}

function endedStatus(input: {
  background?: BackgroundTaskInfo;
  candidate: SubagentCandidate;
  childOutcome: ReturnType<typeof lastChildOutcome>;
  childProjection?: SessionProjection;
}): ZCodeSessionEndedSubagent["status"] {
  const backgroundStatus = terminalBackgroundStatus(input.background);
  if (backgroundStatus) return backgroundStatus;
  // 同 child 可经 SendMessage 续跑；较新的持久终态不能被上一轮的后台通知覆盖。
  if (
    input.childOutcome.status &&
    (input.childOutcome.endedAt ?? 0) > (input.candidate.stoppedAt ?? 0)
  )
    return input.childOutcome.status;
  if (input.candidate.stoppedStatus) return input.candidate.stoppedStatus;
  if (input.candidate.toolState?.status === "error") {
    return CANCELLATION_PATTERN.test(input.candidate.toolState.error) ? "cancelled" : "failed";
  }
  if (input.childProjection?.status === "error") return "failed";
  if (input.childProjection?.status === "completed") return "success";
  const outputStatus = stringField(input.candidate.output ?? {}, "status");
  if (outputStatus === "cancelled" || outputStatus === "stopped") return "cancelled";
  if (outputStatus === "failed" || outputStatus === "error") return "failed";
  if (outputStatus === "async_launched") return input.childOutcome.status ?? "lost";
  if (input.candidate.toolState?.status === "completed") return "success";
  return input.childOutcome.status ?? "lost";
}

function startedAt(
  candidate: SubagentCandidate,
  background?: BackgroundTaskInfo,
): number | undefined {
  if (background?.startedAt) return background.startedAt.getTime();
  return candidate.startedAt;
}

export function isSubagentChildOfSession(child: SessionInfo, parent: SessionInfo): boolean {
  // 旧 child 构造未继承 workspaceID；缺身份只沿真实 parentID 兼容，显式错误身份仍拒绝。
  return (
    child.taskType === "subagent_child" &&
    child.parentID === parent.id &&
    (child.workspaceID === undefined || child.workspaceID === parent.workspaceID)
  );
}

export function projectSessionSubagents(
  input: ProjectSessionSubagentsInput,
): SessionSubagentProjection {
  const running: ZCodeSessionRunningSubagent[] = [];
  const ended: ZCodeSessionEndedSubagent[] = [];
  for (const candidate of collectSubagentCandidates(
    input.parentSession,
    input.messages,
    input.parentEvents,
  )) {
    const childSession = input.childSessionsById.get(candidate.childSessionId);
    if (!childSession || !isSubagentChildOfSession(childSession, input.parentSession)) continue;
    const childProjection = input.childProjectionsById.get(candidate.childSessionId);
    const background = findBackgroundTask(input.parentProjection, candidate);
    const childOutcome = lastChildOutcome(input.childMessagesById.get(candidate.childSessionId));
    const liveStatus = runningStatus({
      background,
      candidate,
      childOutcome,
      childProjection,
      parentProjection: input.parentProjection,
    });
    const common = {
      childSessionId: candidate.childSessionId,
      ...(candidate.agentId ? { agentId: candidate.agentId } : {}),
      toolCallId: candidate.toolCallId,
      subagentType: candidate.subagentType,
      title: candidate.title,
      ...(startedAt(candidate, background) !== undefined
        ? { startedAt: startedAt(candidate, background) }
        : {}),
    };
    if (liveStatus) {
      running.push({ ...common, status: liveStatus });
      continue;
    }
    const stateEndedAt =
      candidate.toolState && "time" in candidate.toolState && "end" in candidate.toolState.time
        ? candidate.toolState.time.end
        : undefined;
    const childIsLatest =
      childOutcome.status && (childOutcome.endedAt ?? 0) > (candidate.stoppedAt ?? 0);
    const summary = childIsLatest
      ? childOutcome.summary
      : (candidate.summary ?? childOutcome.summary);
    const endedAt = childIsLatest
      ? childOutcome.endedAt
      : (candidate.stoppedAt ?? stateEndedAt ?? childOutcome.endedAt);
    ended.push({
      ...common,
      status: endedStatus({ background, candidate, childOutcome, childProjection }),
      ...(summary ? { summary } : {}),
      endedAt: background?.completedAt?.getTime() ?? endedAt ?? childSession.time.updated,
    });
  }
  running.sort(
    (left, right) =>
      (right.startedAt ?? 0) - (left.startedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  ended.sort(
    (left, right) =>
      (right.endedAt ?? 0) - (left.endedAt ?? 0) ||
      right.childSessionId.localeCompare(left.childSessionId),
  );
  return { revision: input.revision, running, ended };
}

function encodeCursor(item: ZCodeSessionEndedSubagent): string {
  return Buffer.from(
    JSON.stringify({ childSessionId: item.childSessionId, endedAt: item.endedAt ?? 0 }),
  ).toString("base64url");
}

function decodeCursor(cursor: string | undefined): {
  childSessionId: string;
  endedAt: number;
} | null {
  if (!cursor) return null;
  try {
    const value = asRecord(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown,
    );
    const childSessionId = nonEmptyString(value.childSessionId);
    const endedAt = value.endedAt;
    return childSessionId && typeof endedAt === "number" ? { childSessionId, endedAt } : null;
  } catch {
    return null;
  }
}

export function paginateEndedSubagents(
  ended: readonly ZCodeSessionEndedSubagent[],
  options: { cursor?: string; limit: number },
): { items: ZCodeSessionEndedSubagent[]; nextCursor?: string } {
  const cursor = decodeCursor(options.cursor);
  const start = cursor
    ? ended.findIndex(
        (item) =>
          (item.endedAt ?? 0) < cursor.endedAt ||
          ((item.endedAt ?? 0) === cursor.endedAt &&
            item.childSessionId.localeCompare(cursor.childSessionId) < 0),
      )
    : 0;
  if (start < 0) return { items: [] };
  const items = ended.slice(start, start + options.limit);
  const last = items.at(-1);
  return {
    items,
    ...(last && start + items.length < ended.length ? { nextCursor: encodeCursor(last) } : {}),
  };
}
