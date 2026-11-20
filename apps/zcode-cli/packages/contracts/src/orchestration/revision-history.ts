import { isDeepStrictEqual } from "node:util";
import type { OrchestrationPlan, OrchestrationStep } from "@zcode/shared";
import type {
  OrchestrationAttemptRecord,
  OrchestrationAttemptStatus,
  OrchestrationRunEvent,
  OrchestrationRunRecord,
  OrchestrationRunState,
  OrchestrationStepStatus,
} from "./contract.js";
import { invalidRecord } from "./record-shape.js";
import { diffOrchestrationPlans } from "./revision-rules.js";
import { orchestrationInitialPlan } from "./record-revision.js";

const DEFAULT_EXTRA_RETRIES = 1;
const TERMINAL: Partial<Record<OrchestrationRunEvent["type"], OrchestrationAttemptStatus>> = {
  attempt_completed: "completed",
  attempt_failed: "failed",
  attempt_cancelled: "cancelled",
  run_interrupted: "interrupted",
};
const FAILURES = new Set(["failed", "blocked", "cancelled"]);

/**
 * 扩展记录的逐 revision 回放：plan_revised 之前的旧快照按旧 DAG 解释，
 * 保留 attempt 的原始 revision / key / generation，不重写历史。
 */
export function validateOrchestrationRevisionHistory(record: OrchestrationRunRecord): void {
  let state: OrchestrationRunState = {
    plan: orchestrationInitialPlan(record),
    generation: record.events[0]?.generation ?? record.state.generation,
    startedAt: record.state.startedAt,
    updatedAt: record.state.startedAt,
    cancelled: false,
    steps: Object.fromEntries(
      orchestrationInitialPlan(record).steps.map((step) => [
        step.stepId,
        { stepId: step.stepId, status: "pending" as const, attempts: 0 },
      ]),
    ),
  };
  const attempts = new Map(record.attempts.map((attempt) => [attempt.key, attempt]));
  const attemptState = new Map<string, "new" | "running" | "closed">();
  const pendingQuiescence = new Set<string>();
  let cancelled = false;
  let interrupted = false;
  let previous: OrchestrationRunEvent | undefined;

  const stepOf = (plan: OrchestrationPlan, stepId: string) =>
    plan.steps.find((step) => step.stepId === stepId);

  for (const event of record.events) {
    validateKey(event);
    validateOrder(event, previous, record);
    if (event.type === "run_created") {
      // 初始事件只建立 run，不改变步骤状态；首个 plan 已由 orchestrationInitialPlan 提供。
    } else if (
      event.type === "run_cancelled" ||
      (event.type === "run_interrupted" && event.attemptKey === undefined)
    ) {
      if (interrupted) return invalidRecord("Repeated run recovery fence.");
      const status = event.type === "run_cancelled" ? "cancelled" : "interrupted";
      state.generation = event.generation;
      if (status === "interrupted" && !record.state.interrupted)
        return invalidRecord("Recovery fence did not persist run pause.");
      for (const attempt of record.attempts) {
        if (attemptState.get(attempt.key) !== "running") continue;
        if (attempt.status !== status || attempt.endedAt !== event.at)
          return invalidRecord("Fence event differs from attempt state.");
        attemptState.set(attempt.key, "closed");
        state.steps[attempt.stepId]!.status = status;
        state.steps[attempt.stepId]!.endedAt = event.at;
        if (status === "cancelled") {
          attempt.cancellationPending = true;
          pendingQuiescence.add(attempt.key);
        }
      }
      if (status === "cancelled") {
        cancelled = true;
        for (const step of Object.values(state.steps)) {
          if (
            step.status === "pending" ||
            step.status === "running" ||
            step.status === "interrupted"
          ) {
            step.status = "cancelled";
            step.endedAt = event.at;
          }
        }
      } else {
        interrupted = true;
      }
    } else if (event.type === "plan_revised") {
      const invalidated = diffOrchestrationPlans(state.plan, event.plan);
      if (
        event.plan.planId !== state.plan.planId ||
        event.plan.revision !== state.plan.revision + 1 ||
        !isDeepStrictEqual(event.previousPlan, state.plan)
      )
        return invalidRecord("Invalid plan revision event.");
      const oldAttempts = record.attempts.filter(
        (attempt) => attempts.get(attempt.key)?.revision === state.plan.revision,
      );
      for (const attempt of oldAttempts) {
        if (attemptState.get(attempt.key) !== "running") continue;
        if (invalidated.has(attempt.stepId)) {
          attempt.status = "cancelled";
          attempt.cancellationPending = true;
          attempt.endedAt = event.at;
          attempt.error = "Superseded by plan revision.";
          attemptState.set(attempt.key, "closed");
          pendingQuiescence.add(attempt.key);
        }
      }
      state = {
        ...state,
        plan: event.plan,
        steps: Object.fromEntries(
          event.plan.steps.map((step): [string, OrchestrationRunState["steps"][string]] => {
            const previousStep = state.steps[step.stepId];
            if (invalidated.has(step.stepId) || !previousStep) {
              return [
                step.stepId,
                {
                  stepId: step.stepId,
                  status: "pending",
                  attempts: 0,
                  generation: nextGeneration(state),
                },
              ];
            }
            return [
              step.stepId,
              { ...previousStep, generation: previousStep.generation ?? state.generation },
            ];
          }),
        ),
        updatedAt: event.at,
      };
    } else if (event.type === "attempt_quiesced") {
      const key = event.attemptKey;
      if (!key || !pendingQuiescence.has(key))
        return invalidRecord("Quiescence without a cleanup reservation.");
      const attempt = attempts.get(key)!;
      if (attempt.status !== "cancelled")
        return invalidRecord("Quiescence on a non-cancelled attempt.");
      if (attempt.cancellationPending === true) attempt.cancellationPending = false;
      pendingQuiescence.delete(key);
      attemptState.set(key, "closed");
    } else if (event.type === "attempt_claimed") {
      const attempt = event.attemptKey ? attempts.get(event.attemptKey) : undefined;
      const step = attempt ? stepOf(state.plan, attempt.stepId) : undefined;
      const stepGeneration = attempt
        ? (state.steps[attempt.stepId]?.generation ?? state.generation)
        : undefined;
      if (
        !attempt ||
        !step ||
        attempt.generation !== stepGeneration ||
        attempt.revision !== state.plan.revision ||
        event.generation !== state.generation
      )
        return invalidRecord("Claim does not belong to the current plan revision.");
      if (cancelled || interrupted || state.steps[attempt.stepId]?.status !== "pending")
        return invalidRecord("Claim happened outside admission.");
      if (attemptState.has(attempt.key)) return invalidRecord("Duplicate claim.");
      if (!dependenciesSatisfied(step, state))
        return invalidRecord("Attempt claimed before dependencies settled.");
      if (attempt.startedAt !== event.at) return invalidRecord("Claim timestamp differs.");
      attemptState.set(attempt.key, "running");
      state.steps[step.stepId]!.status = "running";
      state.steps[step.stepId]!.attempts += 1;
      state.steps[step.stepId]!.startedAt = event.at;
      state.steps[step.stepId]!.endedAt = undefined;
    } else if (event.type === "child_bound") {
      const attempt = event.attemptKey ? attempts.get(event.attemptKey) : undefined;
      if (!attempt || !attempt.child) return invalidRecord("Unknown child binding.");
      // child_bound 在历史里总是早于该 attempt 的 terminal；不能用最终记录上的 endedAt
      // 反推绑定时刻，回放状态才是当时的真相。
      if (attemptState.get(attempt.key) !== "running" && attempt.cancellationPending !== true)
        return invalidRecord("Child binding happened outside its execution.");
    } else {
      const attempt = event.attemptKey ? attempts.get(event.attemptKey) : undefined;
      if (!attempt) return invalidRecord("Unknown attempt terminal event.");
      if (attempt.revision !== state.plan.revision && attemptState.get(attempt.key) !== "running")
        return invalidRecord("Retained attempt terminal event is out of revision.");
      if (TERMINAL[event.type] !== attempt.status || attempt.endedAt !== event.at)
        return invalidRecord("Attempt terminal differs from event.");
      if (attemptStatus(state, attempt) !== "running")
        return invalidRecord("Terminal for a non-running attempt.");
      if (attempt.status === "claimed" || attempt.status === "running")
        return invalidRecord("Terminal event has a live attempt status.");
      attemptState.set(attempt.key, "closed");
      const stepState = state.steps[attempt.stepId]!;
      stepState.status = attempt.status;
      stepState.endedAt = event.at;
      if (attempt.status === "failed") {
        const step = stepOf(state.plan, attempt.stepId);
        const retries = step?.maxAttempts ?? DEFAULT_EXTRA_RETRIES;
        if (stepState.attempts <= retries) {
          stepState.status = "pending";
          stepState.startedAt = undefined;
        }
      }
    }
    state.updatedAt = event.at;
    previous = event;
  }

  if (
    !previous ||
    cancelled !== record.state.cancelled ||
    interrupted !== Boolean(record.state.interrupted) ||
    previous.generation !== record.state.generation
  )
    return invalidRecord("Run fence or cancellation differs from events.");
  if (
    pendingQuiescence.size !==
    record.attempts.filter((attempt) => attempt.cancellationPending).length
  )
    return invalidRecord("Cleanup reservation history is inconsistent.");
  for (const [stepId, stored] of Object.entries(record.state.steps)) {
    const replayed = state.steps[stepId];
    if (
      !replayed ||
      stored.status !== replayed.status ||
      stored.attempts !== replayed.attempts ||
      stored.startedAt !== replayed.startedAt ||
      stored.endedAt !== replayed.endedAt
    )
      return invalidRecord("Step snapshot is not reachable from the event history.");
  }
}

function nextGeneration(state: OrchestrationRunState): number {
  let maximum = state.generation;
  for (const step of Object.values(state.steps))
    maximum = Math.max(maximum, step.generation ?? state.generation);
  return maximum + 1;
}

function attemptStatus(
  state: OrchestrationRunState,
  attempt: OrchestrationAttemptRecord,
): OrchestrationStepStatus {
  return state.steps[attempt.stepId]?.status ?? "cancelled";
}

function validateKey(event: OrchestrationRunEvent): void {
  if (event.type === "plan_revised" && event.attemptKey !== undefined)
    return invalidRecord("Plan revision must not carry an attempt key.");
  if (
    event.type === "run_created" ||
    event.type === "plan_revised" ||
    event.type === "run_cancelled" ||
    event.type === "run_interrupted" ||
    event.type === "attempt_quiesced"
  )
    return;
  if (event.attemptKey === undefined)
    return invalidRecord(`Attempt event requires an attempt key: ${event.type}.`);
}

function validateOrder(
  event: OrchestrationRunEvent,
  previous: OrchestrationRunEvent | undefined,
  record: OrchestrationRunRecord,
): void {
  if (!previous) {
    if (event.type !== "run_created" || event.at !== record.state.startedAt)
      return invalidRecord("Missing initial run event.");
    return;
  }
  if (
    event.type === "run_created" ||
    event.sequence <= previous.sequence ||
    event.generation < previous.generation ||
    event.at < previous.at
  )
    return invalidRecord("Events are not monotonic.");
  const fenced = event.generation !== previous.generation;
  const fence =
    (event.type === "run_cancelled" || event.type === "run_interrupted") &&
    event.attemptKey === undefined;
  if (fenced !== fence || (fenced && event.generation !== previous.generation + 1))
    return invalidRecord("Invalid generation fence event.");
}

function dependenciesSatisfied(step: OrchestrationStep, state: OrchestrationRunState): boolean {
  return step.dependsOn.every((dependencyId) => {
    const dependency = state.steps[dependencyId];
    if (!dependency) return false;
    if (dependency.status === "completed") return true;
    if (!FAILURES.has(dependency.status)) return false;
    return Boolean(stepOfOptional(state.plan, dependencyId));
  });
}

function stepOfOptional(plan: OrchestrationPlan, stepId: string): boolean {
  return plan.steps.find((step) => step.stepId === stepId)?.optional === true;
}
