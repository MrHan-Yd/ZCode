import {
  SESSION_ENTRY_ORCHESTRATION,
  type SessionEntryInfo,
  type TraceContext,
} from "@zcode/contracts";
import { normalizeOrchestrationTeamSelection } from "@zcode/shared";
import type { OrchestrationConfigState } from "@zcode/shared/zcode-protocol-v4";
import type { V4ConversationOrchestrationStateResult } from "@zcode/shared/zcode-protocol-v4";
import type { SessionOrchestrationActivity } from "@zcode/shared/zcode-protocol-v4";
import type { AgentRuntimeInternal } from "../internal.js";
import { traceContextToLogContext } from "../deps.js";
import { rebuildContextPrefix } from "./context-refresh.js";
import { parseStoredOrchestrationConfig } from "../../orchestration/session-config.js";
import {
  isOrchestratorRuntimeConfig,
  resolveOrchestrationMaxConcurrency,
  resolveOrchestrationTeam,
  resolveOrchestrationTeamForPrompt,
} from "../../orchestration/tool-policy.js";
import {
  orchestrationConfigProjection,
  projectOrchestrationRuns,
} from "../../orchestration/projection.js";
import type { OrchestrationRunRecord } from "../../orchestration/contract.js";

export interface SetOrchestrationConfigInput {
  enabled: boolean;
  team?: readonly string[];
  maxConcurrency?: number;
}

/**
 * 编排配置的唯一应用入口。
 *
 * - 配置写入 `runtime.config.orchestration`，并持久化 `runtime/orchestration` entry；
 * - 开启时按需创建 service（存储缺失则保持缺席，工具调用返回 capability_unavailable）；
 * - 关闭时保留 service，让在飞 run 正常收口；只是不再注册规划工具；
 * - 团队变更只影响后续新 run，活动 run 的 journal 已冻结 team。
 */
export async function setOrchestrationConfig(
  this: AgentRuntimeInternal,
  input: SetOrchestrationConfigInput,
  traceContext?: TraceContext,
  options?: { persist?: boolean },
): Promise<OrchestrationConfigState> {
  const team = input.enabled
    ? resolveOrchestrationTeam(input.team)
    : input.team === undefined
      ? resolveOrchestrationTeamForPrompt(this.config.orchestration?.team)
      : resolveOrchestrationTeam(input.team);
  const maxConcurrency = resolveOrchestrationMaxConcurrency(
    input.maxConcurrency ?? this.config.orchestration?.maxConcurrency,
  );

  return await applyOrchestrationConfiguration(
    this,
    { enabled: input.enabled, team: [...team], maxConcurrency },
    traceContext,
    options?.persist !== false,
  );
}

/**
 * 配置应用本体：写内存配置、按需建 service、重注册工具面。
 *
 * 冷恢复与显式命令共用这一条路径，区别只在是否回写 session entry；
 * `persist=false` 避免 resume 时把同值 entry 的 updated 时间刷成「刚刚」。
 */
async function applyOrchestrationConfiguration(
  runtime: AgentRuntimeInternal,
  config: OrchestrationConfigState,
  traceContext: TraceContext | undefined,
  persist: boolean,
): Promise<OrchestrationConfigState> {
  const { enabled, team, maxConcurrency } = config;
  if (persist) {
    await persistOrchestrationConfig(runtime, { enabled, team, maxConcurrency });
  }

  runtime.config.orchestration = {
    enabled,
    team,
    maxConcurrency,
  };
  if (enabled) {
    const service = runtime.ensureOrchestrationService?.() ?? runtime.orchestrationService;
    service?.updateConfiguration({ team, maxConcurrency });
  } else {
    runtime.orchestrationService?.updateConfiguration({ team, maxConcurrency });
  }
  // 注册面与执行白名单都读 `config.orchestration`；工具缓存也必须失效，否则本轮仍供旧表。
  runtime.refreshBuiltInTools?.();
  runtime.invalidateToolCache();
  if (!runtime.activeTurn) rebuildContextPrefix(runtime);
  runtime.logger?.info?.("Session orchestration configuration updated", {
    enabled,
    event: "session.orchestration.updated",
    maxConcurrency,
    module: "core.runtime",
    sessionId: String(runtime.sessionId),
    teamSize: team.length,
    traceId: (traceContext ?? runtime.rootTraceContext).traceId,
  });
  return orchestrationConfigProjection({ enabled, team, maxConcurrency });
}

export interface RestoreOrchestrationResult {
  enabled: boolean;
  records: number;
  interrupted: number;
  invalidRecords: number;
}

/**
 * 冷恢复：从 `runtime/orchestration` entry 还原会话配置，并把 journal 里的 run 读回投影。
 *
 * entry 缺席 = 经典会话，什么都不做；entry 损坏 = fail-closed 回经典并落警告，
 * 不覆盖用户原值。只有配置开启时才需要 run journal；已完成步骤保持完成，
 * 有在飞 attempt 的 run 标记 interrupted 并暂停，等待用户 amend。
 */
export async function restoreOrchestrationFromSession(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<RestoreOrchestrationResult> {
  const empty: RestoreOrchestrationResult = {
    enabled: false,
    records: 0,
    interrupted: 0,
    invalidRecords: 0,
  };
  if (!this.sessionStore?.sessionEntries) return empty;

  let data: unknown;
  try {
    const entries = await this.sessionStore.sessionEntries({
      sessionID: this.sessionId,
      type: SESSION_ENTRY_ORCHESTRATION,
    });
    data = entries.at(-1)?.data;
  } catch (error) {
    this.logger?.warn("Session orchestration entry restore failed", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session.orchestration.restore_read_failed",
      module: "core.runtime",
      sessionId: String(this.sessionId),
      status: "failed",
    });
    return empty;
  }
  if (data === undefined) return empty;

  const stored = parseStoredOrchestrationConfig(data);
  if (!stored) {
    this.logger?.warn("Session orchestration entry is invalid; falling back to classic mode", {
      ...traceContextToLogContext(traceContext),
      event: "session.orchestration.restore_invalid_entry",
      module: "core.runtime",
      sessionId: String(this.sessionId),
    });
    return empty;
  }

  try {
    await applyOrchestrationConfiguration(
      this,
      {
        enabled: stored.enabled,
        // 旧 entry 可能没有 Explore；补齐默认通用角色，同时保留专业选择，不回写历史。
        team:
          stored.team && stored.team.length > 0
            ? normalizeOrchestrationTeamSelection(stored.team)
            : [...resolveOrchestrationTeamForPrompt(undefined)],
        maxConcurrency: resolveOrchestrationMaxConcurrency(stored.maxConcurrency),
      },
      traceContext,
      false,
    );
  } catch (error) {
    this.logger?.warn("Session orchestration entry could not be applied", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "session.orchestration.restore_apply_failed",
      module: "core.runtime",
      sessionId: String(this.sessionId),
    });
    return empty;
  }

  if (!stored.enabled) return { ...empty, enabled: false };
  const service = this.orchestrationService;
  if (!service) {
    // 存储端口缺席时工具面仍按配置注册，冷恢复不伪造历史 run。
    return { ...empty, enabled: true };
  }

  const report = await service.restore();
  if (report.invalidRecords > 0) {
    this.logger?.warn("Orchestration journal contains unreadable run records", {
      ...traceContextToLogContext(traceContext),
      event: "session.orchestration.restore_invalid_records",
      invalidRecords: report.invalidRecords,
      module: "core.runtime",
      sessionId: String(this.sessionId),
    });
  }
  if (report.records > 0) {
    this.logger?.info("Session orchestration runs restored", {
      ...traceContextToLogContext(traceContext),
      event: "session.orchestration.restored",
      interruptedRuns: report.interrupted,
      module: "core.runtime",
      restoredRuns: report.records,
      sessionId: String(this.sessionId),
    });
  }
  return {
    enabled: true,
    records: report.records,
    interrupted: report.interrupted,
    invalidRecords: report.invalidRecords,
  };
}

export function getOrchestrationState(
  this: AgentRuntimeInternal,
): V4ConversationOrchestrationStateResult {
  const enabled = isOrchestratorRuntimeConfig(this.config);
  const service = this.orchestrationService;
  const team =
    service?.currentTeam() ?? resolveOrchestrationTeamForPrompt(this.config.orchestration?.team);
  const maxConcurrency =
    service?.currentMaxConcurrency() ??
    resolveOrchestrationMaxConcurrency(this.config.orchestration?.maxConcurrency);
  const runs: OrchestrationRunRecord[] = service?.listRuns(8) ?? [];
  return {
    config: orchestrationConfigProjection({ enabled, team, maxConcurrency }),
    runs: projectOrchestrationRuns({
      runs,
      activeRunIds: new Set(service?.activeRunIds() ?? []),
    }),
  };
}

/**
 * sessions-index 用的活动摘要；与 `getOrchestrationState` 分开是因为后者会克隆 run 记录，
 * 而会话事件 fan-out 的频率不允许每次发布都付这份成本。
 */
export function getOrchestrationActivity(
  this: AgentRuntimeInternal,
): SessionOrchestrationActivity | null {
  return this.orchestrationService?.activitySummary() ?? null;
}

/** 时间线停止按钮：只取消指定 run；不会停止主会话 turn 或其他后台任务。 */
export async function cancelOrchestrationRun(
  this: AgentRuntimeInternal,
  runId: string,
): Promise<OrchestrationRunRecord | undefined> {
  const service = this.orchestrationService;
  if (!service) return undefined;
  return await service.cancel(runId);
}

async function persistOrchestrationConfig(
  runtime: AgentRuntimeInternal,
  config: OrchestrationConfigState,
): Promise<void> {
  if (!runtime.sessionPersisted || !runtime.sessionStore?.saveSessionEntry) return;
  const timestamp = Date.now();
  const entry: SessionEntryInfo = {
    id: `${runtime.sessionId}:runtime-orchestration`,
    sessionID: runtime.sessionId,
    type: SESSION_ENTRY_ORCHESTRATION,
    touchSession: false,
    time: { created: timestamp, updated: timestamp },
    data: {
      enabled: config.enabled,
      team: [...config.team],
      maxConcurrency: config.maxConcurrency,
    },
  };
  await runtime.sessionStore.saveSessionEntry(entry);
}
