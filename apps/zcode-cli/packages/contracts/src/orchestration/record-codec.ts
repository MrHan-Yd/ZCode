import { createHash } from "node:crypto";
import type { OrchestrationStep } from "@zcode/shared";
import type {
  OrchestrationAttemptRecord,
  OrchestrationRunRecord,
  OrchestrationRunState,
  OrchestrationRunStatus,
} from "./contract.js";
import { validateOrchestrationRunHistory } from "./record-history.js";
import {
  invalidRecord,
  parseOrchestrationRunShape,
  recordInteger,
  recordText,
} from "./record-shape.js";
export {
  normalizeCreateOrchestrationRunInput,
  parseOrchestrationChildReference,
} from "./record-shape.js";

const DEFAULT_EXTRA_RETRIES = 1;

export function createOrchestrationAttemptKey(
  runId: string,
  revision: number,
  generation: number,
  stepId: string,
  attempt: number,
): string {
  const identity = [
    recordText(runId),
    recordInteger(revision),
    recordInteger(generation),
    recordText(stepId),
    recordInteger(attempt, 1),
  ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export function deriveOrchestrationRunStatus(state: OrchestrationRunState): OrchestrationRunStatus {
  let running = false;
  let pending = false;
  let interrupted = false;
  let failed = false;
  if (state.cancelled) return "cancelled";
  for (const step of state.plan.steps) {
    const status = state.steps[step.stepId]?.status;
    if (!step.optional && status === "cancelled") return "cancelled";
    if (status === "interrupted") interrupted = true;
    if (!step.optional && (status === "failed" || status === "blocked")) failed = true;
    if (status === "running") running = true;
    if (status === "pending") pending = true;
  }
  if (interrupted) return "interrupted";
  if (failed) return "failed";
  if (running) return "running";
  if (pending) return "pending";
  return "completed";
}

function validateAttempts(
  record: OrchestrationRunRecord,
  steps: ReadonlyMap<string, OrchestrationStep>,
): Map<string, OrchestrationAttemptRecord> {
  const byKey = new Map<string, OrchestrationAttemptRecord>();
  const histories = new Map<string, OrchestrationAttemptRecord[]>();
  for (const attempt of record.attempts) {
    const history = histories.get(attempt.stepId) ?? [];
    if (!steps.has(attempt.stepId) || byKey.has(attempt.key))
      return invalidRecord("Unknown or duplicate attempt.");
    const previousAttempt = history.at(-1);
    // 只有确认 failed 的前次执行才允许重试，不能把中断或已完成的副作用重新派发。
    if (
      previousAttempt &&
      (previousAttempt.status !== "failed" ||
        (previousAttempt.endedAt ?? Infinity) > attempt.startedAt)
    )
      return invalidRecord("Attempt history contains an invalid retry.");
    if (
      attempt.revision !== record.state.plan.revision ||
      attempt.generation > record.state.generation ||
      attempt.attempt !== history.length + 1
    )
      return invalidRecord("Attempt revision, generation or number is inconsistent.");
    if (
      attempt.key !==
      createOrchestrationAttemptKey(
        record.runId,
        attempt.revision,
        attempt.generation,
        attempt.stepId,
        attempt.attempt,
      )
    )
      return invalidRecord("Attempt key is inconsistent.");
    if (
      attempt.startedAt < record.state.startedAt ||
      (attempt.endedAt ?? attempt.startedAt) > record.state.updatedAt
    )
      return invalidRecord();
    history.push(attempt);
    histories.set(attempt.stepId, history);
    byKey.set(attempt.key, attempt);
  }
  for (const step of steps.values()) {
    const state = record.state.steps[step.stepId];
    if (!state) return invalidRecord();
    const history = histories.get(step.stepId) ?? [];
    const latest = history.at(-1);
    const retries = step.maxAttempts ?? DEFAULT_EXTRA_RETRIES;
    if (state.attempts !== history.length || state.attempts > retries + 1)
      return invalidRecord("Step attempt count differs from history.");
    const live = latest?.status === "claimed" || latest?.status === "running";
    if (state.status === "running") {
      if (
        !live ||
        latest?.generation !== record.state.generation ||
        state.startedAt !== latest.startedAt ||
        state.endedAt !== undefined
      )
        return invalidRecord();
    } else if (live) return invalidRecord("Live attempt does not belong to a running step.");
    if (
      state.status === "pending" &&
      latest &&
      (latest.status !== "failed" || state.attempts > retries)
    )
      return invalidRecord();
    if (state.status === "completed" && latest?.status !== "completed") return invalidRecord();
    if (state.status === "failed" && (latest?.status !== "failed" || state.attempts <= retries))
      return invalidRecord();
    if (state.status === "interrupted" && latest?.status !== "interrupted") return invalidRecord();
    if (state.status === "blocked") {
      // blocked 只能由失败依赖传播；无依赖 root 的伪终态会让未执行的计划被误判成功。
      const blockedByFailure = step.dependsOn.some((dependencyId) => {
        const dependency = steps.get(dependencyId);
        const dependencyState = record.state.steps[dependencyId];
        return (
          dependency &&
          !dependency.optional &&
          dependencyState &&
          ["failed", "blocked", "cancelled"].includes(dependencyState.status)
        );
      });
      if (history.length || !blockedByFailure)
        return invalidRecord("Blocked step has no failed required dependency.");
    }
    if (
      state.status === "cancelled" &&
      (!record.state.cancelled ? latest?.status !== "cancelled" : latest?.status === "completed")
    )
      return invalidRecord();
    if (state.status !== "pending" && state.status !== "running" && state.endedAt === undefined)
      return invalidRecord();
    if (
      (state.startedAt !== undefined && state.startedAt < record.state.startedAt) ||
      (state.endedAt ?? state.startedAt ?? record.state.startedAt) > record.state.updatedAt
    )
      return invalidRecord();
    if (record.state.cancelled && ["pending", "running", "interrupted"].includes(state.status))
      return invalidRecord();
  }
  return byKey;
}

export function parseOrchestrationRunRecord(input: unknown): OrchestrationRunRecord {
  const record = parseOrchestrationRunShape(input);
  const steps = new Map(record.state.plan.steps.map((step) => [step.stepId, step]));
  const attempts = validateAttempts(record, steps);
  validateOrchestrationRunHistory(record, attempts, steps);
  if (record.status !== deriveOrchestrationRunStatus(record.state))
    return invalidRecord("Run status differs from step state.");
  return record;
}
