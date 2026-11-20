import { isDeepStrictEqual } from "node:util";
import { parseOrchestrationPlan, validateOrchestrationPlan } from "@zcode/shared";
import { createOrchestrationRevisionState } from "@zcode/contracts";
import {
  OrchestrationStoreError,
  type OrchestrationRunRecord,
  type OrchestrationRunRevision,
  type ReviseOrchestrationRunInput,
} from "./contract.js";

/**
 * 原地修订的纯记录变换。RunStore 仍负责事务、事件追加与持久化；
 * 这里只决定保留哪些步骤、哪些 live attempt 需要取消。
 */
export function reviseOrchestrationRecord(
  record: OrchestrationRunRecord,
  input: ReviseOrchestrationRunInput,
  now: number,
): OrchestrationRunRevision & { previousPlan: OrchestrationRunRecord["state"]["plan"] } {
  if (
    record.state.cancelled ||
    record.state.interrupted === true ||
    record.status === "cancelled" ||
    record.status === "interrupted"
  )
    throw new OrchestrationStoreError(
      "run_conflict",
      "An interrupted or cancelled run cannot be revised.",
    );
  const parsed = parseOrchestrationPlan(input.plan);
  if (!parsed.success)
    throw new OrchestrationStoreError("invalid_plan", "Invalid orchestration plan structure.");
  const plan = parsed.data;
  if (plan.planId !== record.state.plan.planId)
    throw new OrchestrationStoreError("run_conflict", "An amendment must keep the planId.");
  const pendingKeys = () =>
    record.attempts
      .filter((attempt) => attempt.cancellationPending === true)
      .map((attempt) => attempt.key);
  if (
    input.expectedRevision === record.state.plan.revision - 1 &&
    plan.revision === record.state.plan.revision &&
    isDeepStrictEqual(plan, record.state.plan)
  )
    return {
      record: structuredClone(record),
      invalidatedAttemptKeys: pendingKeys(),
      previousPlan: record.state.plan,
    };
  if (
    input.expectedRevision !== record.state.plan.revision ||
    plan.revision !== record.state.plan.revision + 1
  )
    throw new OrchestrationStoreError("run_conflict", "Orchestration revision is stale.");
  if (
    validateOrchestrationPlan(plan, { team: record.team, writableRoles: record.writableRoles })
      .issues.length
  )
    throw new OrchestrationStoreError("invalid_plan", "Invalid orchestration plan semantics.");
  const previousPlan = record.state.plan;
  const revision = createOrchestrationRevisionState(record.state, plan, record.attempts, now);
  for (const attempt of record.attempts) {
    const live = attempt.status === "claimed" || attempt.status === "running";
    if (!live || !revision.invalidatedStepIds.has(attempt.stepId)) continue;
    attempt.status = "cancelled";
    attempt.endedAt = now;
    attempt.cancellationPending = true;
    attempt.error = "Superseded by plan revision.";
  }
  record.state = revision.state;
  return {
    record,
    invalidatedAttemptKeys: pendingKeys(),
    previousPlan,
  };
}

export function confirmOrchestrationQuiesced(
  record: OrchestrationRunRecord,
  attemptKey: string,
): boolean {
  const attempt = record.attempts.find((entry) => entry.key === attemptKey);
  if (!attempt || attempt.cancellationPending !== true) return false;
  delete attempt.cancellationPending;
  return true;
}
