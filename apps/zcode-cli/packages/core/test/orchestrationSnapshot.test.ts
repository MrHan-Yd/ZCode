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

test(
  "get 与 claim 之间前置步骤完成时，刚领取的下游必须使用更新后的产物快照",
  { timeout: 5_000 },
  async () => {
    await withOrchestrationDirectory(async (directory) => {
      const sessionId = createSessionId("snapshot-parent");
      const owner = orchestrationOwner(directory, { sessionId });
      const journal = new NodeOrchestrationJournal({ rootDirectory: directory, owner });
      const artifacts = new OrchestrationArtifacts({
        storage: new NodeOrchestrationArtifactStorage({ rootDirectory: directory, owner }),
      });
      const ownerStore = new OrchestrationRunStore({ owner, journal });
      const joining = deferred<OrchestrationDispatchResult>();
      const unrelatedWaitStarted = deferred<void>();
      let completeBetweenReadAndClaim = false;
      let prompts: string[] = [];
      const store = new (class extends OrchestrationRunStore {
        override async claim(runId: string) {
          if (completeBetweenReadAndClaim) {
            completeBetweenReadAndClaim = false;
            const record = await ownerStore.get(runId);
            const attempt = record?.attempts.find((entry) => entry.stepId === "ancestor");
            assert.ok(attempt);
            const artifact = await artifacts.save(
              attempt.key,
              "Newly confirmed dependency artifact",
            );
            await ownerStore.finish(runId, attempt.key, attempt.generation, {
              status: "completed",
              artifact,
            });
            joining.resolve({
              status: "completed",
              content: "Newly confirmed dependency artifact",
            });
          }
          return super.claim(runId);
        }
      })({ owner, journal });
      const dispatch: OrchestrationDispatchPort = {
        start: async ({ claim, prompt }) => {
          const id = claim.step.stepId;
          prompts.push(prompt);
          return {
            child: { agentId: id, taskId: id },
            wait: async () => {
              if (id === "ancestor") return joining.promise;
              if (id === "unrelated") {
                unrelatedWaitStarted.resolve();
                completeBetweenReadAndClaim = true;
              }
              return { status: "completed", content: `Result ${id}` };
            },
            stop: async () => {},
          };
        },
      };
      await store.create(
        orchestrationInput(
          orchestrationPlan([
            orchestrationStep({ stepId: "ancestor" }),
            orchestrationStep({ stepId: "unrelated", role: "reviewer" }),
            orchestrationStep({
              stepId: "consumer",
              role: "tester",
              dependsOn: ["ancestor"],
              writeScope: ["tests"],
            }),
          ]),
        ),
      );
      const dispatcher = new OrchestrationDispatcher({ store, artifacts, dispatch });
      const result = await dispatcher.execute("fixture-run", {
        sessionId,
        trace: { traceId: createTraceId() },
        workingDirectory: owner.workspacePath,
        workspaceRoot: owner.workspacePath,
      });
      assert.equal(result.status, "completed");
      assert.equal(result.state.steps.consumer?.status, "completed");
      assert.equal(prompts.length, 3);
      assert.ok(prompts[2]?.includes("Newly confirmed dependency artifact"));
    });
  },
);
