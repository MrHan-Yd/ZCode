import type { OrchestrationRunRecord } from "./contract.js";
import type {
  OrchestrationConfigState,
  OrchestrationRunProjection,
  OrchestrationStepProjection,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * run journal → 协议只读投影。
 *
 * 不在 journal 里写入任何 UI 字段，也不让 UI 读取 journal：投影只从这里生成，
 * 时间线的“等待 X / 并行组 / 重试次数”全部由 step status + dependsOn 推导。
 */
export function projectOrchestrationRuns(input: {
  runs: readonly OrchestrationRunRecord[];
  activeRunIds: ReadonlySet<string>;
  limit?: number;
}): OrchestrationRunProjection[] {
  const limit = Math.max(1, Math.min(input.limit ?? 8, 8));
  return input.runs.slice(0, limit).map((record) => projectRun(record, input.activeRunIds));
}

export function projectOrchestrationRun(
  record: OrchestrationRunRecord,
  active: boolean,
): OrchestrationRunProjection {
  return {
    runId: record.runId,
    planId: record.state.plan.planId,
    revision: record.state.plan.revision,
    generation: record.state.generation,
    status: record.status,
    team: [...record.team],
    maxConcurrency: record.maxConcurrency,
    startedAt: record.state.startedAt,
    updatedAt: record.state.updatedAt,
    active,
    steps: record.state.plan.steps.map((step) => {
      const state = record.state.steps[step.stepId];
      const latestAttempt = [...record.attempts]
        .reverse()
        .find((attempt) => attempt.stepId === step.stepId);
      return {
        stepId: step.stepId,
        title: step.title,
        role: step.role,
        status: state?.status ?? "pending",
        dependsOn: [...step.dependsOn],
        attempts: state?.attempts ?? 0,
        ...(state?.startedAt === undefined ? {} : { startedAt: state.startedAt }),
        ...(state?.endedAt === undefined ? {} : { endedAt: state.endedAt }),
        ...(state?.error === undefined ? {} : { error: state.error }),
        ...(latestAttempt?.child?.childSessionId === undefined
          ? {}
          : { childSessionId: latestAttempt.child.childSessionId }),
        ...(latestAttempt?.artifact?.uri === undefined
          ? {}
          : { artifactUri: latestAttempt.artifact.uri }),
      } satisfies OrchestrationStepProjection;
    }),
  };
}

export function orchestrationConfigProjection(input: {
  enabled: boolean;
  team: readonly string[];
  maxConcurrency: number;
}): OrchestrationConfigState {
  return {
    enabled: input.enabled,
    team: [...input.team],
    maxConcurrency: input.maxConcurrency,
  };
}

function projectRun(
  record: OrchestrationRunRecord,
  activeRunIds: ReadonlySet<string>,
): OrchestrationRunProjection {
  return projectOrchestrationRun(record, activeRunIds.has(record.runId));
}
