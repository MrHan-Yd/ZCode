import type {
  OrchestrationArtifactsPort,
  OrchestrationRunRecord,
  OrchestrationRunRevision,
  OrchestrationRunStorePort,
  ReviseOrchestrationRunInput,
} from "./contract.js";
import { OrchestrationStoreError } from "./contract.js";
import { OrchestrationAttemptExecution } from "./attempt-execution.js";
import { OrchestrationControl, OrchestrationProgress } from "./control.js";
import type { OrchestrationDispatchContext, OrchestrationDispatchPort } from "./dispatch-port.js";

interface ActiveOrchestrationExecution {
  controller: AbortController;
  attempts: Map<string, OrchestrationAttemptExecution>;
  progress: OrchestrationProgress;
  cleanupErrors: Map<string, unknown>;
  promise?: Promise<OrchestrationRunRecord>;
}

export class OrchestrationDispatcher {
  private readonly active = new Map<string, ActiveOrchestrationExecution>();
  private readonly control = new OrchestrationControl();

  constructor(
    private readonly options: {
      store: OrchestrationRunStorePort;
      artifacts: OrchestrationArtifactsPort;
      dispatch: OrchestrationDispatchPort;
      onProgress?: () => void;
    },
  ) {}

  runControlled<T>(runId: string, action: () => Promise<T> | T): Promise<T> {
    return this.control.run(runId, action);
  }

  execute(runId: string, context: OrchestrationDispatchContext): Promise<OrchestrationRunRecord> {
    const existing = this.active.get(runId)?.promise;
    if (existing) return existing;
    const execution: ActiveOrchestrationExecution = {
      controller: new AbortController(),
      attempts: new Map(),
      progress: new OrchestrationProgress(),
      cleanupErrors: new Map(),
    };
    this.active.set(runId, execution);
    execution.promise = this.drive(runId, context, execution).finally(() => {
      if (this.active.get(runId) === execution) this.active.delete(runId);
      this.options.onProgress?.();
    });
    return execution.promise;
  }

  async revise(input: ReviseOrchestrationRunInput): Promise<OrchestrationRunRevision> {
    const revised = await this.runControlled(input.runId, async () => {
      const result = await this.options.store.revise(input);
      const execution = this.active.get(input.runId);
      for (const key of result.invalidatedAttemptKeys)
        execution?.attempts.get(key)?.abort("revised");
      this.wake(execution);
      return result;
    });
    // 子代理停止不持有控制闸门：保留的在飞结果和用户整 run 取消仍可正常提交。
    await this.stopInvalidated(revised.record, revised.invalidatedAttemptKeys, true);
    return { ...revised, record: await this.requireRun(input.runId) };
  }

  async cancel(runId: string): Promise<OrchestrationRunRecord> {
    const record = await this.runControlled(runId, async () => {
      const current = await this.options.store.cancel(runId);
      const execution = this.active.get(runId);
      execution?.controller.abort("cancelled");
      this.wake(execution);
      return current;
    });
    await this.stopInvalidated(
      record,
      record.attempts
        .filter((attempt) => attempt.cancellationPending)
        .map((attempt) => attempt.key),
      false,
    );
    return record;
  }

  cleanupError(runId: string): unknown {
    const errors = [...(this.active.get(runId)?.cleanupErrors.values() ?? [])];
    return errors.length
      ? new AggregateError(errors, "Orchestration child cleanup is blocked.")
      : undefined;
  }

  private async drive(
    runId: string,
    context: OrchestrationDispatchContext,
    execution: ActiveOrchestrationExecution,
  ): Promise<OrchestrationRunRecord> {
    try {
      for (;;) {
        const version = execution.progress.version;
        const record = await this.runControlled(runId, async () => {
          const current = await this.requireRun(runId);
          if (current.owner.sessionId !== context.sessionId) {
            throw new OrchestrationStoreError(
              "owner_mismatch",
              "Orchestration execution must use its parent session.",
            );
          }
          for (const [key, slot] of execution.attempts) {
            if (!slot.settled) continue;
            const pending = current.attempts.find(
              (attempt) => attempt.key === key,
            )?.cancellationPending;
            if (slot.error && pending) execution.cleanupErrors.set(key, slot.error);
            else if (slot.error) throw slot.error;
            else {
              execution.attempts.delete(key);
              execution.cleanupErrors.delete(key);
            }
          }
          if (current.status === "cancelled" || current.status === "interrupted") return current;
          const claims = await this.options.store.claim(runId);
          // 领取和所有 starting slot 的登记在同一控制边界内，晚到 ACK 始终有人负责清理。
          const claimedRecord = claims.length ? await this.requireRun(runId) : current;
          for (const claim of claims) {
            const slot = new OrchestrationAttemptExecution(claim, {
              record: claimedRecord,
              context,
              store: this.options.store,
              artifacts: this.options.artifacts,
              dispatch: this.options.dispatch,
              signal: execution.controller.signal,
              onProgress: () => this.wake(execution),
            });
            execution.attempts.set(claim.attempt.key, slot);
          }
          return claimedRecord;
        });
        if (record.status === "cancelled" || record.status === "interrupted") {
          execution.controller.abort(record.status);
          const stops = await Promise.allSettled(
            [...execution.attempts.values()].map((slot) => slot.stop(false)),
          );
          throwFailures(stops, "Orchestration could not stop all child executions.");
          const tasks = await Promise.allSettled(
            [...execution.attempts.values()].map((slot) => slot.task),
          );
          throwFailures(tasks, "Orchestration child executions did not settle.");
          return this.requireRun(runId);
        }
        const hasActive = [...execution.attempts.values()].some((slot) => !slot.settled);
        const hasPendingCleanup = record.attempts.some((attempt) => attempt.cancellationPending);
        if (!hasActive && !hasPendingCleanup) {
          const final = await this.runControlled(runId, async () => {
            const current = await this.requireRun(runId);
            if (current.state.plan.revision !== record.state.plan.revision) return undefined;
            if (
              Object.values(current.state.steps).some(
                (step) => step.status === "pending" || step.status === "running",
              )
            ) {
              throw new OrchestrationStoreError(
                "run_conflict",
                "Orchestration has unowned in-flight attempts; reconcile the journal before continuing.",
              );
            }
            return current;
          });
          if (final) return final;
          continue;
        }
        if (hasPendingCleanup && !hasActive && !execution.attempts.size) {
          throw new OrchestrationStoreError(
            "capability_unavailable",
            "Orchestration has unresolved child execution reservations.",
          );
        }
        await execution.progress.wait(version);
      }
    } catch (error) {
      execution.controller.abort("interrupted");
      const stops = await Promise.allSettled(
        [...execution.attempts.values()].map((slot) => slot.stop(false)),
      );
      const tasks = await Promise.allSettled(
        [...execution.attempts.values()].map((slot) => slot.task),
      );
      const current = await this.requireRun(runId);
      if (
        current.attempts.some(
          (attempt) => attempt.status === "claimed" || attempt.status === "running",
        )
      ) {
        await this.options.store.recover(runId);
      }
      const cleanupErrors = [...stops, ...tasks].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (cleanupErrors.length)
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Orchestration execution and cleanup failed.",
        );
      throw error;
    }
  }

  private async stopInvalidated(
    record: OrchestrationRunRecord,
    keys: readonly string[],
    waitForStartup: boolean,
  ): Promise<void> {
    const execution = this.active.get(record.runId);
    const results = await Promise.allSettled(
      keys.map(async (key) => {
        const slot = execution?.attempts.get(key);
        try {
          if (slot) await slot.stop(waitForStartup);
          else {
            const attempt = record.attempts.find((candidate) => candidate.key === key);
            if (!attempt?.cancellationPending) return;
            if (!attempt.child || !this.options.dispatch.stopChild) {
              throw new OrchestrationStoreError(
                "capability_unavailable",
                "The invalidated child has no recoverable execution exit capability.",
              );
            }
            await this.options.dispatch.stopChild(attempt.child);
            await this.options.store.confirmAttemptQuiesced(record.runId, key);
          }
          execution?.cleanupErrors.delete(key);
        } catch (error) {
          execution?.cleanupErrors.set(key, error);
          throw error;
        } finally {
          this.wake(execution);
        }
      }),
    );
    throwFailures(
      results,
      `Orchestration revision ${record.state.plan.revision} is committed, but child cleanup is blocked.`,
    );
  }

  private wake(execution?: ActiveOrchestrationExecution): void {
    execution?.progress.wake();
    this.options.onProgress?.();
  }

  private async requireRun(runId: string): Promise<OrchestrationRunRecord> {
    const record = await this.options.store.get(runId);
    if (!record)
      throw new OrchestrationStoreError("not_found", "Orchestration run does not exist.");
    return record;
  }
}

function throwFailures(results: readonly PromiseSettledResult<unknown>[], message: string): void {
  const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, message);
}
