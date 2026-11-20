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
  /** 步骤工作代；旧 v1 缺省沿用 run generation，不等同于整 run fence。 */
  generation?: number;
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
  /** 冷恢复的 run 级暂停；旧 v1 缺省 false，退出确认不会自动解除。 */
  interrupted?: boolean;
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
  /** 已取消但执行尚未确认退出，仍占并发名额与领取时的写范围。 */
  cancellationPending?: boolean;
  startedAt: number;
  endedAt?: number;
  child?: OrchestrationChildReference;
  artifact?: OrchestrationArtifactReference;
  error?: string;
}

export type OrchestrationEventType =
  | "run_created"
  | "plan_revised"
  | "attempt_claimed"
  | "attempt_quiesced"
  | "child_bound"
  | "attempt_completed"
  | "attempt_failed"
  | "attempt_cancelled"
  | "run_cancelled"
  | "run_interrupted";

interface OrchestrationRunEventBase {
  sequence: number;
  /** 提交时的整 run fence，不是 attempt 工作代。 */
  generation: number;
  at: number;
}

export type OrchestrationRunEvent = OrchestrationRunEventBase &
  (
    | {
        type: "plan_revised";
        previousPlan: OrchestrationPlan;
        plan: OrchestrationPlan;
        attemptKey?: never;
      }
    | {
        type: Exclude<OrchestrationEventType, "plan_revised">;
        attemptKey?: string;
        previousPlan?: never;
        plan?: never;
      }
  );

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

/**
 * 冷恢复清单。损坏条目只计入 `invalidRecords`，既不当作空 run，也不删除历史文件；
 * `records` 已按 state.updatedAt 倒序截断到实现侧上限。
 */
export interface OrchestrationJournalListing {
  records: OrchestrationRunRecord[];
  invalidRecords: number;
}

export interface OrchestrationJournalPort {
  transaction<T>(
    runId: string,
    update: (current: OrchestrationRunRecord | undefined) => OrchestrationJournalUpdate<T>,
  ): Promise<T>;
  /**
   * 冷恢复用：列出本 owner 目录里可读的 run 快照。可选——内存实现与测试替身可以缺席，
   * 缺席时服务按「没有历史 run」处理。
   */
  list?(): Promise<OrchestrationJournalListing>;
}

export interface CreateOrchestrationRunInput {
  runId: string;
  plan: OrchestrationPlan;
  team: readonly string[];
  writableRoles: readonly string[];
  maxConcurrency?: number;
  generation?: number;
}

export interface ReviseOrchestrationRunInput {
  runId: string;
  expectedRevision: number;
  plan: OrchestrationPlan;
}

export interface OrchestrationRunRevision {
  record: OrchestrationRunRecord;
  /** 所有尚未确认退出的占位，包含更早修订留下的清理项。 */
  invalidatedAttemptKeys: string[];
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
  revise(input: ReviseOrchestrationRunInput): Promise<OrchestrationRunRevision>;
  confirmAttemptQuiesced(runId: string, attemptKey: string): Promise<boolean>;
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
