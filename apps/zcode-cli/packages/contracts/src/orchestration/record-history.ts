import {
  normalizeWriteScopes,
  normalizedWriteScopesOverlap,
  type OrchestrationStep,
} from "@zcode/shared";
import type {
  OrchestrationAttemptRecord,
  OrchestrationAttemptStatus,
  OrchestrationEventType,
  OrchestrationRunEvent,
  OrchestrationRunRecord,
  OrchestrationStepState,
} from "./contract.js";
import { invalidRecord } from "./record-shape.js";

const DEFAULT_EXTRA_RETRIES = 1;
const FAILURE_STATUSES = new Set(["failed", "blocked", "cancelled"]);
const TERMINAL_EVENTS: Partial<Record<OrchestrationEventType, OrchestrationAttemptStatus>> = {
  attempt_completed: "completed",
  attempt_failed: "failed",
  attempt_cancelled: "cancelled",
  run_interrupted: "interrupted",
};

export function validateOrchestrationRunHistory(
  record: OrchestrationRunRecord,
  attempts: ReadonlyMap<string, OrchestrationAttemptRecord>,
  steps: ReadonlyMap<string, OrchestrationStep>,
): void {
  const states = new Map<string, OrchestrationStepState>();
  const normalizedScopes = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const step of steps.values()) {
    states.set(step.stepId, { stepId: step.stepId, status: "pending", attempts: 0 });
    for (const dependency of step.dependsOn) {
      const children = dependents.get(dependency) ?? [];
      children.push(step.stepId);
      dependents.set(dependency, children);
    }
  }
  // 串行 run 的 claim 不会产生并发比较；规范化推迟到真正需要比较时，仍保证每份列表只算一次。
  const scopeOf = (stepId: string): string[] => {
    let scope = normalizedScopes.get(stepId);
    if (!scope) {
      const step = steps.get(stepId)!;
      try {
        scope = normalizeWriteScopes(step.writeScope);
      } catch (error) {
        return invalidRecord(
          `Step ${stepId} has an invalid writeScope: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      }
      normalizedScopes.set(stepId, scope);
    }
    return scope;
  };
  const claimed = new Set<string>();
  const bound = new Set<string>();
  const closed = new Set<string>();
  const live = new Map<string, OrchestrationAttemptRecord>();
  let previous: OrchestrationRunEvent | undefined;
  let cancelled = false;
  let admissionClosed = false;

  for (const event of record.events) {
    validateEventAttemptKey(event);
    validateEventOrder(event, previous, record);
    if (cancelled) return invalidRecord("Events follow a cancelled run.");
    if (
      event.type === "run_cancelled" ||
      (event.type === "run_interrupted" && event.attemptKey === undefined)
    ) {
      const status = event.type === "run_cancelled" ? "cancelled" : "interrupted";
      if (status === "interrupted" && !live.size)
        return invalidRecord("Recovery has no live attempts.");
      for (const attempt of live.values()) {
        if (attempt.status !== status || attempt.endedAt !== event.at)
          return invalidRecord("Fence event differs from attempt state.");
        const state = states.get(attempt.stepId)!;
        state.status = status;
        state.endedAt = event.at;
        closed.add(attempt.key);
      }
      live.clear();
      if (status === "cancelled") {
        for (const state of states.values()) {
          if (
            state.status === "pending" ||
            state.status === "running" ||
            state.status === "interrupted"
          ) {
            state.status = "cancelled";
            state.endedAt = event.at;
          }
        }
        cancelled = true;
      }
      admissionClosed = true;
    } else if (event.type !== "run_created") {
      const key = event.attemptKey;
      const attempt = key === undefined ? undefined : attempts.get(key);
      if (!key || !attempt || attempt.generation !== event.generation)
        return invalidRecord("Event has an unknown attempt key.");
      const step = steps.get(attempt.stepId)!;
      const state = states.get(attempt.stepId)!;
      if (event.type === "attempt_claimed") {
        // 最终 completed 不证明领取合法；必须按 sequence 使用当时的依赖状态，不能只比较时间戳。
        if (
          admissionClosed ||
          claimed.has(key) ||
          event.at !== attempt.startedAt ||
          state.status !== "pending" ||
          attempt.attempt !== state.attempts + 1
        ) {
          return invalidRecord("Attempt was claimed outside its admission boundary.");
        }
        if (!dependenciesSatisfied(step, states, steps))
          return invalidRecord("Attempt was claimed before its dependencies settled.");
        if (live.size >= record.maxConcurrency)
          return invalidRecord("Attempt exceeds run concurrency.");
        const writeScope = scopeOf(step.stepId);
        for (const running of live.values()) {
          if (normalizedWriteScopesOverlap(writeScope, scopeOf(running.stepId)))
            return invalidRecord("Concurrent attempts have overlapping write scopes.");
        }
        state.status = "running";
        state.attempts += 1;
        state.startedAt = event.at;
        state.endedAt = undefined;
        claimed.add(key);
        live.set(key, attempt);
      } else {
        if (!claimed.has(key) || closed.has(key) || !live.has(key))
          return invalidRecord("Attempt events are out of order.");
        if (event.type === "child_bound") {
          if (bound.has(key) || !attempt.child)
            return invalidRecord("Child binding differs from attempt state.");
          bound.add(key);
        } else {
          if (TERMINAL_EVENTS[event.type] !== attempt.status || event.at !== attempt.endedAt)
            return invalidRecord("Terminal event differs from attempt state.");
          closed.add(key);
          live.delete(key);
          state.endedAt = event.at;
          if (attempt.status === "failed") {
            state.status =
              state.attempts <= (step.maxAttempts ?? DEFAULT_EXTRA_RETRIES) ? "pending" : "failed";
            if (state.status === "pending") state.startedAt = undefined;
          } else if (
            attempt.status === "completed" ||
            attempt.status === "cancelled" ||
            attempt.status === "interrupted"
          ) {
            state.status = attempt.status;
          } else return invalidRecord("Terminal event has a live attempt status.");
          if (state.status === "failed" || state.status === "cancelled")
            propagateBlocked(step, event.at, states, steps, dependents);
          // interrupted 表示不知道 child 是否还在写；required 取消会让 run 直接进入 cancelled 终态。两者都关闭准入，
          // optional 取消只阻塞依赖它的步骤，store 仍允许领取无关或依赖已放行的步骤。
          if (state.status === "interrupted" || (state.status === "cancelled" && !step.optional))
            admissionClosed = true;
        }
      }
    }
    previous = event;
  }
  if (
    !previous ||
    previous.generation !== record.state.generation ||
    cancelled !== record.state.cancelled
  )
    return invalidRecord("Run generation or cancellation differs from events.");
  for (const attempt of attempts.values()) {
    const isLive = attempt.status === "claimed" || attempt.status === "running";
    if (
      !claimed.has(attempt.key) ||
      isLive === closed.has(attempt.key) ||
      Boolean(attempt.child) !== bound.has(attempt.key)
    )
      return invalidRecord("Attempt history differs from events.");
  }
  for (const [stepId, replayed] of states) {
    const stored = record.state.steps[stepId]!;
    if (
      stored.status !== replayed.status ||
      stored.attempts !== replayed.attempts ||
      stored.startedAt !== replayed.startedAt ||
      stored.endedAt !== replayed.endedAt
    )
      return invalidRecord("Step snapshot is not reachable from its event history.");
  }
}

function dependenciesSatisfied(
  step: OrchestrationStep,
  states: ReadonlyMap<string, OrchestrationStepState>,
  steps: ReadonlyMap<string, OrchestrationStep>,
): boolean {
  return step.dependsOn.every((dependencyId) => {
    const dependency = states.get(dependencyId);
    return (
      dependency?.status === "completed" ||
      Boolean(
        dependency && FAILURE_STATUSES.has(dependency.status) && steps.get(dependencyId)?.optional,
      )
    );
  });
}

function propagateBlocked(
  source: OrchestrationStep,
  now: number,
  states: Map<string, OrchestrationStepState>,
  steps: ReadonlyMap<string, OrchestrationStep>,
  dependents: ReadonlyMap<string, string[]>,
): void {
  if (source.optional) return;
  const pending = [...(dependents.get(source.stepId) ?? [])];
  for (let index = 0; index < pending.length; index += 1) {
    const stepId = pending[index]!;
    const state = states.get(stepId)!;
    if (state.status !== "pending") continue;
    state.status = "blocked";
    state.endedAt = now;
    if (!steps.get(stepId)?.optional) pending.push(...(dependents.get(stepId) ?? []));
  }
}

/**
 * 事件矩阵：run 级事件不得携带 attemptKey，attempt 级事件必须携带。
 * 否则伪造的 `run_cancelled + attemptKey` 可以在不递增 generation 的情况下把 run 标成已取消，
 * 绕过 store「取消必须先 fence」的不变量。
 * 用 Record 保证新增事件类型时必须显式声明，不会静默落空。
 */
const EVENT_ATTEMPT_KEY_RULE: Record<OrchestrationEventType, "forbidden" | "required" | "either"> =
  {
    run_created: "forbidden",
    attempt_claimed: "required",
    child_bound: "required",
    attempt_completed: "required",
    attempt_failed: "required",
    attempt_cancelled: "required",
    run_cancelled: "forbidden",
    // recovery fence 无 key；per-attempt interrupted 带 key，两种形状都必须接受。
    run_interrupted: "either",
  };

function validateEventAttemptKey(event: OrchestrationRunEvent): void {
  const rule = EVENT_ATTEMPT_KEY_RULE[event.type];
  if (rule === "forbidden" && event.attemptKey !== undefined)
    return invalidRecord(`${event.type} must not carry an attemptKey.`);
  if (rule === "required" && event.attemptKey === undefined)
    return invalidRecord(`${event.type} requires an attemptKey.`);
}

function validateEventOrder(
  event: OrchestrationRunEvent,
  previous: OrchestrationRunEvent | undefined,
  record: OrchestrationRunRecord,
): void {
  if (!previous) {
    if (
      event.type !== "run_created" ||
      event.attemptKey !== undefined ||
      event.at !== record.state.startedAt
    )
      return invalidRecord("Missing initial run event.");
  } else {
    if (
      event.type === "run_created" ||
      event.sequence <= previous.sequence ||
      event.generation < previous.generation ||
      event.at < previous.at
    )
      return invalidRecord("Orchestration events are not monotonic.");
    const fenced = event.generation !== previous.generation;
    const fenceEvent =
      (event.type === "run_cancelled" || event.type === "run_interrupted") &&
      event.attemptKey === undefined;
    if (fenced !== fenceEvent || (fenced && event.generation !== previous.generation + 1))
      return invalidRecord("Invalid generation fence event.");
  }
  if (
    event.generation > record.state.generation ||
    event.at < record.state.startedAt ||
    event.at > record.state.updatedAt
  )
    return invalidRecord("Event time or generation is outside the run.");
}
