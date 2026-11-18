import assert from "node:assert/strict";
import test from "node:test";
import { createSessionId, createTraceId } from "@zcode/contracts";
import { NodeOrchestrationJournal } from "../../adapters/src/orchestration/journal.js";
import { NodeOrchestrationArtifactStorage } from "../../adapters/src/orchestration/artifacts.js";
import { OrchestrationRunStore } from "../src/orchestration/runStore.js";
import { OrchestrationArtifacts } from "../src/orchestration/artifacts.js";
import { OrchestrationDispatcher } from "../src/orchestration/dispatcher.js";
import type {
  OrchestrationDispatchPort,
  OrchestrationDispatchResult,
} from "../src/orchestration/dispatch-port.js";
import {
  orchestrationInput,
  orchestrationOwner,
  orchestrationPlan,
  orchestrationStep,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function setup(directory: string, dispatch: OrchestrationDispatchPort) {
  const sessionId = createSessionId("cancellation-parent");
  const owner = orchestrationOwner(directory, { sessionId });
  const store = new OrchestrationRunStore({
    owner,
    journal: new NodeOrchestrationJournal({ rootDirectory: directory, owner }),
  });
  const artifacts = new OrchestrationArtifacts({
    storage: new NodeOrchestrationArtifactStorage({ rootDirectory: directory, owner }),
  });
  const dispatcher = new OrchestrationDispatcher({ store, artifacts, dispatch });
  const context = {
    sessionId,
    trace: { traceId: createTraceId() },
    workingDirectory: owner.workspacePath,
    workspaceRoot: owner.workspacePath,
  };
  return { store, dispatcher, context };
}

function hasCause(error: unknown, expected: Error): boolean {
  return (
    error === expected ||
    (error instanceof AggregateError &&
      error.errors.some((cause: unknown) => hasCause(cause, expected)))
  );
}

test(
  "显式取消遇到 stop 失败时，不等待永不完成的 child，错误与已取消状态均保留",
  { timeout: 5_000 },
  async (t) => {
    await withOrchestrationDirectory(async (directory) => {
      const started = deferred<void>();
      const observationStarted = deferred<void>();
      const waiting = deferred<OrchestrationDispatchResult>();
      const stopped = deferred<void>();
      const failure = new Error("Explicit child stop failed");
      const release = () => waiting.resolve({ status: "interrupted", error: "test cleanup" });
      t.signal.addEventListener("abort", release, { once: true });
      const dispatch: OrchestrationDispatchPort = {
        start: async () => {
          started.resolve();
          return {
            child: { agentId: "child", taskId: "child" },
            wait: () => {
              observationStarted.resolve();
              return waiting.promise;
            },
            stop: async () => {
              stopped.resolve();
              throw failure;
            },
          };
        },
      };
      const { store, dispatcher, context } = setup(directory, dispatch);
      try {
        await store.create(orchestrationInput());
        const executing = dispatcher.execute("fixture-run", context);
        const observed = executing.then(
          () => assert.fail("Stop failure must reject execution"),
          (error: unknown) => assert.ok(hasCause(error, failure)),
        );
        await started.promise;
        await observationStarted.promise;
        await assert.rejects(dispatcher.cancel("fixture-run"), (error: unknown) =>
          hasCause(error, failure),
        );
        await stopped.promise;
        await observed;
        const record = await store.get("fixture-run");
        assert.equal(record?.status, "cancelled");
        assert.equal(record?.state.steps.first?.status, "cancelled");
      } finally {
        release();
        t.signal.removeEventListener("abort", release);
      }
    });
  },
);

test(
  "一个 child lost 时中断其他等待；其他 stop 失败必须报告而非让 run 永久挂起",
  { timeout: 5_000 },
  async (t) => {
    await withOrchestrationDirectory(async (directory) => {
      const bothStarted = deferred<void>();
      const lost = deferred<OrchestrationDispatchResult>();
      const pending = deferred<OrchestrationDispatchResult>();
      const failure = new Error("Sibling child stop failed");
      let starts = 0;
      const release = () => pending.resolve({ status: "interrupted", error: "test cleanup" });
      t.signal.addEventListener("abort", release, { once: true });
      const dispatch: OrchestrationDispatchPort = {
        start: async ({ claim }) => {
          starts += 1;
          if (starts === 2) bothStarted.resolve();
          const isLost = claim.step.stepId === "lost";
          return {
            child: { agentId: claim.step.stepId, taskId: claim.step.stepId },
            wait: () => (isLost ? lost.promise : pending.promise),
            stop: async () => {
              if (!isLost) throw failure;
            },
          };
        },
      };
      const { store, dispatcher, context } = setup(directory, dispatch);
      try {
        await store.create(
          orchestrationInput(
            orchestrationPlan([
              orchestrationStep({ stepId: "lost" }),
              orchestrationStep({ stepId: "pending", role: "reviewer" }),
            ]),
          ),
        );
        const executing = dispatcher.execute("fixture-run", context);
        const observed = executing.then(
          () => assert.fail("Stop failure must reject execution"),
          (error: unknown) => assert.ok(hasCause(error, failure)),
        );
        await bothStarted.promise;
        lost.resolve({ status: "interrupted", error: "Child lost" });
        await observed;
        const record = await store.get("fixture-run");
        assert.equal(record?.status, "interrupted");
        assert.equal(record?.state.steps.pending?.status, "interrupted");
        assert.deepEqual(await store.claim("fixture-run"), []);
      } finally {
        release();
        t.signal.removeEventListener("abort", release);
      }
    });
  },
);
