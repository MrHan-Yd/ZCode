import { isDeepStrictEqual } from "node:util";
import {
  normalizeWriteScopes,
  normalizedWriteScopesOverlap,
  type OrchestrationPlan,
  type OrchestrationStep,
} from "@zcode/shared";
import type {
  OrchestrationAttemptRecord,
  OrchestrationRunRecord,
  OrchestrationRunState,
} from "./contract.js";
import { invalidRecord } from "./record-shape.js";

export function orchestrationInitialPlan(record: OrchestrationRunRecord): OrchestrationPlan {
  const revision = record.events.find((event) => event.type === "plan_revised");
  return revision?.type === "plan_revised" ? revision.previousPlan : record.state.plan;
}

export function orchestrationPlanAtRevision(
  record: OrchestrationRunRecord,
  revision: number,
): OrchestrationPlan | undefined {
  const initial = orchestrationInitialPlan(record);
  if (initial.revision === revision) return initial;
  for (const event of record.events) {
    if (event.type === "plan_revised" && event.plan.revision === revision) return event.plan;
  }
  return undefined;
}

export function orchestrationAttemptStep(
  record: OrchestrationRunRecord,
  attempt: OrchestrationAttemptRecord,
): OrchestrationStep | undefined {
  return orchestrationPlanAtRevision(record, attempt.revision)?.steps.find(
    (step) => step.stepId === attempt.stepId,
  );
}

export function validateOrchestrationRevisionChain(record: OrchestrationRunRecord): void {
  let plan = orchestrationInitialPlan(record);
  for (const event of record.events) {
    if (event.type !== "plan_revised") continue;
    if (
      !isDeepStrictEqual(event.previousPlan, plan) ||
      event.plan.planId !== plan.planId ||
      event.plan.revision !== plan.revision + 1
    )
      invalidRecord("Invalid orchestration plan revision chain.");
    plan = event.plan;
  }
  if (!isDeepStrictEqual(plan, record.state.plan))
    invalidRecord("Plan snapshot differs from revision history.");
}

/** 旧计划的取消占位也参与容量与写范围，不能被新计划删除或改写 scope 绕开。 */
export function orchestrationCleanupReservations(
  record: OrchestrationRunRecord,
): OrchestrationAttemptRecord[] {
  return record.attempts.filter((attempt) => attempt.cancellationPending === true);
}

export function claimBlockedByOrchestrationCleanup(
  record: OrchestrationRunRecord,
  step: OrchestrationStep,
): boolean {
  const scope = normalizeWriteScopes(step.writeScope);
  return orchestrationCleanupReservations(record).some((attempt) => {
    const previous = orchestrationAttemptStep(record, attempt);
    if (!previous) return invalidRecord("Cleanup reservation has no original step.");
    return (
      step.stepId === attempt.stepId ||
      normalizedWriteScopesOverlap(scope, normalizeWriteScopes(previous.writeScope))
    );
  });
}

export function createOrchestrationReplayState(
  record: OrchestrationRunRecord,
): OrchestrationRunState {
  const plan = orchestrationInitialPlan(record);
  return {
    plan,
    generation: record.events[0]?.generation ?? record.state.generation,
    startedAt: record.state.startedAt,
    updatedAt: record.state.startedAt,
    cancelled: false,
    steps: Object.fromEntries(
      plan.steps.map((step) => [
        step.stepId,
        { stepId: step.stepId, status: "pending", attempts: 0 },
      ]),
    ),
  };
}
