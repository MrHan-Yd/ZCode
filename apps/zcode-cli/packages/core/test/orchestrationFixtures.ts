import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OrchestrationPlan, OrchestrationStep } from "@zcode/shared";
import {
  OrchestrationStoreError,
  type ClaimedOrchestrationAttempt,
  type CreateOrchestrationRunInput,
  type OrchestrationJournalPort,
  type OrchestrationJournalUpdate,
  type OrchestrationRunOwner,
  type OrchestrationRunRecord,
} from "../src/orchestration/contract.js";

export function orchestrationOwner(
  rootDirectory: string,
  overrides: Partial<OrchestrationRunOwner> = {},
): OrchestrationRunOwner {
  return {
    workspacePath: join(rootDirectory, "workspace"),
    sessionId: "parent-session",
    ...overrides,
  };
}

export function orchestrationStep(
  overrides: Partial<OrchestrationStep> & Pick<OrchestrationStep, "stepId">,
): OrchestrationStep {
  return {
    title: overrides.stepId,
    role: "architect",
    task: `Execute ${overrides.stepId}`,
    dependsOn: [],
    ...overrides,
  };
}

export function orchestrationPlan(
  steps: OrchestrationStep[] = [orchestrationStep({ stepId: "first" })],
  overrides: Partial<Omit<OrchestrationPlan, "steps">> = {},
): OrchestrationPlan {
  return { planId: "fixture-plan", revision: 0, goal: "Verify orchestration", ...overrides, steps };
}

export function orchestrationInput(
  plan: OrchestrationPlan = orchestrationPlan(),
  overrides: Partial<CreateOrchestrationRunInput> = {},
): CreateOrchestrationRunInput {
  return {
    runId: "fixture-run",
    plan,
    team: [
      "general-purpose",
      "architect",
      "reviewer",
      "ui-designer",
      "frontend",
      "backend",
      "tester",
    ],
    writableRoles: ["general-purpose", "frontend", "backend", "tester"],
    ...overrides,
  };
}

export function orchestrationClock(initial = 1_000): () => number {
  let now = initial;
  return () => ++now;
}

export async function withOrchestrationDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "zcode-orchestration-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function orchestrationError(
  code: OrchestrationStoreError["code"],
): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof OrchestrationStoreError);
    assert.equal(error.code, code);
    return true;
  };
}

export function singleOrchestrationClaim(
  claims: readonly ClaimedOrchestrationAttempt[],
): ClaimedOrchestrationAttempt {
  assert.equal(claims.length, 1);
  const [claim] = claims;
  assert.ok(claim);
  return claim;
}

export class FailingOrchestrationJournal implements OrchestrationJournalPort {
  nextCommitError?: Error;

  constructor(private readonly journal: OrchestrationJournalPort) {}

  transaction<T>(
    runId: string,
    update: (current: OrchestrationRunRecord | undefined) => OrchestrationJournalUpdate<T>,
  ): Promise<T> {
    return this.journal.transaction(runId, (current) => {
      const next = update(current);
      if (next.record && this.nextCommitError) {
        const error = this.nextCommitError;
        this.nextCommitError = undefined;
        throw error;
      }
      return next;
    });
  }
}
