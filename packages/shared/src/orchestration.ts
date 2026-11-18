import { z } from "zod";
import { normalizeWriteScopes, normalizedWriteScopesOverlap } from "./orchestration-write-scope.js";
export {
  normalizeWriteScope,
  normalizeWriteScopes,
  normalizedWriteScopesOverlap,
  writeScopesOverlap,
} from "./orchestration-write-scope.js";

/**
 * 编排计划（DAG）的共享契约。
 *
 * 这里只放纯数据与纯校验：谁生成计划、谁执行、如何持久化分别由
 * CLI orchestration runtime / host projection 负责。UI 与 Host 只读这份类型。
 */

export const ORCHESTRATION_MAX_STEPS = 32;
export const ORCHESTRATION_MAX_ATTEMPTS = 5;

const stepIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/u, "stepId must be a lowercase slug");

export const orchestrationStepSchema = z
  .object({
    stepId: stepIdSchema,
    title: z.string().trim().min(1).max(200),
    role: z.string().trim().min(1).max(80),
    task: z.string().trim().min(1).max(20_000),
    dependsOn: z.array(stepIdSchema).max(ORCHESTRATION_MAX_STEPS).default([]),
    inputs: z
      .union([z.literal("auto"), z.array(stepIdSchema).max(ORCHESTRATION_MAX_STEPS)])
      .optional(),
    /** 写文件范围；可写角色必须声明，供并行冲突检测与串行化使用。 */
    writeScope: z.array(z.string().trim().min(1).max(500)).max(64).optional(),
    acceptance: z.string().trim().min(1).max(4_000).optional(),
    maxAttempts: z.number().int().min(0).max(ORCHESTRATION_MAX_ATTEMPTS).optional(),
    optional: z.boolean().optional(),
  })
  .strict();

export const orchestrationPlanSchema = z
  .object({
    planId: z.string().trim().min(1).max(120),
    revision: z.number().int().nonnegative(),
    goal: z.string().trim().min(1).max(20_000),
    steps: z.array(orchestrationStepSchema).min(1).max(ORCHESTRATION_MAX_STEPS),
  })
  .strict();

export type OrchestrationStep = z.infer<typeof orchestrationStepSchema>;
export type OrchestrationPlan = z.infer<typeof orchestrationPlanSchema>;

export type OrchestrationPlanIssueCode =
  | "duplicate_step_id"
  | "duplicate_dependency"
  | "self_dependency"
  | "unknown_dependency"
  | "cycle"
  | "role_not_in_team"
  | "invalid_input_dependency"
  | "invalid_write_scope"
  | "missing_write_scope";

export type OrchestrationPlanWarningCode = "parallel_write_scope_overlap";

export interface OrchestrationPlanValidationIssue {
  code: OrchestrationPlanIssueCode;
  message: string;
  stepId?: string;
  relatedStepIds?: string[];
}

export interface OrchestrationPlanValidationWarning {
  code: OrchestrationPlanWarningCode;
  message: string;
  stepIds: [string, string];
}

export interface OrchestrationPlanValidationOptions {
  /** 当前会话选中的角色；general-purpose 应在其中。 */
  team: readonly string[];
  /** 允许写文件的角色；这些角色的 step 必须声明 writeScope。 */
  writableRoles: readonly string[];
}

export interface OrchestrationPlanValidationResult {
  issues: OrchestrationPlanValidationIssue[];
  warnings: OrchestrationPlanValidationWarning[];
}

export function parseOrchestrationPlan(input: unknown) {
  return orchestrationPlanSchema.safeParse(input);
}

/**
 * 语义校验。结构问题（字段缺失/超长）由 zod 负责；这里只检查跨字段约束。
 * 写范围重叠只产生 warning：调度器会把可能并行的重叠步骤串行，不直接判计划失败。
 */
export function validateOrchestrationPlan(
  plan: OrchestrationPlan,
  options: OrchestrationPlanValidationOptions,
): OrchestrationPlanValidationResult {
  const issues: OrchestrationPlanValidationIssue[] = [];
  const warnings: OrchestrationPlanValidationWarning[] = [];
  const team = new Set(options.team);
  const writableRoles = new Set(options.writableRoles);
  const stepById = new Map<string, OrchestrationStep>();

  for (const step of plan.steps) {
    if (stepById.has(step.stepId)) {
      issues.push({
        code: "duplicate_step_id",
        message: `Duplicate stepId: ${step.stepId}`,
        stepId: step.stepId,
      });
      continue;
    }
    stepById.set(step.stepId, step);
  }

  const ancestors = buildDependencyAncestors(stepById);
  const writeScopesById = new Map<string, string[]>();
  for (const step of plan.steps) {
    try {
      writeScopesById.set(step.stepId, normalizeWriteScopes(step.writeScope));
    } catch (error) {
      issues.push({
        code: "invalid_write_scope",
        message: error instanceof Error ? error.message : "Invalid orchestration write scope.",
        stepId: step.stepId,
      });
    }
    if (!team.has(step.role)) {
      issues.push({
        code: "role_not_in_team",
        message: `Step ${step.stepId} uses role ${step.role}, which is not in the current orchestration team.`,
        stepId: step.stepId,
      });
    }
    if (writableRoles.has(step.role) && (!step.writeScope || step.writeScope.length === 0)) {
      issues.push({
        code: "missing_write_scope",
        message: `Writable step ${step.stepId} must declare writeScope so parallel writes can be serialized.`,
        stepId: step.stepId,
      });
    }

    const seenDependencies = new Set<string>();
    for (const dependency of step.dependsOn) {
      if (dependency === step.stepId) {
        issues.push({
          code: "self_dependency",
          message: `Step ${step.stepId} cannot depend on itself.`,
          stepId: step.stepId,
        });
        continue;
      }
      if (seenDependencies.has(dependency)) {
        issues.push({
          code: "duplicate_dependency",
          message: `Step ${step.stepId} lists dependency ${dependency} more than once.`,
          stepId: step.stepId,
        });
      }
      seenDependencies.add(dependency);
      if (!stepById.has(dependency)) {
        issues.push({
          code: "unknown_dependency",
          message: `Step ${step.stepId} depends on unknown step ${dependency}.`,
          stepId: step.stepId,
          relatedStepIds: [dependency],
        });
      }
    }

    if (Array.isArray(step.inputs)) {
      const seenInputs = new Set<string>();
      for (const inputId of step.inputs) {
        // 下游输入若引用尚未完成的步骤，会绕过 DAG 的顺序保证；必须只读取依赖祖先。
        if (
          seenInputs.has(inputId) ||
          inputId === step.stepId ||
          !ancestors.get(step.stepId)?.has(inputId)
        ) {
          issues.push({
            code: "invalid_input_dependency",
            message: `Step ${step.stepId} input ${inputId} must be a unique dependency ancestor.`,
            stepId: step.stepId,
            relatedStepIds: [inputId],
          });
        }
        seenInputs.add(inputId);
      }
    }
  }

  const cycleStepIds = findCycleStepIds(stepById);
  if (cycleStepIds.length > 0) {
    issues.push({
      code: "cycle",
      message: `Orchestration plan contains a dependency cycle: ${cycleStepIds.join(", ")}.`,
      relatedStepIds: cycleStepIds,
    });
  }

  for (let leftIndex = 0; leftIndex < plan.steps.length; leftIndex += 1) {
    const left = plan.steps[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < plan.steps.length; rightIndex += 1) {
      const right = plan.steps[rightIndex];
      if (!right) continue;
      if (
        ancestors.get(left.stepId)?.has(right.stepId) ||
        ancestors.get(right.stepId)?.has(left.stepId)
      )
        continue;
      const leftScopes = writeScopesById.get(left.stepId);
      const rightScopes = writeScopesById.get(right.stepId);
      if (!leftScopes || !rightScopes || !normalizedWriteScopesOverlap(leftScopes, rightScopes))
        continue;
      warnings.push({
        code: "parallel_write_scope_overlap",
        message: `Steps ${left.stepId} and ${right.stepId} may run in parallel and declare overlapping writeScope; the scheduler will serialize them.`,
        stepIds: [left.stepId, right.stepId],
      });
    }
  }

  return { issues, warnings };
}

function findCycleStepIds(stepById: ReadonlyMap<string, OrchestrationStep>): string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycle = new Set<string>();

  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) {
      const startIndex = stack.indexOf(stepId);
      for (const id of stack.slice(startIndex >= 0 ? startIndex : 0)) cycle.add(id);
      return;
    }
    visiting.add(stepId);
    stack.push(stepId);
    const step = stepById.get(stepId);
    for (const dependency of step?.dependsOn ?? []) {
      if (stepById.has(dependency)) visit(dependency);
    }
    stack.pop();
    visiting.delete(stepId);
    visited.add(stepId);
  };

  for (const stepId of stepById.keys()) visit(stepId);
  return [...cycle].sort();
}

function buildDependencyAncestors(
  stepById: ReadonlyMap<string, OrchestrationStep>,
): Map<string, Set<string>> {
  const ancestors = new Map<string, Set<string>>();
  for (const [stepId, step] of stepById) {
    const seen = new Set<string>();
    const pending = [...step.dependsOn];
    for (let index = 0; index < pending.length; index += 1) {
      const current = pending[index];
      if (!current || seen.has(current)) continue;
      seen.add(current);
      pending.push(...(stepById.get(current)?.dependsOn ?? []));
    }
    ancestors.set(stepId, seen);
  }
  return ancestors;
}
