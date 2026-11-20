import { isDeepStrictEqual } from "node:util";
import {
  normalizeWriteScopes,
  type OrchestrationPlan,
  type OrchestrationStep,
} from "@zcode/shared";
import {
  OrchestrationStoreError,
  type OrchestrationAttemptRecord,
  type OrchestrationRunRecord,
  type OrchestrationRunState,
  type OrchestrationStepState,
} from "./contract.js";

const DEFAULT_EXTRA_RETRIES = 1;
const DEFAULT_INPUTS = "auto";

export function isLiveOrchestrationAttempt(attempt: OrchestrationAttemptRecord): boolean {
  return attempt.status === "claimed" || attempt.status === "running";
}

export function getOrchestrationStepGeneration(
  state: OrchestrationRunState,
  stepId: string,
): number | undefined {
  const step = state.steps[stepId];
  return step ? (step.generation ?? state.generation) : undefined;
}

export function findCurrentOrchestrationAttempt(
  record: OrchestrationRunRecord,
  stepId: string,
): OrchestrationAttemptRecord | undefined {
  const step = record.state.steps[stepId];
  if (!step) return undefined;
  // 旧 v1 fence 只递增 run generation，不改 terminal attempt；只读 selector 保留其已确认产物，
  // 不能把该兼容规则用于 live 准入。首次修订或新 fence 会明确 step 工作代。
  const legacy =
    step.generation === undefined && !record.events.some((event) => event.type === "plan_revised");
  const generation = getOrchestrationStepGeneration(record.state, stepId);
  return record.attempts.findLast(
    (attempt) => attempt.stepId === stepId && (legacy || attempt.generation === generation),
  );
}

function executionSemantics(step: OrchestrationStep) {
  return {
    role: step.role,
    task: step.task,
    acceptance: step.acceptance,
    maxAttempts: step.maxAttempts ?? DEFAULT_EXTRA_RETRIES,
    optional: step.optional ?? false,
    dependsOn: [...step.dependsOn].sort(),
    inputs: step.inputs ?? DEFAULT_INPUTS,
    writeScope: normalizeWriteScopes(step.writeScope).sort(),
  };
}

/** 同一纯差异规则供写入和逐 revision 回放使用，展示变化不失效已确认的副作用。 */
export function diffOrchestrationPlans(
  previousPlan: OrchestrationPlan,
  plan: OrchestrationPlan,
): Set<string> {
  const oldSteps = new Map(previousPlan.steps.map((step) => [step.stepId, step]));
  const newSteps = new Map(plan.steps.map((step) => [step.stepId, step]));
  const invalidated = new Set<string>();
  for (const [stepId, oldStep] of oldSteps) {
    const next = newSteps.get(stepId);
    if (!next || !isDeepStrictEqual(executionSemantics(oldStep), executionSemantics(next)))
      invalidated.add(stepId);
  }
  for (const stepId of newSteps.keys()) if (!oldSteps.has(stepId)) invalidated.add(stepId);

  // 旧边和新边都参与失效传播，删除或换依赖不能让已完成后继继续引用被重做的输出。
  const dependents = new Map<string, Set<string>>();
  for (const step of [...previousPlan.steps, ...plan.steps]) {
    for (const dependency of step.dependsOn) {
      const children = dependents.get(dependency) ?? new Set<string>();
      children.add(step.stepId);
      dependents.set(dependency, children);
    }
  }
  const pending = [...invalidated];
  for (let index = 0; index < pending.length; index += 1) {
    for (const stepId of dependents.get(pending[index]!) ?? []) {
      if (invalidated.has(stepId)) continue;
      invalidated.add(stepId);
      pending.push(stepId);
    }
  }
  return invalidated;
}

export function createOrchestrationRevisionState(
  state: OrchestrationRunState,
  plan: OrchestrationPlan,
  attempts: readonly OrchestrationAttemptRecord[],
  now: number,
): { state: OrchestrationRunState; invalidatedStepIds: Set<string> } {
  const invalidatedStepIds = diffOrchestrationPlans(state.plan, plan);
  const latest = new Map<string, OrchestrationAttemptRecord>();
  let maximumGeneration = 0;
  for (const step of Object.values(state.steps)) {
    maximumGeneration = Math.max(maximumGeneration, step.generation ?? state.generation);
  }
  for (const attempt of attempts) {
    maximumGeneration = Math.max(maximumGeneration, attempt.generation);
    latest.set(attempt.stepId, attempt);
  }
  const nextGeneration = maximumGeneration + 1;
  if (
    plan.steps.some((step) => invalidatedStepIds.has(step.stepId)) &&
    !Number.isSafeInteger(nextGeneration)
  ) {
    throw new OrchestrationStoreError(
      "invalid_record",
      "Orchestration work generation is exhausted.",
    );
  }
  const steps = Object.fromEntries(
    plan.steps.map((step): [string, OrchestrationStepState] => {
      if (invalidatedStepIds.has(step.stepId)) {
        return [
          step.stepId,
          { stepId: step.stepId, status: "pending", attempts: 0, generation: nextGeneration },
        ];
      }
      const retained = state.steps[step.stepId];
      if (!retained)
        throw new OrchestrationStoreError(
          "invalid_record",
          "Retained orchestration step is missing.",
        );
      return [
        step.stepId,
        {
          ...retained,
          generation:
            retained.generation ?? latest.get(step.stepId)?.generation ?? state.generation,
        },
      ];
    }),
  );
  return { state: { ...state, plan, steps, updatedAt: now }, invalidatedStepIds };
}

/** 新 fence 明确工作代，避免 run generation 增加后把 retained 产物误当成过期。 */
export function materializeOrchestrationStepGenerations(record: OrchestrationRunRecord): void {
  const latest = new Map(record.attempts.map((attempt) => [attempt.stepId, attempt]));
  for (const step of Object.values(record.state.steps)) {
    step.generation ??= latest.get(step.stepId)?.generation ?? record.state.generation;
  }
}
