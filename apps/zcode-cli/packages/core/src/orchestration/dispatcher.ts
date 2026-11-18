import type {
  ClaimedOrchestrationAttempt,
  OrchestrationArtifactsPort,
  OrchestrationRunRecord,
  OrchestrationRunStorePort,
} from "./contract.js";
import { OrchestrationStoreError } from "./contract.js";
import { buildOrchestrationStepPrompt } from "./artifacts.js";
import { awaitOrchestrationObservation } from "./observation.js";
import type {
  OrchestrationDispatchContext,
  OrchestrationDispatchHandle,
  OrchestrationDispatchPort,
} from "./dispatch-port.js";

interface ActiveOrchestrationExecution {
  controller: AbortController;
  handles: Map<string, OrchestrationDispatchHandle>;
  pending: Set<Promise<void>>;
  failures: unknown[];
  claimed: boolean;
  promise?: Promise<OrchestrationRunRecord>;
}

export class OrchestrationDispatcher {
  private readonly active = new Map<string, ActiveOrchestrationExecution>();

  constructor(
    private readonly options: {
      store: OrchestrationRunStorePort;
      artifacts: OrchestrationArtifactsPort;
      dispatch: OrchestrationDispatchPort;
    },
  ) {}

  execute(runId: string, context: OrchestrationDispatchContext): Promise<OrchestrationRunRecord> {
    const existing = this.active.get(runId)?.promise;
    if (existing) return existing;
    const execution: ActiveOrchestrationExecution = {
      controller: new AbortController(),
      handles: new Map(),
      pending: new Set(),
      failures: [],
      claimed: false,
    };
    this.active.set(runId, execution);
    execution.promise = this.drive(runId, context, execution).finally(() => {
      if (this.active.get(runId) === execution) this.active.delete(runId);
    });
    return execution.promise;
  }

  async cancel(runId: string): Promise<OrchestrationRunRecord> {
    const record = await this.options.store.cancel(runId);
    const execution = this.active.get(runId);
    if (execution) {
      execution.controller.abort("cancelled");
      await this.stopHandles(execution);
    }
    return record;
  }

  private async drive(
    runId: string,
    context: OrchestrationDispatchContext,
    execution: ActiveOrchestrationExecution,
  ): Promise<OrchestrationRunRecord> {
    try {
      for (;;) {
        if (execution.failures.length) throw execution.failures[0];
        const record = await this.requireRun(runId);
        if (record.owner.sessionId !== context.sessionId) {
          throw new OrchestrationStoreError(
            "owner_mismatch",
            "Orchestration execution must use its parent session.",
          );
        }
        if (record.status === "cancelled" || record.status === "interrupted") {
          execution.controller.abort(record.status);
          await this.stopHandles(execution);
          await Promise.all(execution.pending);
          if (execution.failures.length) throw execution.failures[0];
          return this.requireRun(runId);
        }
        const claims = await this.options.store.claim(runId);
        if (claims.length) execution.claimed = true;
        // claim 与上一次读取之间可能已有前置步骤完成，依赖输入必须使用领取后的已提交快照。
        const claimedRecord = claims.length ? await this.requireRun(runId) : record;
        for (const claim of claims) {
          const operation = this.executeAttempt(context, execution, claimedRecord, claim)
            .catch((error: unknown) => {
              execution.failures.push(error);
            })
            .finally(() => {
              execution.pending.delete(operation);
              execution.handles.delete(claim.attempt.key);
            });
          execution.pending.add(operation);
        }
        if (!execution.pending.size) {
          const final = await this.requireRun(runId);
          if (
            Object.values(final.state.steps).some(
              (step) => step.status === "pending" || step.status === "running",
            )
          ) {
            throw new OrchestrationStoreError(
              "run_conflict",
              "Orchestration has unowned in-flight attempts; reconcile the journal before continuing.",
            );
          }
          return final;
        }
        await Promise.race(execution.pending);
      }
    } catch (error) {
      execution.controller.abort("interrupted");
      const cleanupErrors: unknown[] = [];
      try {
        await this.stopHandles(execution);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      await Promise.all(execution.pending);
      if (execution.claimed) {
        try {
          await this.options.store.recover(runId);
        } catch (recoveryError) {
          cleanupErrors.push(recoveryError);
        }
      }
      if (cleanupErrors.length)
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Orchestration execution and cleanup failed.",
        );
      throw error;
    }
  }

  private async executeAttempt(
    context: OrchestrationDispatchContext,
    execution: ActiveOrchestrationExecution,
    record: OrchestrationRunRecord,
    claim: ClaimedOrchestrationAttempt,
  ): Promise<void> {
    const signal = execution.controller.signal;
    if (signal.aborted || !(await this.isCurrent(claim))) {
      await this.finishStoppedAttempt(claim, signal);
      return;
    }
    let handle: OrchestrationDispatchHandle;
    try {
      handle = await this.options.dispatch.start({
        record,
        claim,
        context,
        prompt: buildOrchestrationStepPrompt(record, claim.step),
        signal,
      });
    } catch (error) {
      if (signal.aborted) await this.finishStoppedAttempt(claim, signal);
      else {
        await this.options.store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
          status: "interrupted",
          error: errorMessage(error),
        });
      }
      return;
    }
    execution.handles.set(claim.attempt.key, handle);
    try {
      const bound = await this.options.store.bindChild(
        claim.runId,
        claim.attempt.key,
        handle.child,
      );
      if (!bound || signal.aborted || !(await this.isCurrent(claim))) {
        await handle.stop();
        await this.finishStoppedAttempt(claim, signal);
        return;
      }
      let result;
      try {
        result = await awaitOrchestrationObservation(handle.wait(), signal);
      } catch (error) {
        await handle.stop();
        await this.options.store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
          status: "interrupted",
          error: errorMessage(error),
        });
        return;
      }
      if (signal.aborted || !(await this.isCurrent(claim))) {
        await handle.stop();
        await this.finishStoppedAttempt(claim, signal);
        return;
      }
      if (result.status === "completed") {
        const artifact = await this.options.artifacts.save(claim.attempt.key, result.content);
        if (signal.aborted) {
          await this.finishStoppedAttempt(claim, signal);
          return;
        }
        await this.options.store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
          status: "completed",
          artifact,
        });
      } else {
        await this.options.store.finish(
          claim.runId,
          claim.attempt.key,
          claim.attempt.generation,
          result,
        );
      }
    } catch (error) {
      try {
        await handle.stop();
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          "Orchestration attempt and child stop failed.",
        );
      }
      throw error;
    }
  }

  private async finishStoppedAttempt(
    claim: ClaimedOrchestrationAttempt,
    signal: AbortSignal,
  ): Promise<void> {
    await this.options.store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
      status: signal.reason === "cancelled" ? "cancelled" : "interrupted",
      error:
        signal.reason === "cancelled"
          ? "Orchestration run was cancelled."
          : "Orchestration run was interrupted before this attempt settled.",
    });
  }

  private async isCurrent(claim: ClaimedOrchestrationAttempt): Promise<boolean> {
    const current = await this.requireRun(claim.runId);
    return (
      current.state.generation === claim.attempt.generation &&
      current.status !== "cancelled" &&
      current.status !== "interrupted" &&
      current.state.steps[claim.step.stepId]?.status === "running" &&
      current.attempts.some(
        (attempt) =>
          attempt.key === claim.attempt.key &&
          (attempt.status === "claimed" || attempt.status === "running"),
      )
    );
  }

  private async stopHandles(execution: ActiveOrchestrationExecution): Promise<void> {
    const results = await Promise.allSettled(
      [...execution.handles.values()].map((handle) => handle.stop()),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, "Orchestration could not stop all child executions.");
  }

  private async requireRun(runId: string): Promise<OrchestrationRunRecord> {
    const record = await this.options.store.get(runId);
    if (!record)
      throw new OrchestrationStoreError("not_found", "Orchestration run does not exist.");
    return record;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
