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
  type OrchestrationAttemptOutcome,
  type OrchestrationChildReference,
  type OrchestrationJournalPort,
  type OrchestrationRunOwner,
  type OrchestrationRunRecord,
  type OrchestrationRunStorePort,
  type OrchestrationToolPort,
} from "./contract.js";
import type { OrchestrationDispatchContext } from "./dispatch-port.js";
import { OrchestrationDispatcher } from "./dispatcher.js";
import { OrchestrationRunStore } from "./runStore.js";
import { summarizeRun } from "./scheduler.js";
import { SubagentOrchestrationDispatchAdapter } from "./subagent-dispatch-adapter.js";
import { fitContentWithSuffix } from "../tool/executor/result-content-projection.js";
import {
  ORCHESTRATION_DEFAULT_MAX_CONCURRENCY,
  ORCHESTRATION_DEFAULT_TEAM,
  resolveOrchestrationMaxConcurrency,
  resolveOrchestrationTeam,
  resolveOrchestrationWritableRoles,
} from "./tool-policy.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const COMPLETION_NOTICE_MAX_BYTES = 12 * 1024;
const PROMPT_STATE_MAX_BYTES = 4 * 1024;
const PROMPT_STATE_MAX_ACTIVE_RUNS = 4;

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
  /** 会话配置可在运行中更新；只影响后续新建的 run，已在飞的 run 冻结自己的 team。 */
  private team: readonly string[] | undefined;
  private maxConcurrency: number | undefined;
  /**
   * 最近一次从 journal 读到的快照。prompt 装配是同步的，不能为了展示 run 状态
   * 阻塞在文件锁上；所有 store 调用都经过带缓存的端口，保证这里至多落后一次提交。
   */
  private readonly records = new Map<string, OrchestrationRunRecord>();

  constructor(private readonly options: OrchestrationServiceOptions) {
    this.team = options.team;
    this.maxConcurrency = options.maxConcurrency;
    this.store = new OrchestrationRunStore({
      owner: options.owner,
      journal: options.journal,
      ...(options.now ? { now: options.now } : {}),
    });
    this.dispatcher = new OrchestrationDispatcher({
      store: this.cachedStore(this.store),
      artifacts: new OrchestrationArtifacts({ storage: options.artifactStorage }),
      dispatch: new SubagentOrchestrationDispatchAdapter(options.subagents),
    });
  }

  get owner(): OrchestrationRunOwner {
    return this.store.owner;
  }

  /** 当前会话冻结的团队；UI 只读投影与后续 run 共用同一个解析结果。 */
  currentTeam(): readonly string[] {
    return this.team ?? ORCHESTRATION_DEFAULT_TEAM;
  }

  currentMaxConcurrency(): number {
    return this.maxConcurrency ?? ORCHESTRATION_DEFAULT_MAX_CONCURRENCY;
  }

  /**
   * 更新会话级配置。活动 run 的 journal 已冻结 team，这里不会回写它们；只影响
   * `preparePlan` 之后新建的 run。
   */
  updateConfiguration(input: { team?: readonly string[]; maxConcurrency?: number }): void {
    if (input.team !== undefined) this.team = input.team;
    if (input.maxConcurrency !== undefined) this.maxConcurrency = input.maxConcurrency;
  }

  /**
   * 时间线读取面：活动 run 在前，其余按 updatedAt 倒序，最多 `limit` 条。
   * 只返回内存缓存；未加载过的历史 run 不在这里伪造（冷恢复属于 Phase 6）。
   */
  listRuns(limit = 8): OrchestrationRunRecord[] {
    const bounded = Math.max(1, Math.min(limit, 8));
    const active = this.activeRuns();
    const activeIds = new Set(active.map((record) => record.runId));
    const terminal = [...this.records.values()]
      .filter((record) => !activeIds.has(record.runId))
      .sort((left, right) => right.state.updatedAt - left.state.updatedAt);
    return [...active, ...terminal].slice(0, bounded).map((record) => structuredClone(record));
  }

  /** 仍在驱动中的 run；顺序即启动顺序。 */
  activeRunIds(): readonly string[] {
    return [...this.executions.keys()];
  }

  activeRuns(): OrchestrationRunRecord[] {
    const active: OrchestrationRunRecord[] = [];
    for (const runId of this.executions.keys()) {
      const record = this.records.get(runId);
      if (record) active.push(structuredClone(record));
    }
    return active;
  }

  /**
   * 停止并重排的执行件：先持久化取消（generation 递增、已完成产物留在旧 journal），
   * 再显式停止 child。任一 run 停止失败都不能掩盖其他 run 的取消结果，因此汇总为
   * AggregateError 交给调用方记录；用户消息本身不会被这条错误吞掉。
   */
  async cancelActiveRuns(): Promise<OrchestrationRunRecord[]> {
    const runIds = [...this.executions.keys()];
    if (runIds.length === 0) return [];
    const results = await Promise.allSettled(runIds.map((runId) => this.dispatcher.cancel(runId)));
    const cancelled: OrchestrationRunRecord[] = [];
    const failures: unknown[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") cancelled.push(result.value);
      else failures.push(result.reason);
    }
    if (failures.length) {
      throw new AggregateError(failures, "Orchestration could not stop all active runs.");
    }
    return cancelled;
  }

  /**
   * 等待当前所有 run 收口。queue 语义用它决定何时把 held 输入提升为下一条 turn；
   * 循环是必要的：等待期间模型可能通过新的工具调用启动后继 run。
   */
  async whenIdle(): Promise<void> {
    while (this.executions.size > 0) {
      await Promise.allSettled(this.executions.values());
    }
  }

  /**
   * 编排主会话 prompt 的 run 事实。只包含 run 级摘要，不回传步骤产物；内容上限
   * 4 KiB，避免每次 context rebuild 把 journal 细节带进模型上下文。
   */
  promptState(): string | undefined {
    const active = this.activeRuns().slice(-PROMPT_STATE_MAX_ACTIVE_RUNS);
    const latestTerminal = this.latestTerminalRecord();
    if (active.length === 0 && latestTerminal === undefined) return undefined;

    const lines: string[] = [];
    if (active.length) {
      lines.push("Active runs:");
      for (const record of active) lines.push(`- ${describeRun(record)}`);
    } else {
      lines.push("No orchestration run is currently active.");
    }
    if (latestTerminal) {
      lines.push("Latest finished run:");
      lines.push(`- ${describeRun(latestTerminal)}`);
    }
    return boundPromptState(lines.join("\n"));
  }

  private latestTerminalRecord(): OrchestrationRunRecord | undefined {
    let latest: OrchestrationRunRecord | undefined;
    for (const record of this.records.values()) {
      if (!TERMINAL_RUN_STATUSES.has(record.status)) continue;
      if (latest === undefined || record.state.updatedAt > latest.state.updatedAt) {
        latest = record;
      }
    }
    return latest;
  }

  private remember(record: OrchestrationRunRecord | undefined): void {
    if (record) this.records.set(record.runId, structuredClone(record));
  }

  private cachedStore(store: OrchestrationRunStore): OrchestrationRunStorePort {
    const remember = (record: OrchestrationRunRecord | undefined) => this.remember(record);
    const refresh = async (runId: string) => remember(await store.get(runId));
    return {
      get owner() {
        return store.owner;
      },
      create: async (input) => {
        const record = await store.create(input);
        remember(record);
        return record;
      },
      get: async (runId) => {
        const record = await store.get(runId);
        remember(record);
        return record;
      },
      claim: async (runId) => {
        const claims = await store.claim(runId);
        await refresh(runId);
        return claims;
      },
      bindChild: async (runId: string, attemptKey: string, child: OrchestrationChildReference) => {
        const bound = await store.bindChild(runId, attemptKey, child);
        await refresh(runId);
        return bound;
      },
      finish: async (
        runId: string,
        attemptKey: string,
        generation: number,
        outcome: OrchestrationAttemptOutcome,
      ) => {
        const finished = await store.finish(runId, attemptKey, generation, outcome);
        await refresh(runId);
        return finished;
      },
      cancel: async (runId) => {
        const record = await store.cancel(runId);
        remember(record);
        return record;
      },
      recover: async (runId) => {
        const record = await store.recover(runId);
        remember(record);
        return record;
      },
    } satisfies OrchestrationRunStorePort;
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
    this.remember(previous);
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
    const record = await this.store.get(runId);
    this.remember(record);
    return record;
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
    const team = resolveOrchestrationTeam(input.team ?? this.team);
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
        input.maxConcurrency ?? this.maxConcurrency,
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

function describeRun(record: OrchestrationRunRecord): string {
  const summary = summarizeRun(record.state);
  return [
    `run \`${record.runId}\`, plan \`${record.state.plan.planId}\``,
    `revision ${record.state.plan.revision}, generation ${record.state.generation}`,
    `status ${record.status}`,
    `${summary.completed}/${summary.total} completed`,
    ...[
      summary.running ? `${summary.running} running` : "",
      summary.failed ? `${summary.failed} failed` : "",
      summary.blocked ? `${summary.blocked} blocked` : "",
      summary.cancelled ? `${summary.cancelled} cancelled` : "",
      summary.interrupted ? `${summary.interrupted} interrupted` : "",
    ].filter(Boolean),
  ].join(", ");
}

function boundPromptState(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= PROMPT_STATE_MAX_BYTES) return text;
  return fitContentWithSuffix(
    text,
    PROMPT_STATE_MAX_BYTES,
    "\n[... orchestration run state truncated ...]",
    "head",
  );
}
