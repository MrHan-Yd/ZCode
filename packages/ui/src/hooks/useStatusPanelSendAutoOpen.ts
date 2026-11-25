import { useCallback, useEffect, useRef, useState } from "react";
import type { CommandAck, CommandType } from "@zcode/shared/zcode-protocol-v4";
import type { ConversationStatusPanelModel } from "@/v4/conversationStatusPanelModel.js";
import {
  getStatusPanelOverlayIntentRevision,
  openStatusPanelOverlay,
} from "@/v4/statusPanelOverlayStore.js";
import {
  resolveAcceptedStatusPanelSend,
  resolveStatusPanelAutoOpenSections,
  StatusPanelSendAutoOpenGate,
} from "@/v4/statusPanelSendAutoOpen.js";

export function useStatusPanelSendAutoOpen({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  sessionId,
  snapshotSessionId,
  enabled,
  model,
  onExpandSections,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  sessionId: string | null;
  snapshotSessionId: string | null;
  enabled: boolean;
  model: ConversationStatusPanelModel;
  onExpandSections: (sections: ReturnType<typeof resolveStatusPanelAutoOpenSections>) => void;
}) {
  const scope = {
    workspaceKey: workspaceIdentity?.trim() || workspacePath,
    remoteSessionId: remoteSessionId ?? null,
    sessionId,
  };
  const gateRef = useRef<StatusPanelSendAutoOpenGate | null>(null);
  if (gateRef.current === null) gateRef.current = new StatusPanelSendAutoOpenGate(scope, enabled);
  const gate = gateRef.current;
  gate.updateScope(scope, enabled);
  const expandRef = useRef(onExpandSections);
  expandRef.current = onExpandSections;
  const [acceptedRevision, setAcceptedRevision] = useState(0);
  const sections = resolveStatusPanelAutoOpenSections(model);

  useEffect(() => () => gate.reset(), [gate]);

  const cancelSend = useCallback(() => gate.reset(), [gate]);
  const beginSend = useCallback(
    () => gate.beginSend(getStatusPanelOverlayIntentRevision()),
    [gate],
  );
  const bindDraftTarget = useCallback(
    (ticket: ReturnType<typeof gate.beginSend>, targetSessionId: string) =>
      gate.bindDraftTarget(ticket, targetSessionId),
    [gate],
  );
  const acceptSend = useCallback(
    (
      ticket: ReturnType<typeof gate.beginSend>,
      type: CommandType,
      payload: Record<string, unknown>,
      targetSessionId: string | null,
      ack: CommandAck,
    ) => {
      const accepted = resolveAcceptedStatusPanelSend(type, payload, targetSessionId, ack);
      if (!accepted) return;
      gate.acceptSend(ticket, accepted, getStatusPanelOverlayIntentRevision());
      setAcceptedRevision((revision) => revision + 1);
    },
    [gate],
  );

  // 只订阅分区是否未完成；逐 chunk 的 snapshot 更新不应重跑自动打开或展开逻辑。
  useEffect(() => {
    const target = gate.takeAutoOpen(snapshotSessionId, getStatusPanelOverlayIntentRevision(), {
      goal: sections.goal,
      plan: sections.plan,
      terminal: sections.terminal,
      workflow: sections.workflow,
      orchestration: sections.orchestration,
      agent: sections.agent,
    });
    if (!target) return;
    expandRef.current(sections);
    openStatusPanelOverlay(target);
  }, [
    gate,
    acceptedRevision,
    enabled,
    sessionId,
    snapshotSessionId,
    sections.goal,
    sections.plan,
    sections.terminal,
    sections.workflow,
    sections.orchestration,
    sections.agent,
  ]);

  return { beginSend, bindDraftTarget, acceptSend, cancelSend };
}
