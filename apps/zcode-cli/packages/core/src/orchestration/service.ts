import { randomUUID } from "node:crypto";
import type { SubagentPort, TraceContext } from "@zcode/contracts";
import {
  parseOrchestrationPlan,
  validateOrchestrationPlan,
  type OrchestrationPlan,
} from "@zcode/shared";
import { OrchestrationArtifacts } from "./artifacts.js";
import {
  OrchestrationStoreError,
  type OrchestrationArtifactStoragePort,
  type OrchestrationJournalPort,
  type OrchestrationRunOwner,
  type OrchestrationRunRecord,
  type OrchestrationToolPort,
} from "./contract.js";
import type { OrchestrationDispatchContext } from "./dispatch-port.js";
import { OrchestrationDispatcher } from "./dispatcher.js";
import { OrchestrationRunStore } from "./runStore.js";
import { summarizeRun } from "./scheduler.js";
import { SubagentOrchestrationDispatchAdapter } from "./subagent-dispatch-adapter.js";
import { fitContentWithSuffix } from "../tool/executor/result-content-projection.js";
import {
  resolveOrchestrationMaxConcurrency,
  resolveOrchestrationTeam,
  resolveOrchestrationWritableRoles,
} from "./tool-policy.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const COMPLETION_NOTICE_MAX_BYTES = 12 * 1024;

export interface OrchestrationServiceOptions {
  sessionId: string;
  owner: OrchestrationRunOwner;
  journal: OrchestrationJournalPort;
  artifactStorage: OrchestrationArtifactStoragePort;
  subagents: SubagentPort;
  /** 会话冻结的团队；工具不需要、也不允许模型自行改写。 */
  team?: readonly string[];
  maxConcurrency?: number;
  /** 完成通知：由 runtime 投递为后台通知，唤醒主会话做最终汇总。 */
  notify: (input: { runId: string; text: string; traceContext: TraceContext }) => void;
  now?: () => number;
}

export interface StartOrchestrationRunInput {
  plan: unknown;
  team?: readonly string[];
  maxConcurrency?: number;
  context: OrchestrationDispatchContext;
}

export interface AmendOrchestrationRunInput extends StartOrchestrationRunInput {
  runId: string;
}

/**
 * 面向主会话工具面的编排用例层。
 *
 * 状态写入仍然只有 `OrchestrationRunStore` 一个入口；本类只负责「校验计划 → 建 run →
 * 异步驱动 → 完成后通知」这条固定顺序。工具 handler 不直接接触 store / journal / dispatcher。
 */
export class OrchestrationService implements OrchestrationToolPort {
  private readonly store: OrchestrationRunStore;
  private readonly dispatcher: OrchestrationDispatcher;
  private readonly executions = new Map<string, Promise<void>>();

  constructor(private readonly options: OrchestrationServiceOptions) {
    this.store = new OrchestrationRunStore({
      owner: options.owner,
      journal: options.journal,
      ...(options.now ? { now: options.now } : {}),
    });
    this.dispatcher = new OrchestrationDispatcher({
      store: this.store,
      artifacts: new OrchestrationArtifacts({ storage: options.artifactStorage }),
      dispatch: new SubagentOrchestrationDispatchAdapter(options.subagents),
    });
  }

  get owner(): OrchestrationRunOwner {
    return this.store.owner;
  }

  async start(input: StartOrchestrationRunInput): Promise<OrchestrationRunRecord> {
    const prepared = this.preparePlan(input);
    const runId = `orch-${randomUUID()}`;
    const record = await this.store.create({
      runId,
      plan: prepared.plan,
      team: prepared.team,
      writableRoles: prepared.writableRoles,
      maxConcurrency: prepared.maxConcurrency,
    });
    this.launch(runId, input.context);
    return record;
  }

  /**
   * 用户改方向时建立后继 run。
   *
   * v1 只保证「旧 run 显式取消 + revision 递增 + 新 run 启动」；已完成步骤的产物复用与
   * guide 注入属于 Phase 4，不在这一层假装做了。旧 run 的产物仍留在 journal 中可查。
   */
  async amend(input: AmendOrchestrationRunInput): Promise<OrchestrationRunRecord> {
    const previous = await this.store.get(input.runId);
    if (!previous) {
      throw new OrchestrationStoreError("not_found", "Orchestration run was not found.");
    }
    const requested = this.preparePlan(input);
    const revision = Math.max(requested.plan.revision, previous.state.plan.revision + 1);
    if (!TERMINAL_RUN_STATUSES.has(previous.status)) {
      await this.dispatcher.cancel(previous.runId);
    }
    return this.start({
      plan: { ...requested.plan, revision },
      team: requested.team,
      maxConcurrency: requested.maxConcurrency,
      context: input.context,
    });
  }

  async cancel(runId: string): Promise<OrchestrationRunRecord> {
    return this.dispatcher.cancel(runId);
  }

  async get(runId: string): Promise<OrchestrationRunRecord | undefined> {
    return this.store.get(runId);
  }

  private preparePlan(input: StartOrchestrationRunInput): {
    plan: OrchestrationPlan;
    team: string[];
    writableRoles: string[];
    maxConcurrency: number;
  } {
    const parsed = parseOrchestrationPlan(input.plan);
    if (!parsed.success) {
      throw new OrchestrationStoreError(
        "invalid_plan",
        `Orchestration plan is malformed: ${formatZodIssues(parsed.error.issues)}`,
      );
    }
    const team = resolveOrchestrationTeam(input.team ?? this.options.team);
    const writableRoles = resolveOrchestrationWritableRoles(team);
    const validation = validateOrchestrationPlan(parsed.data, { team, writableRoles });
    if (validation.issues.length > 0) {
      throw new OrchestrationStoreError(
        "invalid_plan",
        validation.issues.map((issue) => issue.message).join("\n"),
      );
    }
    return {
      plan: parsed.data,
      team,
      writableRoles,
      maxConcurrency: resolveOrchestrationMaxConcurrency(
        input.maxConcurrency ?? this.options.maxConcurrency,
      ),
    };
  }

  private launch(runId: string, context: OrchestrationDispatchContext): void {
    const execution = this.dispatcher
      .execute(runId, context)
      .then((record) => {
        this.notify(runId, buildOrchestrationCompletionNotice(record), context);
      })
      .catch((error: unknown) => {
        // 运行期基础设施失败不会得到终态记录；仍然必须唤醒主会话，否则它会在「已启动」
        // 之后永远等不到结果。
        this.notify(runId, buildOrchestrationFailureNotice(runId, error), context);
      })
      .finally(() => {
        this.executions.delete(runId);
      });
    this.executions.set(runId, execution);
  }

  private notify(runId: string, text: string, context: OrchestrationDispatchContext): void {
    try {
      this.options.notify({ runId, text, traceContext: context.trace });
    } catch {
      // 通知投递失败只影响「唤醒」；run 终态与产物已持久化，不能让后台 Promise
      // 变成未处理的 rejection。
    }
  }
}

export function buildOrchestrationCompletionNotice(record: OrchestrationRunRecord): string {
  const summary = summarizeRun(record.state);
  const lines = [
    `Orchestration run ${record.runId} (plan "${record.state.plan.planId}", revision ${record.state.plan.revision}) finished with status: ${record.status}.`,
    `Steps: ${summary.completed}/${summary.total} completed, ${summary.failed} failed, ${summary.blocked} blocked, ${summary.cancelled} cancelled, ${summary.interrupted} interrupted, ${summary.pending} pending, ${summary.running} running.`,
    "",
  ];
  for (const step of record.state.plan.steps) {
    const state = record.state.steps[step.stepId];
    if (!state) continue;
    const artifact = latestArtifact(record, step.stepId);
    lines.push(
      [
        `- ${step.stepId} (${step.role}, ${step.title}): ${state.status}`,
        state.error ? ` — ${state.error}` : "",
        artifact ? ` — artifact ${artifact.uri}` : "",
      ].join(""),
    );
  }
  lines.push(
    "",
    record.status === "completed"
      ? "Summarize the completed work for the user. Do not re-run finished steps."
      : "Review the failed or blocked steps and decide whether to amend the plan or report the failure. Do not assume output for steps without an artifact.",
  );
  return boundNotice(lines.join("\n"));
}

export function buildOrchestrationFailureNotice(runId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundNotice(
    [
      `Orchestration run ${runId} stopped because the scheduler failed before reaching a terminal record.`,
      message,
      "Treat unfinished steps as interrupted and decide whether to amend the plan.",
    ].join("\n"),
  );
}

function latestArtifact(record: OrchestrationRunRecord, stepId: string) {
  return [...record.attempts]
    .reverse()
    .find((attempt) => attempt.stepId === stepId && attempt.artifact !== undefined)?.artifact;
}

function formatZodIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.map(String).join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function boundNotice(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= COMPLETION_NOTICE_MAX_BYTES) return text;
  // 通知不是产物：截断到 UTF-8 字符边界即可，原文始终可从 run journal / artifact 读取。
  return fitContentWithSuffix(
    text,
    COMPLETION_NOTICE_MAX_BYTES,
    "\n[... orchestration summary truncated ...]",
    "head",
  );
}
