import {
  conversationSnapshotSchema,
  type CommandAck,
  type CommandEnvelope,
  type ConversationSnapshot,
  type OrchestrationRunProjection,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";

export const STATUS_WORKSPACE_PATH = "/synthetic/status-send";
export const STATUS_SESSION_ID = "fixture-status-send";
export const STATUS_CREATED_ID = "fixture-status-created";
export const STATUS_AT = 1_767_225_600_000;
export const STATUS_MODEL_SELECTION = {
  providerId: "fixture-api",
  modelId: "fixture-model",
  options: { reasoningLevel: "off" },
};

export type StatusContent =
  | "empty"
  | "todo"
  | "completed"
  | "agent"
  | "waiting"
  | "blocked"
  | "ended"
  | "all"
  | "workflow";
export interface StatusScope {
  sessionId: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}
export interface StatusPanelSendAudit {
  commands: CommandEnvelope[];
  acks: CommandAck[];
  opened: string[];
  recovery: string[];
  navigation: string[];
  forbidden: string[];
  delivery: TopicFrameDeliveryKind[];
  ready: boolean;
}
export interface StatusPanelSendBridge {
  audit: StatusPanelSendAudit;
  holdAck(): void;
  releaseAck(): void;
  rejectNext(status: "rejected" | "failed" | "confirmation"): void;
  allowDraftCreate(): void;
  publish(content: StatusContent, gap?: boolean, sessionId?: string): number;
  setRouting(mode: "startNow" | "enqueue" | "guide" | "choice"): number;
  setScope(scope: StatusScope): void;
  setVisibility(focused: boolean, visible: boolean): void;
  dispose(): void;
}
declare global {
  interface Window {
    __statusPanelSendTest: StatusPanelSendBridge;
  }
}

export function createStatusSnapshot(sessionId: string): ConversationSnapshot {
  const allowed = { allowed: true };
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId,
    logEpoch: `fixture-epoch-${sessionId}`,
    seq: 1,
    revision: 1,
    meta: { title: "Synthetic send regression", titleSource: "custom" },
    control: {
      phase: sessionId === STATUS_CREATED_ID ? "draft" : "completedSuccess",
      sessionEnded: sessionId !== STATUS_CREATED_ID,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: allowed,
      compact: allowed,
      switchModelConfig: allowed,
      setFollowupMode: allowed,
      queueEdit: allowed,
      sendQueuedNow: allowed,
      pauseGoal: allowed,
      resumeGoal: allowed,
    },
    inputRouting: { mode: "startNow" },
    config: {
      provider: STATUS_MODEL_SELECTION.providerId,
      model: STATUS_MODEL_SELECTION.modelId,
      thought: "off",
      modelSelection: STATUS_MODEL_SELECTION,
      followupMode: "queue",
      mode: "build",
      planEnabled: false,
    },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 1, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    rows: { window: [], totalCount: 0, firstRowId: null },
  });
}

export function applyStatusContent(value: ConversationSnapshot, content: StatusContent): void {
  value.plan = ["todo", "completed", "all"].includes(content)
    ? {
        updatedAt: STATUS_AT + value.revision,
        items: [
          {
            id: "fixture-todo",
            content: "Synthetic pending Todo",
            status: content === "completed" ? "completed" : "pending",
          },
          { id: "fixture-todo-done", content: "Synthetic completed Todo", status: "completed" },
        ],
      }
    : null;
  const agent = ["agent", "waiting", "blocked", "all"].includes(content);
  value.subagents = {
    revision: value.revision,
    childSessionIds: agent || content === "ended" ? ["fixture-child"] : [],
    endedTotal: content === "ended" ? 1 : 0,
    running: agent
      ? [
          {
            childSessionId: "fixture-child",
            agentId: "fixture-agent",
            subagentType: "Explore",
            title: "Synthetic active agent",
            startedAt: STATUS_AT,
            status:
              content === "waiting" ? "waiting" : content === "blocked" ? "blocked" : "running",
          },
        ]
      : [],
  };
  value.goal =
    content === "all"
      ? {
          targetId: "fixture-goal",
          objective: "Synthetic active Goal",
          status: "active",
          summaryTitle: null,
          timeUsedSeconds: 0,
          activeRunStartedAtMs: null,
          iteration: 1,
          verifications: [],
          iterations: [],
        }
      : null;
  value.workflowRuns = {
    revision: value.revision,
    runs:
      content === "workflow"
        ? [
            {
              runId: "fixture-sole-workflow",
              toolCallId: "fixture-workflow-tool",
              status: "running",
              usage: { spentTokens: 0, nodesUsed: 0 },
              actors: [],
              nodes: [],
              lastEventSequence: 1,
            },
          ]
        : [],
  };
  const work = (workId: string, kind: "bash" | "workflow") => ({
    workId,
    kind,
    title: `Synthetic ${kind}`,
    status: "running" as const,
    startedAt: STATUS_AT,
    anchorRowId: null,
  });
  value.backgroundWorks =
    content === "all"
      ? [work("fixture-bash", "bash"), work("fixture-workflow", "workflow")]
      : content === "workflow"
        ? [work("fixture-sole-workflow", "workflow")]
        : [];
}

export function statusOrchestrationRuns(content: StatusContent): OrchestrationRunProjection[] {
  return content === "all"
    ? [
        {
          runId: "fixture-orchestration",
          planId: "fixture-plan",
          revision: 1,
          generation: 1,
          status: "running",
          team: [],
          maxConcurrency: 1,
          startedAt: STATUS_AT,
          updatedAt: STATUS_AT,
          active: true,
          steps: [
            {
              stepId: "fixture-step",
              title: "Synthetic orchestration step",
              role: "Explore",
              status: "running",
              dependsOn: [],
              attempts: 1,
            },
          ],
        },
      ]
    : [];
}
