import {
  commandAckSchema,
  conversationTopicFrameSchema,
  encodeTopicWireFrames,
  parseCommandEnvelope,
  V4_WIRE_PROTOCOL_VERSION,
  type CommandEnvelope,
  type ConversationSnapshot,
  type ConversationTopicWireCandidate,
  type TopicFrameDeliveryKind,
} from "@zcode/shared/zcode-protocol-v4";
import {
  applyStatusContent,
  createStatusSnapshot,
  statusOrchestrationRuns,
  STATUS_AT,
  STATUS_CREATED_ID,
  STATUS_SESSION_ID,
  type StatusContent,
  type StatusPanelSendAudit,
} from "./statusPanelSendAutoOpenData.js";

interface Subscription {
  id: string;
  sessionId: string;
  ordinal: number;
}
export const statusFixtureNoEvent = () => ({ dispose() {} });

export function createStatusPanelFixtureTransport(input: {
  mobile: boolean;
  fallback: boolean;
  initialContent: StatusContent;
  audit: StatusPanelSendAudit;
}) {
  const { mobile, initialContent, audit } = input;
  let rejectPrewarm = input.fallback;
  const deny = (operation: string): never => {
    audit.forbidden.push(operation);
    throw new Error(`fixture.forbidden:${operation}`);
  };
  const snapshots = new Map<string, ConversationSnapshot>();
  const get = (id: string) => {
    let value = snapshots.get(id);
    if (!value) {
      value = createStatusSnapshot(id);
      applyStatusContent(
        value,
        id === STATUS_SESSION_ID || id === STATUS_CREATED_ID ? initialContent : "empty",
      );
      snapshots.set(id, value);
    }
    return value;
  };
  const records = new Map<string, Subscription>();
  const listeners = new Set<(frame: ConversationTopicWireCandidate) => void>();
  let nextSubscription = 0;
  let gate: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  let outcome: "rejected" | "failed" | "confirmation" | null = null;
  let orchestration = statusOrchestrationRuns(initialContent);
  const emit = (
    record: Subscription,
    payload: unknown,
    deliveryKind: TopicFrameDeliveryKind,
    fromSeq = 0,
  ) => {
    const frame = conversationTopicFrameSchema.parse({
      topic: `conversation/${record.sessionId}`,
      subscriptionId: record.id,
      fromSeq,
      toSeq: get(record.sessionId).seq,
      sentAt: Date.now(),
      payload,
    });
    audit.delivery.push(deliveryKind);
    const ordinal = ++record.ordinal;
    for (const wire of encodeTopicWireFrames(frame, {
      deliveryKind,
      logicalFrameId: `${record.id}/${ordinal}`,
      logicalFrameOrdinal: ordinal,
      topic: frame.topic,
      subscriptionId: record.id,
      maxPhysicalFrameBytes: 1536,
      measurePhysicalFrameBytes: (wire) =>
        new TextEncoder().encode(JSON.stringify(wire)).byteLength,
    }))
      for (const listener of listeners) listener(wire);
  };
  const publish = (content: StatusContent, gap = false, id = STATUS_SESSION_ID) => {
    const value = get(id);
    const before = value.seq;
    value.seq += gap ? 2 : 1;
    value.revision++;
    applyStatusContent(value, content);
    orchestration = statusOrchestrationRuns(content);
    for (const record of records.values())
      if (record.sessionId === id) {
        emit(
          record,
          {
            kind: "deltas",
            deltas: [
              {
                op: "state.updated",
                patch: {
                  revision: value.revision,
                  plan: value.plan,
                  subagents: value.subagents,
                  goal: value.goal,
                  backgroundWorks: value.backgroundWorks,
                  workflowRuns: value.workflowRuns,
                },
              },
            ],
          },
          "online",
          before + (gap ? 1 : 0),
        );
      }
    return value.seq;
  };
  const setRouting = (mode: "startNow" | "enqueue" | "guide" | "choice", id: string) => {
    const value = get(id);
    const before = value.seq++;
    value.inputRouting = { mode };
    value.revision++;
    for (const record of records.values())
      if (record.sessionId === id) {
        emit(
          record,
          {
            kind: "deltas",
            deltas: [
              {
                op: "state.updated",
                patch: {
                  revision: value.revision,
                  inputRouting: value.inputRouting,
                },
              },
            ],
          },
          "online",
          before,
        );
      }
    return value.seq;
  };
  const agent = {
    async helloConversationV4() {
      return {
        kind: "hello",
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
        connectionId: "fixture-connection",
        clientMode: mobile ? "web-remote-replayable" : "desktop-continuous",
        deliveryProfile: mobile ? "replayable" : "continuous",
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: false,
          localTerminal: false,
          binaryFrames: false,
          compression: "none",
        },
        auth: {},
      };
    },
    async initializeConversationV4() {
      return {};
    },
    onDynamicConversationFrame:
      () => (listener: (wire: ConversationTopicWireCandidate) => void) => {
        listeners.add(listener);
        return {
          dispose() {
            listeners.delete(listener);
          },
        };
      },
    onDynamicLocalTtftFacts: () => statusFixtureNoEvent,
    onAgentRuntimeRestarted: statusFixtureNoEvent,
    async subscribeConversationV4(params: { sessionId: string }) {
      const record = {
        id: `fixture-sub-${++nextSubscription}`,
        sessionId: params.sessionId,
        ordinal: 0,
      };
      records.set(record.id, record);
      queueMicrotask(() =>
        emit(record, { kind: "snapshot", snapshot: get(record.sessionId) }, "initial"),
      );
      return {
        ack: {
          subscriptionId: record.id,
          mode: "snapshot",
          logEpoch: get(record.sessionId).logEpoch,
        },
      };
    },
    async resyncConversationV4(params: { subscriptionId: string }) {
      const record = records.get(params.subscriptionId);
      if (!record) return deny("unowned-recovery");
      audit.recovery.push(record.id);
      queueMicrotask(() =>
        emit(record, { kind: "snapshot", snapshot: get(record.sessionId) }, "recovery"),
      );
      return {
        ack: {
          subscriptionId: record.id,
          mode: "snapshot",
          logEpoch: get(record.sessionId).logEpoch,
        },
      };
    },
    async unsubscribeConversationV4(params: { subscriptionId: string }) {
      records.delete(params.subscriptionId);
      return {};
    },
    async sendConversationCommandV4({ envelope }: { envelope: CommandEnvelope }) {
      const parsed = parseCommandEnvelope(envelope);
      if (!parsed.ok) throw parsed.error;
      const isInput =
        envelope.type === "sendText" ||
        envelope.type === "sendGoalCommand" ||
        (envelope.type === "createSession" &&
          Boolean((envelope.payload as { firstInput?: unknown }).firstInput));
      if (
        ![
          "createSession",
          "sendText",
          "sendGoalCommand",
          "compact",
          "switchModelConfig",
          "switchCollaborationMode",
          "setFollowupMode",
          "setOrchestration",
          "deleteSession",
        ].includes(envelope.type)
      )
        return deny(envelope.type);
      audit.commands.push(envelope);
      if (envelope.type === "createSession" && rejectPrewarm && !isInput) {
        const ack = commandAckSchema.parse({
          commandId: envelope.commandId,
          status: "rejected",
          reasonCode: "fixture.noPrewarm",
          revisionAtDecision: 1,
        });
        audit.acks.push(ack);
        return ack;
      }
      if (isInput && gate) await gate.promise;
      const rejected = isInput ? outcome : null;
      if (isInput) outcome = null;
      const id = envelope.sessionId ?? STATUS_CREATED_ID;
      const value = get(id);
      const delivery =
        value.inputRouting.mode === "enqueue"
          ? "queue"
          : value.inputRouting.mode === "guide"
            ? "guide"
            : "startNow";
      const ack = commandAckSchema.parse({
        commandId: envelope.commandId,
        revisionAtDecision: value.revision,
        status: rejected ? (rejected === "confirmation" ? "rejected" : rejected) : "accepted",
        ...(rejected
          ? {
              reasonCode:
                rejected === "confirmation"
                  ? "guard.heldQueueConfirmationStale"
                  : "fixture.rejected",
            }
          : {}),
        ...(!rejected && envelope.type === "createSession"
          ? {
              result: {
                type: "createSession",
                sessionId: id,
                ...(isInput ? { input: { delivery, inputId: envelope.commandId } } : {}),
              },
            }
          : {}),
        ...(!rejected && isInput && envelope.type !== "createSession"
          ? { result: { type: "inputAccepted", delivery, inputId: envelope.commandId } }
          : {}),
      });
      if (isInput && !rejected) {
        const payload = envelope.payload as { text?: string; firstInput?: { text: string } };
        const row = {
          rowId: value.rows.totalCount + 1,
          turnId: `fixture-turn-${audit.commands.length}`,
          createdAt: STATUS_AT,
          createdAtSeq: value.seq + 1,
          kind: "userInput" as const,
          origin: "realUser" as const,
          text: payload.text ?? payload.firstInput?.text ?? "Synthetic Goal",
          sourceCommandId: envelope.commandId,
        };
        const before = value.seq++;
        value.rows.window.push(row);
        value.rows.totalCount++;
        value.rows.firstRowId ??= row.rowId;
        for (const record of records.values())
          if (record.sessionId === id) {
            emit(
              record,
              { kind: "deltas", deltas: [{ op: "row.upserted", row }] },
              "online",
              before,
            );
          }
      }
      audit.acks.push(ack);
      return ack;
    },
    async queryConversationCommandsV4(params: {
      commands: Array<{ commandId: string; sessionId: string | null }>;
    }) {
      return {
        entries: params.commands.map((key) => ({
          key,
          result: audit.acks.find((ack) => ack.commandId === key.commandId) ?? "unknown",
        })),
      };
    },
    async getSkillReferenceCatalog() {
      return { skills: [], authority: "session" };
    },
    async conversationPlansV4() {
      return { plans: [] };
    },
    async conversationTailPreviewV4() {
      return null;
    },
    async conversationWorkflowRunsV4() {
      return { runs: [] };
    },
    async conversationOrchestrationStateV4() {
      return { config: { enabled: false, team: [], maxConcurrency: 1 }, runs: orchestration };
    },
    onDynamicSessionsIndexFrame: () => statusFixtureNoEvent,
    async subscribeSessionsIndexV4() {
      return {
        ack: { subscriptionId: "fixture-index", mode: "snapshot", logEpoch: "fixture-index" },
      };
    },
    async unsubscribeSessionsIndexV4() {
      return {};
    },
    async readSessionPerformance({ sessionId }: { sessionId: string }) {
      return {
        sessionId,
        summary: {
          modelMs: 0,
          toolMs: 0,
          averageTtftMs: null,
          tokensPerSecond: null,
          modelRequestCount: 0,
          toolCallCount: 0,
        },
      };
    },
    async readSessionPerformanceBatch() {
      return { entries: [] };
    },
  };
  return {
    agent,
    deny,
    publish,
    setRouting,
    holdAck() {
      gate = Promise.withResolvers<void>();
    },
    releaseAck() {
      gate?.resolve();
      gate = null;
    },
    rejectNext(status: "rejected" | "failed" | "confirmation") {
      outcome = status;
    },
    allowDraftCreate() {
      rejectPrewarm = false;
    },
  };
}
