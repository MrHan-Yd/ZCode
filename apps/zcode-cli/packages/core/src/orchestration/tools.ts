import { CoreErrorType, createCoreError, type TraceContext } from "@zcode/contracts";
import type { OrchestrationRunRecord, OrchestrationToolPort } from "./contract.js";
import { OrchestrationStoreError } from "./contract.js";
import type { OrchestrationDispatchContext } from "./dispatch-port.js";
import { summarizeRun } from "./scheduler.js";
import {
  AMEND_ORCHESTRATION_PLAN_TOOL_NAME,
  CANCEL_ORCHESTRATION_RUN_TOOL_NAME,
  CREATE_ORCHESTRATION_PLAN_TOOL_NAME,
} from "./tool-policy.js";
import type { ToolEntry, ToolExecutionContext, ToolHandler } from "../tool/types.js";

const MAX_MODEL_BYTES = 24_000;

const STEP_SCHEMA = {
  type: "object",
  properties: {
    stepId: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]*$",
      description: "Stable lowercase slug, unique within the plan.",
    },
    title: { type: "string", description: "Short human-readable title." },
    role: {
      type: "string",
      description:
        "Built-in role from the orchestration team (for example general-purpose, Explore).",
    },
    task: {
      type: "string",
      description:
        "Self-contained prompt for the role. Include the files, constraints, and expected output.",
    },
    dependsOn: {
      type: "array",
      items: { type: "string" },
      description: "Step ids that must complete before this step may start.",
    },
    inputs: {
      description:
        "Defaults to the structured summaries of direct dependencies. Use an explicit list only to narrow to dependency ancestors.",
      oneOf: [
        { type: "string", enum: ["auto"] },
        { type: "array", items: { type: "string" } },
      ],
    },
    writeScope: {
      type: "array",
      items: { type: "string" },
      description:
        "Workspace-relative files or directories this step may write. Required for writable roles.",
    },
    acceptance: { type: "string", description: "Acceptance criteria for the step." },
    maxAttempts: {
      type: "integer",
      minimum: 0,
      maximum: 5,
      description: "Additional retries after the first failure. Default 1.",
    },
    optional: {
      type: "boolean",
      description: "When true, failure does not block the run.",
    },
  },
  required: ["stepId", "title", "role", "task"],
  additionalProperties: false,
};

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    planId: { type: "string", description: "Stable plan identity; keep it across amendments." },
    revision: {
      type: "integer",
      minimum: 0,
      description: "Increment when the user changes direction.",
    },
    goal: { type: "string", description: "What the completed run must achieve." },
    steps: { type: "array", items: STEP_SCHEMA, minItems: 1, maxItems: 32 },
  },
  required: ["planId", "revision", "goal", "steps"],
  additionalProperties: false,
};

const CREATE_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: { plan: PLAN_SCHEMA },
  required: ["plan"],
  additionalProperties: false,
};

const AMEND_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    runId: { type: "string", description: "The active run whose plan should be updated." },
    plan: PLAN_SCHEMA,
  },
  required: ["runId", "plan"],
  additionalProperties: false,
};

const CANCEL_INPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    runId: { type: "string", description: "The orchestration run to cancel." },
  },
  required: ["runId"],
  additionalProperties: false,
};

const LAUNCH_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    status: { const: "async_launched", type: "string" },
    runId: { type: "string" },
    planId: { type: "string" },
    revision: { type: "integer", minimum: 0 },
    stepCount: { type: "integer", minimum: 1 },
    team: { type: "array", items: { type: "string" } },
    previousRunId: { type: "string" },
    revised: { type: "boolean" },
  },
  required: ["status", "runId", "planId", "revision", "stepCount", "team"],
  additionalProperties: false,
};

const CANCEL_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["pending", "running", "completed", "failed", "cancelled", "interrupted"],
    },
    runId: { type: "string" },
    planId: { type: "string" },
    revision: { type: "integer", minimum: 0 },
    summary: {
      type: "object",
      properties: {
        total: { type: "integer", minimum: 0 },
        completed: { type: "integer", minimum: 0 },
        failed: { type: "integer", minimum: 0 },
        blocked: { type: "integer", minimum: 0 },
        cancelled: { type: "integer", minimum: 0 },
        interrupted: { type: "integer", minimum: 0 },
      },
      required: ["total", "completed", "failed", "blocked", "cancelled", "interrupted"],
      additionalProperties: false,
    },
  },
  required: ["status", "runId", "planId", "revision", "summary"],
  additionalProperties: false,
};

function requireOrchestrationService(context: ToolExecutionContext): OrchestrationToolPort {
  if (!context.orchestrationService) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Orchestration is enabled but no orchestration runtime is configured for this session.",
      {
        context: { toolCallId: context.toolCallId },
        recoverable: false,
      },
    );
  }
  return context.orchestrationService;
}

function dispatchContext(context: ToolExecutionContext): OrchestrationDispatchContext {
  return {
    sessionId: context.sessionId,
    ...(context.turnId ? { turnId: context.turnId } : {}),
    trace: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    } as TraceContext,
    ...(context.model ? { model: context.model } : {}),
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  };
}

async function runOrchestrationAction<T>(
  context: ToolExecutionContext,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof OrchestrationStoreError)) throw error;
    throw createCoreError(CoreErrorType.ToolExecutionFailed, `${error.code}: ${error.message}`, {
      cause: error,
      context: { code: error.code, toolCallId: context.toolCallId },
      // 计划校验失败是模型可自行修正的业务失败；基础设施/存储错误继续向上抛。
      recoverable: error.code === "invalid_plan" || error.code === "not_found",
    });
  }
}

const createHandler: ToolHandler = async (input, context) => {
  const service = requireOrchestrationService(context);
  const plan = (input as { plan?: unknown } | null | undefined)?.plan;
  const record = await runOrchestrationAction(context, () =>
    service.start({ plan, context: dispatchContext(context) }),
  );
  return launchOutput(record);
};

const amendHandler: ToolHandler = async (input, context) => {
  const service = requireOrchestrationService(context);
  const value = (input ?? {}) as { runId?: unknown; plan?: unknown };
  const runId = requireRunId(value.runId, context);
  const record = await runOrchestrationAction(context, () =>
    service.amend({ runId, plan: value.plan, context: dispatchContext(context) }),
  );
  return { ...launchOutput(record), revised: true };
};

const cancelHandler: ToolHandler = async (input, context) => {
  const service = requireOrchestrationService(context);
  const runId = requireRunId((input as { runId?: unknown } | null | undefined)?.runId, context);
  const record = await runOrchestrationAction(context, () => service.cancel(runId));
  return {
    status: record.status,
    runId: record.runId,
    planId: record.state.plan.planId,
    revision: record.state.plan.revision,
    summary: summarizeForOutput(record),
  };
};

function requireRunId(value: unknown, context: ToolExecutionContext): string {
  if (typeof value !== "string" || !value.trim()) {
    throw createCoreError(CoreErrorType.InvalidInput, "runId must be a non-empty string.", {
      context: { toolCallId: context.toolCallId },
      recoverable: true,
    });
  }
  return value.trim();
}

function launchOutput(record: OrchestrationRunRecord) {
  return {
    status: "async_launched" as const,
    runId: record.runId,
    planId: record.state.plan.planId,
    revision: record.state.plan.revision,
    stepCount: record.state.plan.steps.length,
    team: [...record.team],
  };
}

function summarizeForOutput(record: OrchestrationRunRecord) {
  const summary = summarizeRun(record.state);
  return {
    total: summary.total,
    completed: summary.completed,
    failed: summary.failed,
    blocked: summary.blocked,
    cancelled: summary.cancelled,
    interrupted: summary.interrupted,
  };
}

function formatLaunchOutput(output: unknown): string {
  const value = output as ReturnType<typeof launchOutput> & {
    previousRunId?: string;
    revised?: boolean;
  };
  return [
    value.revised
      ? `Orchestration run revised in place: ${value.runId}`
      : `Orchestration run launched: ${value.runId}`,
    `plan: "${value.planId}" revision ${value.revision}`,
    `team: ${value.team.join(", ")}`,
    `steps: ${value.stepCount}`,
    "",
    value.revised
      ? "The same run continues with the revised DAG. Unchanged steps keep their child sessions and completed artifacts; only new or changed steps are re-dispatched. Do not call CreateOrchestrationPlan for the same task."
      : "The deterministic scheduler is executing the DAG in the background. Do not launch the same plan again. You will receive a completion notification with per-step status and artifact references.",
  ].join("\n");
}

function formatCancelOutput(output: unknown): string {
  const value = output as {
    status: string;
    runId: string;
    summary: { total: number; completed: number; failed: number };
  };
  return [
    `Orchestration run ${value.runId} is now ${value.status}.`,
    `Steps: ${value.summary.completed}/${value.summary.total} completed, ${value.summary.failed} failed.`,
    "Completed step artifacts are preserved. Late child results from the cancelled generation are discarded.",
  ].join("\n");
}

function basePermission(reason: string) {
  return {
    permission: "orchestration",
    reason,
    riskLevel: "low" as const,
    sideEffectScope: "session" as const,
    needsApproval: false,
    patternSources: ["toolName" as const],
    alwaysAllowPatternSources: ["toolName" as const],
    denyPriority: "beforeAsk" as const,
  };
}

function baseTrace(): ToolEntry["trace"] {
  return {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  };
}

export const createOrchestrationPlanToolEntry: ToolEntry = {
  capability:
    "Validate and launch a deterministic DAG of subagent steps without editing files from the main session",
  metadata: {
    name: CREATE_ORCHESTRATION_PLAN_TOOL_NAME,
    description: [
      "Launch an orchestration run from a deterministic DAG plan.",
      "",
      "Use this instead of dispatching subagents yourself. The scheduler starts steps only after their `dependsOn` steps complete, runs independent steps in parallel, and serializes steps whose `writeScope` overlaps.",
      "",
      "Rules:",
      "- Every step role must belong to the session's orchestration team.",
      "- Writable roles must declare `writeScope`.",
      "- `task` is a self-contained prompt: the child does not see this conversation.",
      "- The tool returns immediately with `async_launched`; a completion notification reports per-step status and artifact references.",
    ].join("\n"),
    allowedInPlanMode: true,
    readOnly: false,
    destructive: false,
    concurrentSafe: false,
    maxOutputBytes: MAX_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: createHandler,
  formatModelContent: formatLaunchOutput,
  inputSchema: CREATE_INPUT_SCHEMA,
  outputSchema: LAUNCH_OUTPUT_SCHEMA,
  permission: basePermission(
    "CreateOrchestrationPlan starts a scheduler that dispatches already-constrained subagents",
  ),
  resultBudget: {
    maxInlineBytes: MAX_MODEL_BYTES,
    maxModelBytes: MAX_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: 30_000, maxMs: 60_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CreateOrchestrationPlan was cancelled before the run was created",
  },
  trace: baseTrace(),
};

export const amendOrchestrationPlanToolEntry: ToolEntry = {
  ...createOrchestrationPlanToolEntry,
  capability: "Update the active orchestration run's plan in place",
  metadata: {
    ...createOrchestrationPlanToolEntry.metadata,
    name: AMEND_ORCHESTRATION_PLAN_TOOL_NAME,
    description: [
      "Update the active orchestration plan in place with a new revision.",
      "",
      "Keep the runId and planId. Unchanged steps keep their child sessions and completed artifacts; only steps whose execution semantics changed, new steps, and dependent steps are re-dispatched. The revision must increase by one; send the complete plan, not a patch.",
    ].join("\n"),
  },
  handler: amendHandler,
  formatModelContent: formatLaunchOutput,
  inputSchema: AMEND_INPUT_SCHEMA,
  outputSchema: LAUNCH_OUTPUT_SCHEMA,
  permission: basePermission(
    "AmendOrchestrationPlan updates the active run and re-dispatches only invalidated steps",
  ),
  trace: baseTrace(),
};

export const cancelOrchestrationRunToolEntry: ToolEntry = {
  ...createOrchestrationPlanToolEntry,
  capability: "Cancel an orchestration run and stop its in-flight child executions",
  metadata: {
    ...createOrchestrationPlanToolEntry.metadata,
    name: CANCEL_ORCHESTRATION_RUN_TOOL_NAME,
    description: [
      "Cancel an orchestration run. In-flight children are stopped explicitly; completed step artifacts are preserved, and late results from the cancelled generation are discarded.",
    ].join("\n"),
    timeoutMs: 120_000,
  },
  handler: cancelHandler,
  formatModelContent: formatCancelOutput,
  inputSchema: CANCEL_INPUT_SCHEMA,
  outputSchema: CANCEL_OUTPUT_SCHEMA,
  permission: basePermission("CancelOrchestrationRun stops the run's in-flight child executions"),
  timeout: { defaultMs: 120_000, maxMs: 180_000, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "CancelOrchestrationRun was cancelled before child stop was confirmed",
  },
  trace: baseTrace(),
};
