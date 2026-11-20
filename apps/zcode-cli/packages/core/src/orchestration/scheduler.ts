import {
  normalizeWriteScopes,
  normalizedWriteScopesOverlap,
  type OrchestrationPlan,
  type OrchestrationStep,
} from "@zcode/shared";
import type { OrchestrationRunState } from "@zcode/contracts";
export type {
  OrchestrationRunState,
  OrchestrationStepState,
  OrchestrationStepStatus,
} from "@zcode/contracts";

/**
 * 编排 run 的纯状态机。
 *
 * 这里不启动子代理、不读写磁盘、不等待 Promise；runtime 负责把
 * claimRunnableSteps 返回的 step 派发出去，再用 completeStep / failStep 回写。
 * 这样顺序、重试、写范围串行、取消和恢复都可以在没有 IO 的情况下单测。
 */

export interface ClaimRunnableStepsOptions {
  maxConcurrency?: number;
  now?: number;
  /** 旧修订尚未确认退出的 child 仍占容量。 */
  reservedConcurrency?: number;
  isBlocked?: (step: OrchestrationStep) => boolean;
}

export interface OrchestrationRunSummary {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  blocked: number;
  cancelled: number;
  interrupted: number;
  attempts: number;
}

const DEFAULT_MAX_CONCURRENCY = 3;

export function createInitialRunState(
  plan: OrchestrationPlan,
  options: { generation?: number; now?: number } = {},
): OrchestrationRunState {
  const now = options.now ?? Date.now();
  return {
    plan,
    generation: options.generation ?? 0,
    steps: Object.fromEntries(
      plan.steps.map((step) => [
        step.stepId,
        { stepId: step.stepId, status: "pending" as const, attempts: 0 },
      ]),
    ),
    startedAt: now,
    updatedAt: now,
    cancelled: false,
  };
}

export function getStepMaxAttempts(step: OrchestrationStep): number {
  return Math.max(0, step.maxAttempts ?? 1);
}

export function areDependenciesSatisfied(
  run: OrchestrationRunState,
  step: OrchestrationStep,
): boolean {
  for (const dependencyId of step.dependsOn) {
    const dependencyState = run.steps[dependencyId];
    if (!dependencyState) return false;
    if (dependencyState.status === "completed") continue;
    if (
      dependencyState.status === "failed" ||
      dependencyState.status === "blocked" ||
      dependencyState.status === "cancelled"
    ) {
      const dependencyStep = run.plan.steps.find((candidate) => candidate.stepId === dependencyId);
      if (dependencyStep?.optional) continue;
      return false;
    }
    return false;
  }
  return true;
}

/**
 * 选出本轮可以启动的步骤，并在同一个同步边界内把它们标成 running。
 * 写范围与运行中/本轮已选中的步骤重叠时跳过，留到下一轮串行执行。
 */
export function claimRunnableSteps(
  run: OrchestrationRunState,
  options: ClaimRunnableStepsOptions = {},
): string[] {
  // interrupted 没有可靠 terminal 证据；即使它是 optional，也不能自动重放写入或放行其他步骤。
  if (run.cancelled || Object.values(run.steps).some((state) => state.status === "interrupted"))
    return [];
  const now = options.now ?? Date.now();
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
  const runningSteps = run.plan.steps.filter(
    (step) => run.steps[step.stepId]?.status === "running",
  );
  const reserved = Math.max(0, options.reservedConcurrency ?? 0);
  const available = Math.max(0, maxConcurrency - runningSteps.length - reserved);
  if (available === 0) return [];

  const claimed: OrchestrationStep[] = [];
  const occupiedScopes = runningSteps.map((step) => normalizeWriteScopes(step.writeScope));

  for (const step of run.plan.steps) {
    if (claimed.length >= available) break;
    const state = run.steps[step.stepId];
    if (!state || state.status !== "pending") continue;
    if (options.isBlocked?.(step)) continue;
    if (!areDependenciesSatisfied(run, step)) continue;
    const writeScope = normalizeWriteScopes(step.writeScope);
    if (occupiedScopes.some((scope) => normalizedWriteScopesOverlap(scope, writeScope))) {
      continue;
    }
    claimed.push(step);
    occupiedScopes.push(writeScope);
  }

  for (const step of claimed) {
    const state = run.steps[step.stepId];
    if (!state) continue;
    state.status = "running";
    state.attempts += 1;
    state.startedAt = now;
    state.endedAt = undefined;
    state.error = undefined;
  }
  if (claimed.length > 0) run.updatedAt = now;
  return claimed.map((step) => step.stepId);
}

export function completeStep(
  run: OrchestrationRunState,
  stepId: string,
  options: { now?: number } = {},
): void {
  const state = run.steps[stepId];
  if (!state || state.status !== "running") return;
  state.status = "completed";
  state.endedAt = options.now ?? Date.now();
  state.error = undefined;
  run.updatedAt = state.endedAt;
}

/**
 * 失败时按 maxAttempts 决定回到 pending 重试，还是落到 failed。
 * 永久失败后把依赖它的 pending 步骤标成 blocked。
 */
export function failStep(
  run: OrchestrationRunState,
  stepId: string,
  error: string,
  options: { now?: number } = {},
): void {
  const state = run.steps[stepId];
  const step = run.plan.steps.find((candidate) => candidate.stepId === stepId);
  if (!state || !step || state.status !== "running") return;
  const now = options.now ?? Date.now();
  state.error = error;
  state.endedAt = now;
  if (state.attempts <= getStepMaxAttempts(step)) {
    state.status = "pending";
    state.startedAt = undefined;
  } else {
    state.status = "failed";
  }
  run.updatedAt = now;
  markBlockedSteps(run, now);
}

export function cancelRun(run: OrchestrationRunState, options: { now?: number } = {}): void {
  if (run.cancelled) return;
  const now = options.now ?? Date.now();
  run.cancelled = true;
  for (const state of Object.values(run.steps)) {
    if (
      state.status === "pending" ||
      state.status === "running" ||
      state.status === "interrupted"
    ) {
      state.status = "cancelled";
      state.endedAt = now;
    }
  }
  run.updatedAt = now;
}

export function markBlockedSteps(run: OrchestrationRunState, now = Date.now()): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of run.plan.steps) {
      const state = run.steps[step.stepId];
      if (!state || state.status !== "pending") continue;
      const blockedBy = step.dependsOn.find((dependencyId) => {
        const dependencyState = run.steps[dependencyId];
        if (!dependencyState) return false;
        if (
          dependencyState.status !== "failed" &&
          dependencyState.status !== "blocked" &&
          dependencyState.status !== "cancelled"
        ) {
          return false;
        }
        const dependencyStep = run.plan.steps.find(
          (candidate) => candidate.stepId === dependencyId,
        );
        return !dependencyStep?.optional;
      });
      if (!blockedBy) continue;
      state.status = "blocked";
      state.endedAt = now;
      state.error = `Blocked by dependency ${blockedBy}.`;
      changed = true;
      run.updatedAt = now;
    }
  }
}

export function isRunTerminal(run: OrchestrationRunState): boolean {
  return Object.values(run.steps).every((state) =>
    ["completed", "failed", "blocked", "cancelled", "interrupted"].includes(state.status),
  );
}

export function summarizeRun(run: OrchestrationRunState): OrchestrationRunSummary {
  const summary: OrchestrationRunSummary = {
    total: run.plan.steps.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    blocked: 0,
    cancelled: 0,
    interrupted: 0,
    attempts: 0,
  };
  for (const state of Object.values(run.steps)) {
    summary[state.status] += 1;
    summary.attempts += state.attempts;
  }
  return summary;
}
