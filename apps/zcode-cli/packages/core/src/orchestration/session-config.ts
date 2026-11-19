import { ORCHESTRATION_MAX_CONCURRENCY } from "@zcode/shared";

/** `runtime/orchestration` entry 的 payload；team 缺席表示沿用默认团队。 */
export interface StoredOrchestrationConfig {
  enabled: boolean;
  team?: string[];
  maxConcurrency?: number;
}

/**
 * 校验冷恢复读到的编排配置。
 *
 * entry 是配置的唯一持久事实源。损坏或版本未知时返回 undefined，让调用方 fail-closed
 * 回到经典模式：既不拿默认团队覆盖用户选择，也不把非法值塞进 runtime 配置。
 */
export function parseStoredOrchestrationConfig(
  value: unknown,
): StoredOrchestrationConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.enabled !== "boolean") return undefined;
  if (candidate.team !== undefined) {
    if (
      !Array.isArray(candidate.team) ||
      !candidate.team.every((role) => typeof role === "string")
    ) {
      return undefined;
    }
  }
  if (candidate.maxConcurrency !== undefined) {
    const value = candidate.maxConcurrency;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > ORCHESTRATION_MAX_CONCURRENCY
    ) {
      return undefined;
    }
  }
  return {
    enabled: candidate.enabled,
    ...(Array.isArray(candidate.team) ? { team: candidate.team as string[] } : {}),
    ...(typeof candidate.maxConcurrency === "number"
      ? { maxConcurrency: candidate.maxConcurrency }
      : {}),
  };
}
