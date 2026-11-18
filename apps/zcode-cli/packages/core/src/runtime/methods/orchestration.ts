import {
  SESSION_ENTRY_ORCHESTRATION,
  type SessionEntryInfo,
  type TraceContext,
} from "@zcode/contracts";
import type { OrchestrationConfigState } from "@zcode/shared/zcode-protocol-v4";
import type {
  V4ConversationOrchestrationStateResult,
} from "@zcode/shared/zcode-protocol-v4";
import type { AgentRuntimeInternal } from "../internal.js";
import { rebuildContextPrefix } from "./context-refresh.js";
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
): Promise<OrchestrationConfigState> {
  const team = input.enabled
    ? resolveOrchestrationTeam(input.team)
    : input.team === undefined
      ? resolveOrchestrationTeamForPrompt(this.config.orchestration?.team)
      : resolveOrchestrationTeam(input.team);
  const maxConcurrency = resolveOrchestrationMaxConcurrency(
    input.maxConcurrency ?? this.config.orchestration?.maxConcurrency,
  );

  await persistOrchestrationConfig(this, {
    enabled: input.enabled,
    team: [...team],
    maxConcurrency,
  });

  this.config.orchestration = {
    enabled: input.enabled,
    team,
    maxConcurrency,
  };
  if (input.enabled) {
    const service = this.ensureOrchestrationService?.() ?? this.orchestrationService;
    service?.updateConfiguration({ team, maxConcurrency });
  } else {
    this.orchestrationService?.updateConfiguration({ team, maxConcurrency });
  }
  // 注册面与执行白名单都读 `config.orchestration`；工具缓存也必须失效，否则本轮仍供旧表。
  this.refreshBuiltInTools?.();
  this.invalidateToolCache();
  if (!this.activeTurn) rebuildContextPrefix(this);
  this.logger?.info?.("Session orchestration configuration updated", {
    enabled: input.enabled,
    event: "session.orchestration.updated",
    maxConcurrency,
    module: "core.runtime",
    sessionId: String(this.sessionId),
    teamSize: team.length,
    traceId: (traceContext ?? this.rootTraceContext).traceId,
  });
  return orchestrationConfigProjection({ enabled: input.enabled, team, maxConcurrency });
}

export function getOrchestrationState(
  this: AgentRuntimeInternal,
): V4ConversationOrchestrationStateResult {
  const enabled = isOrchestratorRuntimeConfig(this.config);
  const service = this.orchestrationService;
  const team = service?.currentTeam() ?? resolveOrchestrationTeamForPrompt(this.config.orchestration?.team);
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
    data: { enabled: config.enabled, team: [...config.team], maxConcurrency: config.maxConcurrency },
  };
  await runtime.sessionStore.saveSessionEntry(entry);
}
