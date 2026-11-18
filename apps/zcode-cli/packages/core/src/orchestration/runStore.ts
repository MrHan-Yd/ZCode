import { isDeepStrictEqual } from "node:util";
import {
  assertOrchestrationOwner,
  createOrchestrationAttemptKey,
  deriveOrchestrationRunStatus,
  normalizeCreateOrchestrationRunInput,
  normalizeOrchestrationOwner,
  parseOrchestrationArtifactReference,
  parseOrchestrationChildReference,
  parseOrchestrationRunRecord,
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
  type OrchestrationRunStorePort,
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

const CANCELLED_ERROR = "Orchestration run cancelled.";
const RECOVERY_ERROR =
  "Orchestration interrupted during recovery; terminal evidence is unavailable.";
const FINISH_EVENTS: Record<OrchestrationAttemptOutcome["status"], OrchestrationEventType> = {
  completed: "attempt_completed",
  failed: "attempt_failed",
  cancelled: "attempt_cancelled",
  interrupted: "run_interrupted",
};

function isLive(attempt: OrchestrationAttemptRecord): boolean {
  return attempt.status === "claimed" || attempt.status === "running";
}

function normalizeOutcome(
  input: OrchestrationAttemptOutcome,
  attemptKey: string,
): OrchestrationAttemptOutcome {
  if (!input || typeof input !== "object")
    throw new OrchestrationStoreError("attempt_conflict", "Invalid orchestration outcome.");
  const artifact =
    input.artifact === undefined ? undefined : parseOrchestrationArtifactReference(input.artifact);
  // 产物必须先核对 key，不能让旧 generation 或重复 terminal 掩盖串错 attempt 的引用。
  if (artifact && artifact.attemptKey !== attemptKey)
    throw new OrchestrationStoreError(
      "artifact_conflict",
      "Artifact belongs to a different orchestration attempt.",
    );
  if (Object.keys(input).some((key) => !["status", "artifact", "error"].includes(key)))
    throw new OrchestrationStoreError("attempt_conflict", "Unknown orchestration outcome field.");
  if (input.status === "completed") {
    if (!artifact)
      throw new OrchestrationStoreError(
        "artifact_conflict",
        "Completed orchestration attempt requires an artifact.",
      );
    return { status: "completed", artifact };
  }
  if (
    !["failed", "cancelled", "interrupted"].includes(input.status) ||
    typeof input.error !== "string"
  )
    throw new OrchestrationStoreError(
      "attempt_conflict",
      "Invalid orchestration terminal outcome.",
    );
  return { status: input.status, error: input.error, ...(artifact ? { artifact } : {}) };
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

  claim(runId: string): Promise<ClaimedOrchestrationAttempt[]> {
    return this.transaction(runId, (current) => {
      const record = this.require(current);
      // failed 只描述 required 失败，独立 pending 与其他在飞步骤仍需正常收口。
      if (["cancelled", "interrupted", "completed"].includes(record.status)) return { value: [] };
      const now = this.time(record);
      const ids = claimRunnableSteps(record.state, { maxConcurrency: record.maxConcurrency, now });
      if (!ids.length) return { value: [] };
      const claims = ids.map((stepId): ClaimedOrchestrationAttempt => {
        const step = record.state.plan.steps.find((candidate) => candidate.stepId === stepId);
        const state = record.state.steps[stepId];
        if (!step || !state)
          throw new OrchestrationStoreError("invalid_record", "Claimed step is not in the plan.");
        const attempt: OrchestrationAttemptRecord = {
          key: createOrchestrationAttemptKey(
            runId,
            record.state.plan.revision,
            record.state.generation,
            stepId,
            state.attempts,
          ),
          revision: record.state.plan.revision,
          generation: record.state.generation,
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
      if (
        !attempt ||
        attempt.generation !== record.state.generation ||
        !isLive(attempt) ||
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
    const normalized = normalizeOutcome(outcome, attemptKey);
    return this.transaction(runId, (current) => {
      const record = this.require(current);
      const attempt = record.attempts.find((entry) => entry.key === attemptKey);
      const step = attempt ? record.state.steps[attempt.stepId] : undefined;
      if (
        generation !== record.state.generation ||
        !attempt ||
        attempt.generation !== generation ||
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
      this.advanceGeneration(record);
      cancelRun(record.state, { now });
      for (const attempt of record.attempts.filter(isLive)) {
        attempt.status = "cancelled";
        attempt.endedAt = now;
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
      const live = record.attempts.filter(isLive);
      if (!live.length) return { value: structuredClone(record) };
      const now = this.time(record);
      this.advanceGeneration(record);
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
  ): void {
    const sequence = (record.events.at(-1)?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence))
      throw new OrchestrationStoreError(
        "invalid_record",
        "Orchestration event sequence is exhausted.",
      );
    record.events.push({
      sequence,
      type,
      generation: record.state.generation,
      at,
      ...(attemptKey !== undefined ? { attemptKey } : {}),
    });
  }
}
