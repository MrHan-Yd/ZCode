import {
  ORCHESTRATION_MAX_STEPS,
  parseOrchestrationPlan,
  validateOrchestrationPlan,
} from "@zcode/shared";
import { parseOrchestrationArtifactReference } from "./artifact-codec.js";
import {
  OrchestrationStoreError,
  type CreateOrchestrationRunInput,
  type OrchestrationAttemptRecord,
  type OrchestrationChildReference,
  type OrchestrationRunEvent,
  type OrchestrationRunOwner,
  type OrchestrationRunRecord,
  type OrchestrationRunState,
  type OrchestrationStepState,
} from "./contract.js";
import { normalizeOrchestrationOwner } from "./owner.js";

const RECORD_VERSION = 1;
const MAX_TEAM_SIZE = 8;
const MAX_ROLE_LENGTH = 80;
const DEFAULT_MAX_CONCURRENCY = 3;
const STEP_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
  "interrupted",
] as const;
const ATTEMPT_STATUSES = [
  "claimed",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
const RUN_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;
const EVENT_TYPES = [
  "run_created",
  "plan_revised",
  "attempt_claimed",
  "attempt_quiesced",
  "child_bound",
  "attempt_completed",
  "attempt_failed",
  "attempt_cancelled",
  "run_cancelled",
  "run_interrupted",
] as const;

export function invalidRecord(message = "Invalid orchestration run record."): never {
  throw new OrchestrationStoreError("invalid_record", message);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!isObject(value)) return invalidRecord();
  if (keys && Object.keys(value).some((key) => !keys.includes(key)))
    return invalidRecord("Unknown orchestration record field.");
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) return invalidRecord();
  return value;
}

export function recordText(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) return invalidRecord();
  return value;
}

export function recordInteger(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum)
    return invalidRecord();
  return value;
}

function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return invalidRecord();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") return invalidRecord();
  return value;
}

function enumeration<T extends string>(value: unknown, choices: readonly T[]): T {
  return choices.find((choice) => choice === value) ?? invalidRecord();
}

function roles(value: unknown, team = false, normalize = false): string[] {
  const parsed = array(value).map((role) => recordText(role).trim());
  const result = normalize ? [...new Set(parsed)] : parsed;
  if (
    result.some((role) => role.length > MAX_ROLE_LENGTH) ||
    new Set(result).size !== result.length
  )
    return invalidRecord();
  if (team && (!result.includes("general-purpose") || result.length > MAX_TEAM_SIZE))
    return invalidRecord("Invalid orchestration team.");
  return result;
}

function concurrency(value: unknown): number {
  const result = recordInteger(value, 1);
  return result <= ORCHESTRATION_MAX_STEPS
    ? result
    : invalidRecord("Invalid orchestration concurrency.");
}

export function normalizeCreateOrchestrationRunInput(input: CreateOrchestrationRunInput) {
  try {
    if (!input) return invalidRecord("Orchestration requires a create input.");
    const parsed = parseOrchestrationPlan(input.plan);
    if (!parsed.success) return invalidRecord("Invalid orchestration plan structure.");
    recordInteger(parsed.data.revision);
    const team = roles(input.team, true, true);
    const writableRoles = roles(input.writableRoles, false, true);
    if (validateOrchestrationPlan(parsed.data, { team, writableRoles }).issues.length)
      return invalidRecord("Invalid orchestration plan semantics.");
    return {
      runId: recordText(input.runId),
      plan: parsed.data,
      team,
      writableRoles,
      maxConcurrency: concurrency(input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY),
      generation: recordInteger(input.generation ?? 0),
    };
  } catch (error) {
    if (!(error instanceof OrchestrationStoreError)) throw error;
    throw new OrchestrationStoreError("invalid_plan", error.message, { cause: error });
  }
}

function owner(value: unknown): OrchestrationRunOwner {
  const input = object(value, [
    "workspacePath",
    "workspaceIdentity",
    "remoteSessionId",
    "sessionId",
  ]);
  return normalizeOrchestrationOwner({
    workspacePath: recordText(input.workspacePath),
    sessionId: recordText(input.sessionId),
    ...(input.workspaceIdentity !== undefined
      ? { workspaceIdentity: recordText(input.workspaceIdentity, true) }
      : {}),
    ...(input.remoteSessionId !== undefined
      ? { remoteSessionId: recordText(input.remoteSessionId, true) }
      : {}),
  });
}

export function parseOrchestrationChildReference(value: unknown): OrchestrationChildReference {
  const input = object(value, ["agentId", "taskId", "childSessionId", "outputFile"]);
  return {
    agentId: recordText(input.agentId),
    taskId: recordText(input.taskId),
    ...(input.childSessionId !== undefined
      ? { childSessionId: recordText(input.childSessionId) }
      : {}),
    ...(input.outputFile !== undefined ? { outputFile: recordText(input.outputFile) } : {}),
  };
}

function stepState(value: unknown, stepId: string): OrchestrationStepState {
  const input = object(value, [
    "stepId",
    "status",
    "attempts",
    "generation",
    "startedAt",
    "endedAt",
    "error",
  ]);
  if (recordText(input.stepId) !== stepId)
    return invalidRecord("Step map key does not match stepId.");
  const result: OrchestrationStepState = {
    stepId,
    status: enumeration(input.status, STEP_STATUSES),
    attempts: recordInteger(input.attempts),
    ...(input.generation !== undefined ? { generation: recordInteger(input.generation) } : {}),
    ...(input.startedAt !== undefined ? { startedAt: timestamp(input.startedAt) } : {}),
    ...(input.endedAt !== undefined ? { endedAt: timestamp(input.endedAt) } : {}),
    ...(input.error !== undefined ? { error: recordText(input.error, true) } : {}),
  };
  if (
    result.startedAt !== undefined &&
    result.endedAt !== undefined &&
    result.endedAt < result.startedAt
  )
    return invalidRecord();
  return result;
}

function persistedPlan(value: unknown, team: string[], writableRoles: string[]) {
  const parsed = parseOrchestrationPlan(value);
  if (!parsed.success) return invalidRecord("Invalid orchestration plan structure.");
  recordInteger(parsed.data.revision);
  if (validateOrchestrationPlan(parsed.data, { team, writableRoles }).issues.length)
    return invalidRecord("Invalid orchestration plan semantics.");
  return parsed.data;
}

function runState(value: unknown, team: string[], writableRoles: string[]): OrchestrationRunState {
  const input = object(value, [
    "plan",
    "generation",
    "steps",
    "startedAt",
    "updatedAt",
    "cancelled",
    "interrupted",
  ]);
  const plan = persistedPlan(input.plan, team, writableRoles);
  const stepMap = object(input.steps);
  if (
    Object.keys(stepMap).length !== plan.steps.length ||
    plan.steps.some((step) => !Object.hasOwn(stepMap, step.stepId))
  )
    return invalidRecord("Plan and step map differ.");
  const result: OrchestrationRunState = {
    plan,
    generation: recordInteger(input.generation),
    steps: Object.fromEntries(
      plan.steps.map((step) => [step.stepId, stepState(stepMap[step.stepId], step.stepId)]),
    ),
    startedAt: timestamp(input.startedAt),
    updatedAt: timestamp(input.updatedAt),
    cancelled: boolean(input.cancelled),
    ...(input.interrupted !== undefined ? { interrupted: boolean(input.interrupted) } : {}),
  };
  if (result.updatedAt < result.startedAt) return invalidRecord();
  return result;
}

function attemptRecord(value: unknown): OrchestrationAttemptRecord {
  const input = object(value, [
    "key",
    "revision",
    "generation",
    "stepId",
    "attempt",
    "status",
    "cancellationPending",
    "startedAt",
    "endedAt",
    "child",
    "artifact",
    "error",
  ]);
  let artifact: OrchestrationAttemptRecord["artifact"];
  if (input.artifact !== undefined) {
    try {
      artifact = parseOrchestrationArtifactReference(input.artifact);
    } catch (error) {
      if (!(error instanceof OrchestrationStoreError)) throw error;
      throw new OrchestrationStoreError(
        "invalid_record",
        "Invalid persisted orchestration artifact.",
        { cause: error },
      );
    }
  }
  const result: OrchestrationAttemptRecord = {
    key: recordText(input.key),
    revision: recordInteger(input.revision),
    generation: recordInteger(input.generation),
    stepId: recordText(input.stepId),
    attempt: recordInteger(input.attempt, 1),
    status: enumeration(input.status, ATTEMPT_STATUSES),
    ...(input.cancellationPending !== undefined
      ? { cancellationPending: boolean(input.cancellationPending) }
      : {}),
    startedAt: timestamp(input.startedAt),
    ...(input.endedAt !== undefined ? { endedAt: timestamp(input.endedAt) } : {}),
    ...(input.child !== undefined ? { child: parseOrchestrationChildReference(input.child) } : {}),
    ...(artifact ? { artifact } : {}),
    ...(input.error !== undefined ? { error: recordText(input.error, true) } : {}),
  };
  const live = result.status === "claimed" || result.status === "running";
  if (live ? result.endedAt !== undefined : result.endedAt === undefined)
    return invalidRecord("Attempt terminal timestamp is inconsistent.");
  if (result.endedAt !== undefined && result.endedAt < result.startedAt) return invalidRecord();
  if (
    (result.status === "claimed" && result.child) ||
    (result.status === "running" && !result.child)
  )
    return invalidRecord();
  if (result.status === "completed" && !result.artifact)
    return invalidRecord("Completed attempt has no artifact.");
  if (result.artifact && result.artifact.attemptKey !== result.key)
    return invalidRecord("Artifact attempt key differs.");
  if (result.cancellationPending !== undefined && result.status !== "cancelled")
    return invalidRecord("Only cancelled attempts may reserve child cleanup.");
  return result;
}

function eventRecord(
  value: unknown,
  team: string[],
  writableRoles: string[],
): OrchestrationRunEvent {
  const input = object(value, [
    "sequence",
    "type",
    "generation",
    "at",
    "attemptKey",
    "previousPlan",
    "plan",
  ]);
  const type = enumeration(input.type, EVENT_TYPES);
  const base = {
    sequence: recordInteger(input.sequence, 1),
    generation: recordInteger(input.generation),
    at: timestamp(input.at),
  };
  if (type === "plan_revised") {
    if (input.attemptKey !== undefined)
      return invalidRecord("Plan revisions must not carry an attempt key.");
    return {
      ...base,
      type,
      previousPlan: persistedPlan(input.previousPlan, team, writableRoles),
      plan: persistedPlan(input.plan, team, writableRoles),
    };
  }
  if (input.plan !== undefined || input.previousPlan !== undefined)
    return invalidRecord("Unexpected plan revision payload.");
  return {
    ...base,
    type,
    ...(input.attemptKey !== undefined ? { attemptKey: recordText(input.attemptKey) } : {}),
  };
}

export function parseOrchestrationRunShape(input: unknown): OrchestrationRunRecord {
  if (!isObject(input)) return invalidRecord();
  if (input.version !== undefined && input.version !== RECORD_VERSION)
    throw new OrchestrationStoreError(
      "unsupported_version",
      "Unsupported orchestration run record version.",
    );
  const value = object(input, [
    "version",
    "runId",
    "owner",
    "team",
    "writableRoles",
    "maxConcurrency",
    "status",
    "state",
    "attempts",
    "events",
  ]);
  if (value.version !== RECORD_VERSION) return invalidRecord();
  const team = roles(value.team, true);
  const writableRoles = roles(value.writableRoles);
  return {
    version: RECORD_VERSION,
    runId: recordText(value.runId),
    owner: owner(value.owner),
    team,
    writableRoles,
    maxConcurrency: concurrency(value.maxConcurrency),
    status: enumeration(value.status, RUN_STATUSES),
    state: runState(value.state, team, writableRoles),
    attempts: array(value.attempts).map(attemptRecord),
    events: array(value.events).map((event) => eventRecord(event, team, writableRoles)),
  };
}
