import { resolveWorkspaceKey } from "@zcode/shared";
import { OrchestrationStoreError, type OrchestrationRunOwner } from "./contract.js";

export function normalizeOrchestrationOwner(owner: OrchestrationRunOwner): OrchestrationRunOwner {
  if (
    typeof owner.workspacePath !== "string" ||
    !owner.workspacePath.trim() ||
    typeof owner.sessionId !== "string" ||
    !owner.sessionId.trim() ||
    (owner.workspaceIdentity !== undefined && typeof owner.workspaceIdentity !== "string") ||
    (owner.remoteSessionId !== undefined && typeof owner.remoteSessionId !== "string")
  ) {
    throw new OrchestrationStoreError(
      "owner_mismatch",
      "Orchestration requires a workspace and parent session owner.",
    );
  }
  const workspaceIdentity = owner.workspaceIdentity?.trim();
  const remoteSessionId = owner.remoteSessionId?.trim();
  return {
    workspacePath: owner.workspacePath,
    sessionId: owner.sessionId.trim(),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(remoteSessionId ? { remoteSessionId } : {}),
  };
}

export function orchestrationOwnerKey(owner: OrchestrationRunOwner): string {
  const normalized = normalizeOrchestrationOwner(owner);
  return JSON.stringify([
    resolveWorkspaceKey(normalized),
    normalized.sessionId,
    normalized.remoteSessionId ?? null,
  ]);
}

export function assertOrchestrationOwner(
  actual: OrchestrationRunOwner,
  expected: OrchestrationRunOwner,
): void {
  if (orchestrationOwnerKey(actual) !== orchestrationOwnerKey(expected)) {
    throw new OrchestrationStoreError(
      "owner_mismatch",
      "Orchestration record belongs to a different workspace or parent session.",
    );
  }
}
