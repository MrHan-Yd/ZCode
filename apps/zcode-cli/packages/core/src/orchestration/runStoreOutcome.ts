import { parseOrchestrationArtifactReference } from "@zcode/contracts";
import {
  OrchestrationStoreError,
  type OrchestrationAttemptOutcome,
  type OrchestrationEventType,
} from "./contract.js";

export const FINISH_EVENTS: Record<OrchestrationAttemptOutcome["status"], OrchestrationEventType> =
  {
    completed: "attempt_completed",
    failed: "attempt_failed",
    cancelled: "attempt_cancelled",
    interrupted: "run_interrupted",
  };

export function normalizeAttemptOutcome(
  input: OrchestrationAttemptOutcome,
  attemptKey: string,
): OrchestrationAttemptOutcome {
  if (!input || typeof input !== "object")
    throw new OrchestrationStoreError("attempt_conflict", "Invalid orchestration outcome.");
  const artifact =
    input.artifact === undefined ? undefined : parseOrchestrationArtifactReference(input.artifact);
  // 产物必须先核对 key，不能让旧 generation 或重复 terminal 掩盖串错 attempt 的引用。
  if (artifact && artifact.attemptKey !== attemptKey)
    throw new OrchestrationStoreError(
      "artifact_conflict",
      "Artifact belongs to a different orchestration attempt.",
    );
  if (Object.keys(input).some((key) => !["status", "artifact", "error"].includes(key)))
    throw new OrchestrationStoreError("attempt_conflict", "Unknown orchestration outcome field.");
  if (input.status === "completed") {
    if (!artifact)
      throw new OrchestrationStoreError(
        "artifact_conflict",
        "Completed orchestration attempt requires an artifact.",
      );
    return { status: "completed", artifact };
  }
  if (
    !["failed", "cancelled", "interrupted"].includes(input.status) ||
    typeof input.error !== "string"
  )
    throw new OrchestrationStoreError(
      "attempt_conflict",
      "Invalid orchestration terminal outcome.",
    );
  return { status: input.status, error: input.error, ...(artifact ? { artifact } : {}) };
}
