import type { AppUsageSnapshot } from "@zcode/shared";

/**
 * App Usage 快照的 renderer 侧短期缓存。
 *
 * 设置页每次挂载都会重新请求 7d 与 all 两份快照；同一 renderer 生命周期内复用成功结果，
 * 关闭再打开设置页不再重走协议与 SQLite 聚合。它是渲染层加速，不是第二份事实源：
 * 超过 TTL 或点刷新即丢弃。缓存按 service 实例隔离（本地/远端 host 不串）。
 */
export interface AppUsageSnapshotCacheEntry {
  snapshot: AppUsageSnapshot | null;
  requestedAt: number;
  inFlight?: Promise<AppUsageSnapshot>;
}

export const APP_USAGE_SNAPSHOT_CACHE_TTL_MS = 30_000;
const APP_USAGE_SNAPSHOT_CACHE_MAX_ENTRIES = 8;
const appUsageSnapshotCacheByService = new WeakMap<
  object,
  Map<string, AppUsageSnapshotCacheEntry>
>();

export function getAppUsageSnapshotCache(service: object): Map<string, AppUsageSnapshotCacheEntry> {
  let cache = appUsageSnapshotCacheByService.get(service);
  if (!cache) {
    cache = new Map();
    appUsageSnapshotCacheByService.set(service, cache);
  }
  return cache;
}

export function setAppUsageSnapshotCacheEntry(
  cache: Map<string, AppUsageSnapshotCacheEntry>,
  key: string,
  entry: AppUsageSnapshotCacheEntry,
): void {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > APP_USAGE_SNAPSHOT_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}
