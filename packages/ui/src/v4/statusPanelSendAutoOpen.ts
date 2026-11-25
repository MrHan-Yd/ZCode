import type { CommandAck, CommandType } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationStatusPanelModel } from "@/v4/conversationStatusPanelModel.js";

export interface StatusPanelAutoOpenScope {
  workspaceKey: string;
  remoteSessionId: string | null;
  sessionId: string | null;
}

export interface StatusPanelAutoOpenSections {
  goal: boolean;
  plan: boolean;
  terminal: boolean;
  workflow: boolean;
  orchestration: boolean;
  agent: boolean;
}

export interface AcceptedStatusPanelSend {
  sessionId: string;
  commandId: string;
}

export interface StatusPanelSendTicket {
  generation: number;
  scope: StatusPanelAutoOpenScope;
  intentRevision: number;
}

interface PendingAutoOpen extends AcceptedStatusPanelSend {
  intentRevision: number;
}

export function resolveStatusPanelAutoOpenSections(
  model: ConversationStatusPanelModel,
): StatusPanelAutoOpenSections {
  return {
    goal:
      model.goal?.status === "active" ||
      model.goal?.status === "verifying" ||
      model.goal?.status === "notSatisfied",
    plan: (model.plan?.waitingCount ?? 0) > 0,
    terminal: model.runningBashWorks.length > 0,
    workflow: model.runningWorkflowRuns.length > 0,
    orchestration: model.activeOrchestrationRuns.length > 0,
    agent: model.runningSubagentWorks.length > 0,
  };
}

export function resolveAcceptedStatusPanelSend(
  type: CommandType,
  payload: Record<string, unknown>,
  targetSessionId: string | null,
  ack: CommandAck,
): AcceptedStatusPanelSend | null {
  if (ack.status !== "accepted") return null;
  if (type === "sendText" || type === "sendGoalCommand") {
    return targetSessionId ? { sessionId: targetSessionId, commandId: ack.commandId } : null;
  }
  if (type === "createSession" && payload.firstInput && ack.result?.type === "createSession") {
    return { sessionId: ack.result.sessionId, commandId: ack.commandId };
  }
  return null;
}

function sameWorkspace(a: StatusPanelAutoOpenScope, b: StatusPanelAutoOpenScope): boolean {
  return a.workspaceKey === b.workspaceKey && a.remoteSessionId === b.remoteSessionId;
}

function sameScope(a: StatusPanelAutoOpenScope, b: StatusPanelAutoOpenScope): boolean {
  return sameWorkspace(a, b) && a.sessionId === b.sessionId;
}

export class StatusPanelSendAutoOpenGate {
  private generation = 0;
  private acceptedGeneration: number | null = null;
  private draftTargetSessionId: string | null = null;
  private pending: PendingAutoOpen | null = null;

  constructor(
    private scope: StatusPanelAutoOpenScope,
    private enabled: boolean,
  ) {}

  updateScope(next: StatusPanelAutoOpenScope, enabled: boolean): void {
    // 草稿 ACK 先确定真实 session，随后 pane 才绑定；只有这一条单向提升可继承发送机会。
    const promotion =
      this.enabled &&
      enabled &&
      this.scope.sessionId === null &&
      next.sessionId !== null &&
      next.sessionId === this.draftTargetSessionId &&
      sameWorkspace(this.scope, next);
    if ((!sameScope(this.scope, next) && !promotion) || this.enabled !== enabled) this.reset();
    this.scope = next;
    this.enabled = enabled;
  }

  beginSend(intentRevision: number): StatusPanelSendTicket {
    this.reset();
    return { generation: this.generation, scope: { ...this.scope }, intentRevision };
  }

  bindDraftTarget(ticket: StatusPanelSendTicket, sessionId: string): void {
    if (
      this.enabled &&
      ticket.generation === this.generation &&
      ticket.scope.sessionId === null &&
      sameScope(ticket.scope, this.scope) &&
      this.draftTargetSessionId === null
    ) {
      this.draftTargetSessionId = sessionId;
    }
  }

  acceptSend(
    ticket: StatusPanelSendTicket,
    accepted: AcceptedStatusPanelSend,
    intentRevision: number,
  ): void {
    if (
      !this.enabled ||
      ticket.generation !== this.generation ||
      this.acceptedGeneration === ticket.generation
    ) {
      return;
    }
    this.acceptedGeneration = ticket.generation;
    const draftPromotion =
      ticket.scope.sessionId === null &&
      sameWorkspace(ticket.scope, this.scope) &&
      this.scope.sessionId === this.draftTargetSessionId &&
      this.scope.sessionId === accepted.sessionId;
    if (
      ticket.intentRevision !== intentRevision ||
      (!sameScope(ticket.scope, this.scope) && !draftPromotion) ||
      (ticket.scope.sessionId !== null && ticket.scope.sessionId !== accepted.sessionId) ||
      (this.draftTargetSessionId !== null && this.draftTargetSessionId !== accepted.sessionId)
    ) {
      return;
    }
    if (ticket.scope.sessionId === null) this.draftTargetSessionId = accepted.sessionId;
    this.pending = { ...accepted, intentRevision };
  }

  takeAutoOpen(
    snapshotSessionId: string | null,
    intentRevision: number,
    sections: StatusPanelAutoOpenSections,
  ): string | null {
    const pending = this.pending;
    if (!this.enabled || !pending) return null;
    if (pending.intentRevision !== intentRevision) {
      this.pending = null;
      return null;
    }
    if (
      this.scope.sessionId !== pending.sessionId ||
      snapshotSessionId !== pending.sessionId ||
      !Object.values(sections).some(Boolean)
    ) {
      return null;
    }
    // 先消费再写 overlay；同步通知和后续投影重入都不能为同一次发送再次展开分区。
    this.pending = null;
    return pending.sessionId;
  }

  reset(): void {
    this.generation += 1;
    this.acceptedGeneration = null;
    this.draftTargetSessionId = null;
    this.pending = null;
  }
}
