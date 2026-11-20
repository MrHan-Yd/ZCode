import { isDeepStrictEqual } from "node:util";
import {
  assertOrchestrationOwner,
  createOrchestrationAttemptKey,
  deriveOrchestrationRunStatus,
  normalizeCreateOrchestrationRunInput,
  normalizeOrchestrationOwner,
  parseOrchestrationChildReference,
  parseOrchestrationRunRecord,
  claimBlockedByOrchestrationCleanup,
  getOrchestrationStepGeneration,
  materializeOrchestrationStepGenerations,
  orchestrationCleanupReservations,
} from "@zcode/contracts";
import {
  OrchestrationStoreError,
  type ClaimedOrchestrationAttempt,
  type CreateOrchestrationRunInput,
  type OrchestrationAttemptOutcome,
  type OrchestrationAttemptRecord,
  type OrchestrationChildReference,
  type OrchestrationEventType,
  type OrchestrationJournalPort,
  type OrchestrationJournalUpdate,
  type OrchestrationRunOwner,
  type OrchestrationRunRecord,
  type OrchestrationRunRevision,
  type OrchestrationRunStorePort,
  type ReviseOrchestrationRunInput,
} from "./contract.js";
import {
  cancelRun,
  claimRunnableSteps,
  completeStep,
  createInitialRunState,
  failStep,
  isRunTerminal,
  markBlockedSteps,
} from "./scheduler.js";
import { FINISH_EVENTS, normalizeAttemptOutcome } from "./runStoreOutcome.js";
import { confirmOrchestrationQuiesced, reviseOrchestrationRecord } from "./runStoreRevision.js";

const CANCELLED_ERROR = "Orchestration run cancelled.";
const RECOVERY_ERROR =
  "Orchestration interrupted during recovery; terminal evidence is unavailable.";
function isLive(attempt: OrchestrationAttemptRecord): boolean {
  return attempt.status === "claimed" || attempt.status === "running";
}

export class OrchestrationRunStore implements OrchestrationRunStorePort {
  private readonly runOwner: OrchestrationRunOwner;
  private readonly journal: OrchestrationJournalPort;
  private readonly now: () => number;

  constructor(options: {
    owner: OrchestrationRunOwner;
    journal: OrchestrationJournalPort;
    now?: () => number;
  }) {
    this.runOwner = normalizeOrchestrationOwner(options.owner);
    this.journal = options.journal;
    this.now = options.now ?? Date.now;
  }

  get owner(): OrchestrationRunOwner {
    return structuredClone(this.runOwner);
  }

  async create(input: CreateOrchestrationRunInput): Promise<OrchestrationRunRecord> {
    const normalized = normalizeCreateOrchestrationRunInput(input);
    return this.transaction(normalized.runId, (current) => {
      if (current) {
        const existing = {
          runId: current.runId,
          plan: current.state.plan,
          team: current.team,
          writableRoles: current.writableRoles,
          maxConcurrency: current.maxConcurrency,
          generation: current.events[0]?.generation,
        };
        if (!isDeepStrictEqual(normalized, existing))
          throw new OrchestrationStoreError(
            "run_conflict",
            "Orchestration runId already has a different plan or execution configuration.",
          );
        return { value: structuredClone(current) };
      }
      const now = this.time();
      const record: OrchestrationRunRecord = {
        version: 1,
        runId: normalized.runId,
        owner: this.owner,
        team: normalized.team,
        writableRoles: normalized.writableRoles,
        maxConcurrency: normalized.maxConcurrency,
        status: "pending",
        state: createInitialRunState(normalized.plan, { generation: normalized.generation, now }),
        attempts: [],
        events: [],
      };
      this.append(record, "run_created", now);
      return this.commit(record, record);
    });
  }

  get(runId: string): Promise<OrchestrationRunRecord | undefined> {
    return this.transaction(runId, (record) => ({
      value: record === undefined ? undefined : structuredClone(record),
    }));
  }

  revise(input: ReviseOrchestrationRunInput): Promise<OrchestrationRunRevision> {
    return this.transaction(input.runId, (current) => {
      const record = this.require(current);
      const now = this.time(record);
      const revised = reviseOrchestrationRecord(record, input, now);
      if (revised.record !== record)
        return {
          value: {
            record: revised.record,
            invalidatedAttemptKeys: revised.invalidatedAttemptKeys,
          } satisfies OrchestrationRunRevision,
        };
      this.append(record, "plan_revised", now, undefined, {
        previousPlan: revised.previousPlan,
        plan: record.state.plan,
      });
      return this.commit(record, {
        record,
        invalidatedAttemptKeys: revised.invalidatedAttemptKeys,
      } satisfies OrchestrationRunRevision);
    });
  }

  confirmAttemptQuiesced(runId: string, attemptKey: string): Promise<boolean> {
    return this.transaction(runId, (current) => {
      const record = this.require(current);
      if (!confirmOrchestrationQuiesced(record, attemptKey)) return { value: false };
      const now = this.time(record);
      record.state.updatedAt = now;
      this.append(record, "attempt_quiesced", now, attemptKey);
      return this.commit(record, true);
    });
  }

  claim(runId: string): Promise<ClaimedOrchestrationAttempt[]> {
    return this.transaction(runId, (current) => {
      const record = this.require(current);
      // failed 只描述 required 失败，独立 pending 与其他在飞步骤仍需正常收口。
      if (["cancelled", "interrupted", "completed"].includes(record.status)) return { value: [] };
      const now = this.time(record);
      const ids = claimRunnableSteps(record.state, {
        maxConcurrency: record.maxConcurrency,
        now,
        reservedConcurrency: orchestrationCleanupReservations(record).length,
        isBlocked: (step) => claimBlockedByOrchestrationCleanup(record, step),
      });
      if (!ids.length) return { value: [] };
      const claims = ids.map((stepId): ClaimedOrchestrationAttempt => {
        const step = record.state.plan.steps.find((candidate) => candidate.stepId === stepId);
        const state = record.state.steps[stepId];
        if (!step || !state)
          throw new OrchestrationStoreError("invalid_record", "Claimed step is not in the plan.");
        const generation =
          getOrchestrationStepGeneration(record.state, stepId) ?? record.state.generation;
        const attempt: OrchestrationAttemptRecord = {
          key: createOrchestrationAttemptKey(
            runId,
            record.state.plan.revision,
            generation,
            stepId,
            state.attempts,
          ),
          revision: record.state.plan.revision,
          generation,
          stepId,
          attempt: state.attempts,
          status: "claimed",
          startedAt: now,
        };
        record.attempts.push(attempt);
        this.append(record, "attempt_claimed", now, attempt.key);
        return { runId, step, attempt };
      });
      return this.commit(record, claims);
    });
  }

  async bindChild(
    runId: string,
    attemptKey: string,
    child: OrchestrationChildReference,
  ): Promise<boolean> {
    let normalized: OrchestrationChildReference;
    try {
      normalized = parseOrchestrationChildReference(child);
    } catch (error) {
      if (!(error instanceof OrchestrationStoreError)) throw error;
      throw new OrchestrationStoreError(
        "attempt_conflict",
        "Invalid orchestration child reference.",
        { cause: error },
      );
    }
    return this.transaction(runId, (current) => {
      const record = this.require(current);
      const attempt = record.attempts.find((entry) => entry.key === attemptKey);
      if (!attempt) return { value: false };
      // 已被 plan revision fence 的 attempt 只允许补记真实 child 身份供停止；
      // 不恢复 live，也不允许另一个 child 覆盖同一 attempt。
      if (attempt.status === "cancelled" && attempt.cancellationPending === true) {
        if (attempt.child) {
          if (!isDeepStrictEqual(attempt.child, normalized))
            throw new OrchestrationStoreError(
              "attempt_conflict",
              "Orchestration attempt is already bound to a different child.",
            );
          return { value: false };
        }
        attempt.child = normalized;
        const now = this.time(record);
        record.state.updatedAt = now;
        this.append(record, "child_bound", now, attemptKey);
        return this.commit(record, true);
      }
      if (
        !isLive(attempt) ||
        attempt.generation !== getOrchestrationStepGeneration(record.state, attempt.stepId) ||
        record.state.steps[attempt.stepId]?.status !== "running"
      )
        return { value: false };
      if (attempt.child) {
        if (!isDeepStrictEqual(attempt.child, normalized))
          throw new OrchestrationStoreError(
            "attempt_conflict",
            "Orchestration attempt is already bound to a different child.",
          );
        return { value: false };
      }
      attempt.child = normalized;
      attempt.status = "running";
      const now = this.time(record);
      record.state.updatedAt = now;
      this.append(record, "child_bound", now, attemptKey);
      return this.commit(record, true);
    });
  }

  async finish(
    runId: string,
    attemptKey: string,
    generation: number,
    outcome: OrchestrationAttemptOutcome,
  ): Promise<boolean> {
    const normalized = normalizeAttemptOutcome(outcome, attemptKey);
    return this.transaction(runId, (current) => {
      const record = this.require(current);
      const attempt = record.attempts.find((entry) => entry.key === attemptKey);
      const step = attempt ? record.state.steps[attempt.stepId] : undefined;
      if (
        !attempt ||
        attempt.generation !== generation ||
        getOrchestrationStepGeneration(record.state, attempt.stepId) !== generation ||
        attempt.cancellationPending === true ||
        !isLive(attempt) ||
        step?.status !== "running"
      )
        return { value: false };
      const now = this.time(record);
      attempt.status = normalized.status;
      attempt.endedAt = now;
      if (normalized.artifact) attempt.artifact = normalized.artifact;
      if (normalized.status === "completed") {
        completeStep(record.state, attempt.stepId, { now });
      } else {
        attempt.error = normalized.error;
        if (normalized.status === "failed")
          failStep(record.state, attempt.stepId, normalized.error, { now });
        else {
          // cancelled 不扣重试；interrupted 没有 terminal 证据，保留其他在飞步骤供 driver 显式 stop/收口。
          step.status = normalized.status;
          step.error = normalized.error;
          step.endedAt = now;
          record.state.updatedAt = now;
          if (normalized.status === "cancelled") markBlockedSteps(record.state, now);
        }
      }
      this.append(record, FINISH_EVENTS[normalized.status], now, attemptKey);
      return this.commit(record, true);
    });
  }

  cancel(runId: string): Promise<OrchestrationRunRecord> {
    return this.transaction(runId, (current) => {
      const record = this.require(current);
      if (
        record.state.cancelled ||
        (isRunTerminal(record.state) &&
          !Object.values(record.state.steps).some((step) => step.status === "interrupted"))
      )
        return { value: structuredClone(record) };
      const now = this.time(record);
      materializeOrchestrationStepGenerations(record);
      this.advanceGeneration(record);
      cancelRun(record.state, { now });
      for (const attempt of record.attempts.filter(isLive)) {
        attempt.status = "cancelled";
        attempt.endedAt = now;
        attempt.cancellationPending = true;
        attempt.error = CANCELLED_ERROR;
      }
      this.append(record, "run_cancelled", now);
      return this.commit(record, record);
    });
  }

  /** 调用方必须已持有父 session 的 owner/lease；本 store 不负责获取租约。 */
  recover(runId: string): Promise<OrchestrationRunRecord> {
    return this.transaction(runId, (current) => {
      const record = this.require(current);
      if (record.state.cancelled) return { value: structuredClone(record) };
      const live = record.attempts.filter(isLive);
      const pending = record.attempts.some((attempt) => attempt.cancellationPending === true);
      if (!live.length && (!pending || record.state.interrupted === true))
        return { value: structuredClone(record) };
      const now = this.time(record);
      materializeOrchestrationStepGenerations(record);
      this.advanceGeneration(record);
      record.state.interrupted = true;
      for (const attempt of live) {
        const step = record.state.steps[attempt.stepId];
        if (!step)
          throw new OrchestrationStoreError("invalid_record", "Recovery attempt has no step.");
        attempt.status = "interrupted";
        attempt.endedAt = now;
        attempt.error = RECOVERY_ERROR;
        step.status = "interrupted";
        step.endedAt = now;
        step.error = RECOVERY_ERROR;
      }
      record.state.updatedAt = now;
      this.append(record, "run_interrupted", now);
      return this.commit(record, record);
    });
  }

  private transaction<T>(
    runId: string,
    update: (record: OrchestrationRunRecord | undefined) => OrchestrationJournalUpdate<T>,
  ): Promise<T> {
    if (typeof runId !== "string" || !runId.trim())
      return Promise.reject(
        new OrchestrationStoreError("invalid_record", "Orchestration requires a runId."),
      );
    return this.journal.transaction(runId, (current) => {
      const record = current === undefined ? undefined : parseOrchestrationRunRecord(current);
      if (record) {
        assertOrchestrationOwner(record.owner, this.runOwner);
        if (record.runId !== runId)
          throw new OrchestrationStoreError(
            "invalid_record",
            "Journal record runId differs from the request.",
          );
      }
      return update(record);
    });
  }

  private require(record: OrchestrationRunRecord | undefined): OrchestrationRunRecord {
    if (!record) throw new OrchestrationStoreError("not_found", "Orchestration run was not found.");
    return record;
  }

  private commit<T>(record: OrchestrationRunRecord, value: T): OrchestrationJournalUpdate<T> {
    record.status = deriveOrchestrationRunStatus(record.state);
    return { record: parseOrchestrationRunRecord(record), value: structuredClone(value) };
  }

  private time(record?: OrchestrationRunRecord): number {
    const now = this.now();
    if (!Number.isFinite(now) || now < 0)
      throw new OrchestrationStoreError("invalid_record", "Invalid orchestration clock.");
    return Math.max(now, record?.state.updatedAt ?? now);
  }

  private advanceGeneration(record: OrchestrationRunRecord): void {
    if (!Number.isSafeInteger(record.state.generation + 1))
      throw new OrchestrationStoreError("invalid_record", "Orchestration generation is exhausted.");
    record.state.generation += 1;
  }

  private append(
    record: OrchestrationRunRecord,
    type: OrchestrationEventType,
    at: number,
    attemptKey?: string,
    revision?: {
      previousPlan: OrchestrationRunRecord["state"]["plan"];
      plan: OrchestrationRunRecord["state"]["plan"];
    },
  ): void {
    const sequence = (record.events.at(-1)?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence))
      throw new OrchestrationStoreError(
        "invalid_record",
        "Orchestration event sequence is exhausted.",
      );
    const event = {
      sequence,
      type,
      generation: record.state.generation,
      at,
      ...(attemptKey !== undefined ? { attemptKey } : {}),
      ...revision,
    };
    record.events.push(event as OrchestrationRunRecord["events"][number]);
  }
}
