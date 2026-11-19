import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentPort } from "@zcode/contracts";
import { NodeOrchestrationArtifactStorage } from "../../adapters/src/orchestration/artifacts.js";
import { NodeOrchestrationJournal } from "../../adapters/src/orchestration/journal.js";
import type { OrchestrationRunRecord } from "../src/orchestration/contract.js";
import { projectOrchestrationRuns } from "../src/orchestration/projection.js";
import { OrchestrationService } from "../src/orchestration/service.js";
import {
  orchestrationOwner,
  orchestrationPlan,
  orchestrationStep,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

const TEAM = ["general-purpose", "Explore", "tester"] as const;

function stubSubagents(): SubagentPort {
  return {} as SubagentPort;
}

test("session configuration updates without rebuilding the service", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const owner = orchestrationOwner(directory);
    const service = new OrchestrationService({
      sessionId: owner.sessionId,
      owner,
      journal: new NodeOrchestrationJournal({ rootDirectory: directory, owner }),
      artifactStorage: new NodeOrchestrationArtifactStorage({ rootDirectory: directory, owner }),
      subagents: stubSubagents(),
      team: ["general-purpose", "tester"],
      maxConcurrency: 2,
      notify: () => {},
    });

    assert.deepEqual(service.currentTeam(), ["general-purpose", "Explore", "tester"]);
    assert.equal(service.currentMaxConcurrency(), 2);
    assert.deepEqual(service.listRuns(), []);

    service.updateConfiguration({ team: ["tester", "reviewer"], maxConcurrency: 4 });
    assert.deepEqual(service.currentTeam(), ["general-purpose", "Explore", "tester", "reviewer"]);
    assert.equal(service.currentMaxConcurrency(), 4);
  });
});

test("run projection exposes steps, dependencies, retries and child sessions", () => {
  const plan = orchestrationPlan([
    orchestrationStep({ stepId: "design", role: "Explore" }),
    orchestrationStep({
      stepId: "build",
      role: "general-purpose",
      dependsOn: ["design"],
      writeScope: ["src"],
    }),
  ]);
  const record: OrchestrationRunRecord = {
    version: 1,
    runId: "run-1",
    owner: {
      workspacePath: "/workspace",
      sessionId: "parent-session",
    },
    team: [...TEAM],
    writableRoles: ["general-purpose", "tester"],
    maxConcurrency: 3,
    status: "running",
    state: {
      plan,
      generation: 2,
      steps: {
        design: {
          stepId: "design",
          status: "completed",
          attempts: 1,
          startedAt: 10,
          endedAt: 20,
        },
        build: {
          stepId: "build",
          status: "running",
          attempts: 2,
          startedAt: 30,
          error: "retrying",
        },
      },
      startedAt: 1,
      updatedAt: 40,
      cancelled: false,
    },
    attempts: [
      {
        key: "attempt-1",
        revision: 0,
        generation: 2,
        stepId: "design",
        attempt: 1,
        status: "completed",
        startedAt: 10,
        endedAt: 20,
        child: { agentId: "agent-1", taskId: "task-1", childSessionId: "child-1" },
      },
    ],
    events: [],
  };

  const [projected] = projectOrchestrationRuns({
    runs: [record],
    activeRunIds: new Set(["run-1"]),
  });
  assert.ok(projected);
  assert.equal(projected.active, true);
  assert.equal(projected.generation, 2);
  assert.equal(projected.steps.length, 2);
  const [design, build] = projected.steps;
  assert.equal(design?.status, "completed");
  assert.equal(design?.childSessionId, "child-1");
  assert.deepEqual(build?.dependsOn, ["design"]);
  assert.equal(build?.attempts, 2);
  assert.equal(build?.error, "retrying");
});
