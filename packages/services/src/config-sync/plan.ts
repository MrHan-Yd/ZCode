import type {
  ConfigSyncDownloadPlan,
  ConfigSyncItem,
  ConfigSyncManifest,
  ConfigSyncPlanEntry,
  ConfigSyncPlanEntryKind,
  ConfigSyncSkippedRemoteFile,
} from "./types.js";

/**
 * 「下载会发生什么」的纯计算：本地与远端的 diff、以及按策略解析出真正要写的集合。
 * 与功能无关，因此子智能体与 MCP 共用同一套计划语义。
 */

export function buildPlan(params: {
  readonly localItems: readonly ConfigSyncItem[];
  readonly remoteItems: readonly ConfigSyncItem[];
  readonly localFingerprint: string;
  readonly manifest: ConfigSyncManifest;
  readonly gistId: string;
  readonly gistUrl: string;
  readonly skipped: readonly ConfigSyncSkippedRemoteFile[];
  readonly lastLocalFingerprint?: string;
}): ConfigSyncDownloadPlan {
  const localByName = new Map(params.localItems.map((item) => [item.name, item]));
  const remoteByName = new Map(params.remoteItems.map((item) => [item.name, item]));
  const names = [...new Set([...localByName.keys(), ...remoteByName.keys()])].sort();
  const entries: ConfigSyncPlanEntry[] = names.map((name) => {
    const local = localByName.get(name);
    const remote = remoteByName.get(name);
    if (remote && local) {
      return { name, kind: remote.content === local.content ? "same" : "update" };
    }
    if (remote) return { name, kind: "add" };
    return { name, kind: "localOnly" };
  });

  return {
    status: "ok",
    remoteRevision: params.manifest.revision,
    remoteUpdatedAt: params.manifest.updatedAt,
    gistIdShort: params.gistId.slice(0, 8),
    gistUrl: params.gistUrl,
    entries,
    localChangedSinceLastSync:
      params.lastLocalFingerprint !== undefined &&
      params.lastLocalFingerprint !== params.localFingerprint,
    remoteSkipped: params.skipped,
  };
}

/**
 * 计划 → 实际写盘集合。
 * `merge` 只覆盖远端存在的同名条目、保留本地独有项；`replace` 镜像远端并删除本地独有项。
 */
export function resolveApplySet(params: {
  readonly entries: readonly ConfigSyncPlanEntry[];
  readonly remoteItems: readonly ConfigSyncItem[];
  readonly strategy: "merge" | "replace";
}): {
  readonly writes: readonly ConfigSyncItem[];
  readonly added: number;
  readonly updated: number;
  readonly removals: readonly string[];
  readonly kept: number;
} {
  const remoteByName = new Map(params.remoteItems.map((item) => [item.name, item]));
  const writes = params.entries.flatMap((entry) => {
    if (entry.kind !== "add" && entry.kind !== "update") return [];
    const remote = remoteByName.get(entry.name);
    return remote ? [remote] : [];
  });
  const localOnly = params.entries.filter((entry) => entry.kind === "localOnly");
  return {
    writes,
    added: params.entries.filter((entry) => entry.kind === "add").length,
    updated: params.entries.filter((entry) => entry.kind === "update").length,
    removals: params.strategy === "replace" ? localOnly.map((entry) => entry.name) : [],
    // replace 下本地独有项是被删除的，不能算作「保留」。
    kept: params.strategy === "replace" ? 0 : localOnly.length,
  };
}

export function countPlanEntries(
  entries: readonly ConfigSyncPlanEntry[],
): Record<ConfigSyncPlanEntryKind, number> {
  return {
    add: entries.filter((entry) => entry.kind === "add").length,
    update: entries.filter((entry) => entry.kind === "update").length,
    same: entries.filter((entry) => entry.kind === "same").length,
    localOnly: entries.filter((entry) => entry.kind === "localOnly").length,
  };
}
