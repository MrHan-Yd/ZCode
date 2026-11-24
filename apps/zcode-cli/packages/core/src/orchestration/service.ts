import { randomUUID } from "node:crypto";
import type { SubagentPort, TraceContext } from "@zcode/contracts";
import {
  parseOrchestrationPlan,
  validateOrchestrationPlan,
  type OrchestrationPlan,
} from "@zcode/shared";
import { OrchestrationArtifacts } from "./artifacts.js";
import {
  buildOrchestrationCompletionNotice,
  buildOrchestrationFailureNotice,
} from "./serviceNotice.js";
import {
  OrchestrationStoreError,
  type OrchestrationArtifactStoragePort,
  type OrchestrationAttemptOutcome,
  type OrchestrationAttemptRecord,
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
import { boundOrchestrationPromptState, describeOrchestrationRun } from "./servicePromptState.js";
import { SubagentOrchestrationDispatchAdapter } from "./subagent-dispatch-adapter.js";
import {
  ORCHESTRATION_DEFAULT_MAX_CONCURRENCY,
  resolveOrchestrationMaxConcurrency,
  resolveOrchestrationTeam,
  resolveOrchestrationWritableRoles,
} from "./tool-policy.js";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** `activitySummary()` 的产出；与 shared 的 `SessionOrchestrationActivity` 结构一致。 */
export interface OrchestrationActivitySummary {
  activeRunCount: number;
  runningStepCount: number;
  completedStepCount: number;
  totalStepCount: number;
  startedAt: number;
}

function isLiveAttempt(attempt: OrchestrationAttemptRecord): boolean {
  return attempt.status === "claimed" || attempt.status === "running";
}

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

/** 冷恢复结果：只报告事实，日志由 runtime 决定落点。 */
export interface OrchestrationRestoreReport {
  /** 从 journal 读出的有效 run 数（已截断到实现的恢复上限）。 */
  records: number;
  /** 因缺少 terminal 证据被标记 interrupted 的 run 数。 */
  interrupted: number;
  /** 读取失败（损坏 / 版本未知 / owner 不匹配）的 run 快照数；原文件保留。 */
  invalidRecords: number;
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
  /** 已接纳但尚未返回的 start/amend/cancel；whenIdle 不能在这些空窗里误报空闲。 */
  private readonly mutations = new Set<Promise<unknown>>();
  /** 会话配置可在运行中更新；只影响后续新建的 run，已在飞的 run 冻结自己的 team。 */
  private team: readonly string[] | undefined;
  private maxConcurrency: number | undefined;
  /**
   * 最近一次从 journal 读到的快照。prompt 装配是同步的，不能为了展示 run 状态
   * 阻塞在文件锁上；所有 store 调用都经过带缓存的端口，保证这里至多落后一次提交。
   */
  private readonly records = new Map<string, OrchestrationRunRecord>();
  /** 冷恢复只做一次；并发调用共享同一个 Promise。 */
  private restorePromise?: Promise<OrchestrationRestoreReport>;

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
    return resolveOrchestrationTeam(this.team);
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
   * sessions-index 用的轻量活动摘要。
   *
   * 不能复用 `listRuns()`：它会对最多 8 条记录做 structuredClone，而 sessions-index
   * 在每次会话事件 fan-out 时都要读一次活动事实——流式事件下这会把克隆成本放大到每条事件。
   * 这里只读内存记录里的步数状态，不复制记录本身。
   */
  activitySummary(): OrchestrationActivitySummary | null {
    let activeRunCount = 0;
    let runningStepCount = 0;
    let completedStepCount = 0;
    let totalStepCount = 0;
    let startedAt = Number.POSITIVE_INFINITY;
    for (const runId of this.executions.keys()) {
      const record = this.records.get(runId);
      if (!record) continue;
      activeRunCount += 1;
      startedAt = Math.min(startedAt, record.state.startedAt);
      for (const step of record.state.plan.steps) {
        const state = record.state.steps[step.stepId];
        totalStepCount += 1;
        if (state?.status === "running") runningStepCount += 1;
        else if (state?.status === "completed") completedStepCount += 1;
      }
    }
    if (activeRunCount === 0) return null;
    return {
      activeRunCount,
      runningStepCount,
      completedStepCount,
      totalStepCount,
      startedAt,
    };
  }

  /**
   * 冷恢复：把 journal 里的历史 run 读回只读投影，并把「有在飞 attempt 却没有 terminal
   * 证据」的 run 标记为 interrupted。
   *
   * 只由持有父 session owner/lease 的 runtime 在 resume 时调用。已完成的 run 保持原状；
   * 未领取的 pending 步骤保留 pending，不猜测成功也不自动重放写入。重复调用复用同一次
   * 读取结果，避免 UI 轮询把文件 IO 放大。
   */
  restore(): Promise<OrchestrationRestoreReport> {
    this.restorePromise ??= this.performRestore().catch((error: unknown) => {
      // 恢复失败不能永久污染 promise：下一次显式调用仍有机会重试。
      this.restorePromise = undefined;
      throw error;
    });
    return this.restorePromise;
  }

  private async performRestore(): Promise<OrchestrationRestoreReport> {
    const listing = (await this.options.journal.list?.()) ?? {
      records: [],
      invalidRecords: 0,
    };
    let interrupted = 0;
    for (const record of listing.records) {
      this.remember(record);
      // 只有存在 claimed/running attempt 的 run 才需要收口；正常终态 replay 不会触发写。
      if (!record.attempts.some(isLiveAttempt)) continue;
      const recovered = await this.store.recover(record.runId);
      this.remember(recovered);
      interrupted += 1;
    }
    return {
      records: listing.records.length,
      interrupted,
      invalidRecords: listing.invalidRecords,
    };
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
    while (this.executions.size > 0 || this.mutations.size > 0) {
      await Promise.allSettled([...this.executions.values(), ...this.mutations]);
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
      for (const record of active) lines.push(`- ${describeOrchestrationRun(record)}`);
    } else {
      lines.push("No orchestration run is currently active.");
    }
    if (latestTerminal) {
      lines.push("Latest finished run:");
      lines.push(`- ${describeOrchestrationRun(latestTerminal)}`);
    }
    return boundOrchestrationPromptState(lines.join("\n"));
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
      revise: async (input) => {
        const result = await store.revise(input);
        remember(result.record);
        return result;
      },
      confirmAttemptQuiesced: async (runId: string, attemptKey: string) => {
        const confirmed = await store.confirmAttemptQuiesced(runId, attemptKey);
        await refresh(runId);
        return confirmed;
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
    return this.track(async () => {
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
    });
  }

  /**
   * 同一 run 的原地修订：保留未变步骤的 child / 产物，只取消被删除或执行语义改变的
   * 在飞 attempt。dispatcher 在返回前完成旧 child 收口并持久化 attempt_quiesced，
   * 因此 service 不建立第二个 run，也不伪造“旧 run 已取消”的完成通知。
   */
  async amend(input: AmendOrchestrationRunInput): Promise<OrchestrationRunRecord> {
    return this.track(async () => {
      const previous = await this.store.get(input.runId);
      if (!previous) {
        throw new OrchestrationStoreError("not_found", "Orchestration run was not found.");
      }
      this.remember(previous);
      const requested = this.preparePlan(input);
      if (requested.plan.planId !== previous.state.plan.planId) {
        throw new OrchestrationStoreError("invalid_plan", "An amendment must keep the planId.");
      }
      const duplicate = requested.plan.revision === previous.state.plan.revision;
      const expectedRevision = duplicate
        ? previous.state.plan.revision - 1
        : previous.state.plan.revision;
      const revision = duplicate ? previous.state.plan.revision : previous.state.plan.revision + 1;
      const result = await this.dispatcher.revise({
        runId: previous.runId,
        expectedRevision,
        plan: { ...requested.plan, revision },
      });
      this.remember(result.record);
      if (!this.executions.has(previous.runId)) this.launch(previous.runId, input.context);
      return result.record;
    });
  }

  async cancel(runId: string): Promise<OrchestrationRunRecord> {
    return this.track(() => this.dispatcher.cancel(runId));
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
        if (this.executions.get(runId) === execution) this.executions.delete(runId);
      });
    this.executions.set(runId, execution);
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const promise = operation();
    this.mutations.add(promise);
    void promise.then(
      () => this.mutations.delete(promise),
      () => this.mutations.delete(promise),
    );
    return promise;
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

export {
  buildOrchestrationCompletionNotice,
  buildOrchestrationFailureNotice,
} from "./serviceNotice.js";

function formatZodIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.map(String).join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
