import { findCurrentOrchestrationAttempt } from "@zcode/contracts";
import type {
  ClaimedOrchestrationAttempt,
  OrchestrationArtifactsPort,
  OrchestrationRunRecord,
  OrchestrationRunStorePort,
} from "./contract.js";
import { OrchestrationStoreError } from "./contract.js";
import { buildOrchestrationStepPrompt } from "./artifacts.js";
import { awaitOrchestrationObservation } from "./observation.js";
import {
  OrchestrationDispatchStartError,
  type OrchestrationDispatchContext,
  type OrchestrationDispatchHandle,
  type OrchestrationDispatchPort,
} from "./dispatch-port.js";

export class OrchestrationAttemptExecution {
  readonly controller = new AbortController();
  readonly task: Promise<void>;
  settled = false;
  error?: unknown;
  private handle?: OrchestrationDispatchHandle;
  private startCalled = false;
  private stopPromise?: Promise<void>;

  constructor(
    readonly claim: ClaimedOrchestrationAttempt,
    private readonly options: {
      record: OrchestrationRunRecord;
      context: OrchestrationDispatchContext;
      store: OrchestrationRunStorePort;
      artifacts: OrchestrationArtifactsPort;
      dispatch: OrchestrationDispatchPort;
      signal: AbortSignal;
      onProgress: () => void;
    },
  ) {
    const abort = () => this.controller.abort(options.signal.reason);
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
    // 先同步登记 slot，再开始异步派发；修订不能在 claim 与登记之间遗漏 starting child。
    this.task = Promise.resolve()
      .then(() => this.execute())
      .catch((error: unknown) => {
        this.error = error;
        throw error;
      })
      .finally(() => {
        this.settled = true;
        options.signal.removeEventListener("abort", abort);
        options.onProgress();
      });
    void this.task.catch(() => undefined);
  }

  abort(reason: "cancelled" | "interrupted" | "revised"): void {
    this.controller.abort(reason);
  }

  async stop(waitForStartup: boolean): Promise<void> {
    if (!this.handle && !this.settled) {
      if (!waitForStartup) return;
      await this.task.catch(() => undefined);
    }
    if (this.handle) await this.stopAndConfirm();
    else {
      const current = await this.record();
      const pending = current.attempts.find(
        (attempt) => attempt.key === this.claim.attempt.key,
      )?.cancellationPending;
      if (pending && this.startCalled) {
        if (this.error) throw this.error;
        throw new OrchestrationStoreError(
          "capability_unavailable",
          "The starting child has no confirmed execution exit.",
        );
      }
      if (pending)
        await this.options.store.confirmAttemptQuiesced(this.claim.runId, this.claim.attempt.key);
    }
    this.error = undefined;
    this.options.onProgress();
  }

  private async execute(): Promise<void> {
    const signal = this.controller.signal;
    if (signal.aborted || !(await this.isCurrent())) {
      await this.finishStopped();
      await this.options.store.confirmAttemptQuiesced(this.claim.runId, this.claim.attempt.key);
      return;
    }
    try {
      this.startCalled = true;
      this.handle = await this.options.dispatch.start({
        record: this.options.record,
        claim: this.claim,
        context: this.options.context,
        prompt: buildOrchestrationStepPrompt(this.options.record, this.claim.step),
        signal,
      });
    } catch (error) {
      if (signal.aborted) await this.finishStopped();
      else await this.finishInterrupted(error);
      const current = await this.record();
      if (
        current.attempts.find((attempt) => attempt.key === this.claim.attempt.key)
          ?.cancellationPending
      ) {
        if (!(error instanceof OrchestrationDispatchStartError) || !error.executionQuiesced)
          throw error;
        this.startCalled = false;
        await this.options.store.confirmAttemptQuiesced(this.claim.runId, this.claim.attempt.key);
      }
      return;
    }

    try {
      // 失效 attempt 的晚到 ACK 仍持久化 child 身份，不能只留在内存中供停止。
      await this.options.store.bindChild(
        this.claim.runId,
        this.claim.attempt.key,
        this.handle.child,
      );
      if (signal.aborted || !(await this.isCurrent())) {
        await this.finishStopped();
        await this.stopAndConfirm();
        return;
      }
      let result;
      try {
        result = await awaitOrchestrationObservation(this.handle.wait(), signal);
      } catch (error) {
        if (signal.aborted || !(await this.isCurrent())) await this.finishStopped();
        else await this.finishInterrupted(error);
        await this.stopAndConfirm();
        return;
      }
      if (signal.aborted || !(await this.isCurrent())) {
        await this.finishStopped();
        await this.stopAndConfirm();
        return;
      }
      if (result.status === "completed") {
        const artifact = await this.options.artifacts.save(this.claim.attempt.key, result.content);
        if (signal.aborted || !(await this.isCurrent())) {
          await this.finishStopped();
          await this.stopAndConfirm();
          return;
        }
        await this.options.store.finish(
          this.claim.runId,
          this.claim.attempt.key,
          this.claim.attempt.generation,
          {
            status: "completed",
            artifact,
          },
        );
      } else {
        await this.options.store.finish(
          this.claim.runId,
          this.claim.attempt.key,
          this.claim.attempt.generation,
          result,
        );
      }
    } catch (error) {
      if (this.stopPromise) throw error;
      try {
        await this.stopAndConfirm();
      } catch (stopError) {
        throw new AggregateError(
          [error, stopError],
          "Orchestration attempt and child stop failed.",
        );
      }
      throw error;
    }
  }

  private stopAndConfirm(): Promise<void> {
    return (this.stopPromise ??= (async () => {
      await this.handle!.stop();
      await this.options.store.confirmAttemptQuiesced(this.claim.runId, this.claim.attempt.key);
    })().catch((error: unknown) => {
      this.stopPromise = undefined;
      throw error;
    }));
  }

  private async finishStopped(): Promise<void> {
    await this.options.store.finish(
      this.claim.runId,
      this.claim.attempt.key,
      this.claim.attempt.generation,
      {
        status: this.controller.signal.reason === "cancelled" ? "cancelled" : "interrupted",
        error:
          this.controller.signal.reason === "cancelled"
            ? "Orchestration run was cancelled."
            : "Orchestration attempt no longer belongs to the current plan.",
      },
    );
  }

  private async finishInterrupted(error: unknown): Promise<void> {
    await this.options.store.finish(
      this.claim.runId,
      this.claim.attempt.key,
      this.claim.attempt.generation,
      {
        status: "interrupted",
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }

  private async isCurrent(): Promise<boolean> {
    const current = await this.record();
    const attempt = findCurrentOrchestrationAttempt(current, this.claim.step.stepId);
    return (
      current.status !== "cancelled" &&
      current.status !== "interrupted" &&
      current.state.steps[this.claim.step.stepId]?.status === "running" &&
      attempt?.key === this.claim.attempt.key &&
      !attempt.cancellationPending &&
      (attempt.status === "claimed" || attempt.status === "running")
    );
  }

  private async record(): Promise<OrchestrationRunRecord> {
    const record = await this.options.store.get(this.claim.runId);
    if (!record)
      throw new OrchestrationStoreError("not_found", "Orchestration run does not exist.");
    return record;
  }
}
