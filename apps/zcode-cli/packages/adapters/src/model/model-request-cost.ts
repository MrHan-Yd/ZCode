export function readModelRequestCostUsd(rawUsage: unknown): number | undefined {
  if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage)) return undefined;
  const record = rawUsage as Record<string, unknown>;
  const value = record.cost_usd ?? (record.currency === "USD" ? record.cost : undefined);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
