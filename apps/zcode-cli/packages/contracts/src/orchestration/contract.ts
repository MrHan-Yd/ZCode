import type { OrchestrationPlan, OrchestrationStep } from "@zcode/shared";

export type OrchestrationStepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled"
  | "interrupted";

export interface OrchestrationStepState {
  stepId: string;
  status: OrchestrationStepStatus;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
  error?: string;
}

export interface OrchestrationRunState {
  plan: OrchestrationPlan;
  generation: number;
  steps: Record<string, OrchestrationStepState>;
  startedAt: number;
  updatedAt: number;
  cancelled: boolean;
}

export interface OrchestrationRunOwner {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  sessionId: string;
}

export type OrchestrationRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export type OrchestrationAttemptStatus =
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface OrchestrationChildReference {
  agentId: string;
  taskId: string;
  childSessionId?: string;
  outputFile?: string;
}

export interface OrchestrationArtifactReference {
  artifactId: string;
  attemptKey: string;
  uri: string;
  summary: string;
  originalBytes: number;
  savedBytes: number;
  sha256: string;
  truncated: boolean;
  summaryTruncated: boolean;
}

export interface OrchestrationAttemptRecord {
  key: string;
  revision: number;
  generation: number;
  stepId: string;
  attempt: number;
  status: OrchestrationAttemptStatus;
  startedAt: number;
  endedAt?: number;
  child?: OrchestrationChildReference;
  artifact?: OrchestrationArtifactReference;
  error?: string;
}

export type OrchestrationEventType =
  | "run_created"
  | "attempt_claimed"
  | "child_bound"
  | "attempt_completed"
  | "attempt_failed"
  | "attempt_cancelled"
  | "run_cancelled"
  | "run_interrupted";

export interface OrchestrationRunEvent {
  sequence: number;
  type: OrchestrationEventType;
  generation: number;
  at: number;
  attemptKey?: string;
}

export interface OrchestrationRunRecord {
  version: 1;
  runId: string;
  owner: OrchestrationRunOwner;
  team: string[];
  writableRoles: string[];
  maxConcurrency: number;
  status: OrchestrationRunStatus;
  state: OrchestrationRunState;
  attempts: OrchestrationAttemptRecord[];
  events: OrchestrationRunEvent[];
}

export interface OrchestrationJournalUpdate<T> {
  record?: OrchestrationRunRecord;
  value: T;
}

export interface OrchestrationJournalPort {
  transaction<T>(
    runId: string,
    update: (current: OrchestrationRunRecord | undefined) => OrchestrationJournalUpdate<T>,
  ): Promise<T>;
}

export interface CreateOrchestrationRunInput {
  runId: string;
  plan: OrchestrationPlan;
  team: readonly string[];
  writableRoles: readonly string[];
  maxConcurrency?: number;
  generation?: number;
}

export interface ClaimedOrchestrationAttempt {
  runId: string;
  step: OrchestrationStep;
  attempt: OrchestrationAttemptRecord;
}

export type OrchestrationAttemptOutcome =
  | { status: "completed"; artifact: OrchestrationArtifactReference }
  | {
      status: "failed" | "cancelled" | "interrupted";
      error: string;
      artifact?: OrchestrationArtifactReference;
    };

export interface OrchestrationRunStorePort {
  readonly owner: OrchestrationRunOwner;
  create(input: CreateOrchestrationRunInput): Promise<OrchestrationRunRecord>;
  get(runId: string): Promise<OrchestrationRunRecord | undefined>;
  claim(runId: string): Promise<ClaimedOrchestrationAttempt[]>;
  bindChild(
    runId: string,
    attemptKey: string,
    child: OrchestrationChildReference,
  ): Promise<boolean>;
  finish(
    runId: string,
    attemptKey: string,
    generation: number,
    outcome: OrchestrationAttemptOutcome,
  ): Promise<boolean>;
  cancel(runId: string): Promise<OrchestrationRunRecord>;
  recover(runId: string): Promise<OrchestrationRunRecord>;
}

export interface OrchestrationArtifactWrite {
  attemptKey: string;
  content: string;
  sourceSha256: string;
  summary: string;
  originalBytes: number;
  savedBytes: number;
  sha256: string;
  truncated: boolean;
  summaryTruncated: boolean;
}

export interface OrchestrationArtifactStoragePort {
  write(input: OrchestrationArtifactWrite): Promise<OrchestrationArtifactReference>;
  read(reference: OrchestrationArtifactReference): Promise<string>;
}

export interface OrchestrationArtifactsPort {
  save(attemptKey: string, content: string): Promise<OrchestrationArtifactReference>;
  read(reference: OrchestrationArtifactReference): Promise<string>;
}

export class OrchestrationStoreError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "run_conflict"
      | "owner_mismatch"
      | "invalid_plan"
      | "invalid_record"
      | "unsupported_version"
      | "attempt_conflict"
      | "artifact_conflict"
      | "capability_unavailable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OrchestrationStoreError";
  }
}
