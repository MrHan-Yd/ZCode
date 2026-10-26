import {
  RewindScope,
  SessionEventType,
  parseCheckpointCreatedPayload,
  parseRewindTriggeredPayload,
  parseWorkspaceCheckpointArtifact,
  type DiffHunk,
  type MessageWithParts,
  type SessionEvent,
  type TurnFileChangeSummary,
  type TurnId,
} from "@zcode/contracts";
import type { V4ConversationFileChangesResult } from "@zcode/shared/zcode-protocol-v4";
import { applyPatch, structuredPatch, type StructuredPatch } from "diff";

interface FileChangeAggregate {
  afterContent?: string;
  beforeContent: string | null;
  fallbackAdditions: number;
  fallbackDeletions: number;
  patches: DiffHunk[];
  path: string;
  toolNames: Set<string>;
  writeCount: number;
}

interface WorkspaceCheckpointWithTurn {
  checkpoint: ReturnType<typeof parseCheckpointCreatedPayload>;
  turnId: string | null;
}

type ReadArtifact = (snapshotRef: string) => Promise<string>;

/**
 * 合并 before→after 的单一差分。
 *
 * `diff` 的 `timeout` / `maxEditLength` 命中时 **返回 `undefined`**（见 diff 的
 * `TimeoutOption` 文档），不是返回空 hunks。调用方必须把 undefined 当成「差分不可得」，
 * 退回逐次写入的 structuredPatch；吞成 `[]` 会让 `countPatchLines` 得到 0/0，
 * 等于对一个确实被改过的文件宣称「没有改动」——静默错值。大文件整段重写正是这个场景。
 */
type CreateConsolidatedPatch = (
  path: string,
  beforeContent: string,
  afterContent: string,
) => DiffHunk[] | undefined;

const CONSOLIDATED_PATCH_TIMEOUT_MS = 5_000;

function isSplitProductTurnId(turnId: string | null | undefined): boolean {
  return Boolean(turnId?.includes("~"));
}

function isWorkspaceCheckpoint(
  checkpoint: ReturnType<typeof parseCheckpointCreatedPayload>,
): boolean {
  return checkpoint.scope === RewindScope.Workspace || checkpoint.scope === RewindScope.Both;
}

function workspaceCheckpoints(events: readonly SessionEvent[]): WorkspaceCheckpointWithTurn[] {
  return events
    .filter((event) => event.type === SessionEventType.CheckpointCreated)
    .map((event) => ({
      checkpoint: parseCheckpointCreatedPayload(event.payload),
      turnId: event.turnId ? String(event.turnId) : null,
    }))
    .filter(({ checkpoint }) => isWorkspaceCheckpoint(checkpoint));
}

/**
 * 首帧只发尾窗 `snapshotTailWindowRows`（60）行；冷恢复只需要为可能出现在首帧的轮
 * 重建文件摘要。200 条消息在正常会话里远超 60 行（本仓库长会话样本约 1.9 行/消息）。
 * 漏算的尾部轮不会被静默丢弃：调用方把它们写进 `fileChangeSummaryUnavailableMessageIds`，
 * 客户端滚到时再按需回填。
 */
const COLD_FILE_CHANGE_TAIL_MESSAGE_LIMIT = 200;

export function selectColdFileChangeMessageIds(
  messages: readonly MessageWithParts[],
  tailMessageCount = COLD_FILE_CHANGE_TAIL_MESSAGE_LIMIT,
): string[] {
  if (tailMessageCount <= 0) return [];
  return messages.slice(-tailMessageCount).map((message) => String(message.info.id));
}

/** 会产生 file-change 摘要的 checkpoint 目标 messageId（去重，保持出现顺序）。 */
export function workspaceCheckpointMessageIds(events: readonly SessionEvent[]): string[] {
  const messageIds = new Set<string>();
  for (const entry of workspaceCheckpoints(events)) {
    messageIds.add(String(entry.checkpoint.targetMessageId ?? entry.checkpoint.messageId));
  }
  return [...messageIds];
}

function selectWorkspaceCheckpointsForFileSummary(
  events: readonly SessionEvent[],
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): WorkspaceCheckpointWithTurn[] {
  const messageIdSet = new Set(messageIds);
  const checkpoints = workspaceCheckpoints(events);
  const byMessageId = checkpoints.filter(({ checkpoint }) =>
    messageIdSet.has(String(checkpoint.targetMessageId ?? checkpoint.messageId)),
  );
  if (byMessageId.length > 0 || !targetTurnId || isSplitProductTurnId(String(targetTurnId))) {
    return byMessageId;
  }

  // 旧事件和缺失 user messageId 映射的普通 TurnStarted
  // 只能用事件 turnId 兜底。split product turn 带 "~q" 后缀，禁止按 runtime turnId
  // 合并，避免 queued/drained 场景串轮。
  return checkpoints.filter(({ turnId }) => turnId === String(targetTurnId));
}

function readModelCompleteFileChangesFallback(
  events: readonly SessionEvent[],
  targetTurnId?: TurnId | null,
): V4ConversationFileChangesResult | null {
  if (!targetTurnId || isSplitProductTurnId(String(targetTurnId))) {
    return null;
  }
  const event = [...events]
    .reverse()
    .find(
      (candidate) =>
        candidate.type === SessionEventType.ModelComplete &&
        String(candidate.turnId ?? "") === String(targetTurnId),
    );
  const fileChanges = (event?.payload as { fileChanges?: unknown } | undefined)?.fileChanges;
  if (typeof fileChanges !== "object" || fileChanges === null) {
    return null;
  }
  const rawItems = (fileChanges as { items?: unknown }).items;
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return null;
  }
  const items = rawItems
    .flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const record = item as Record<string, unknown>;
      if (typeof record.path !== "string" || record.path.length === 0) return [];
      return [
        {
          path: record.path,
          additions:
            typeof record.additions === "number" && record.additions > 0 ? record.additions : 0,
          deletions:
            typeof record.deletions === "number" && record.deletions > 0 ? record.deletions : 0,
          writeCount:
            typeof record.writeCount === "number" && record.writeCount > 0 ? record.writeCount : 1,
          toolNames: [] as string[],
          patches: [] as DiffHunk[],
        },
      ];
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  if (items.length === 0) return null;
  return {
    files: items.length,
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0),
    items,
  };
}

async function aggregateWorkspaceCheckpoints(
  checkpoints: readonly WorkspaceCheckpointWithTurn[],
  readArtifact: ReadArtifact,
  createConsolidatedPatch: CreateConsolidatedPatch = createFinalPatch,
  onConsolidatedPatchUnavailable?: (path: string) => void,
): Promise<V4ConversationFileChangesResult> {
  const byPath = new Map<string, FileChangeAggregate>();

  // checkpoint 顺序就是同一轮文件写入顺序，必须串行聚合 first-before → final-after。
  for (const { checkpoint } of checkpoints) {
    const artifact = parseWorkspaceCheckpointArtifact(
      JSON.parse(await readArtifact(checkpoint.snapshotRef)),
    );
    for (const file of artifact.files) {
      const fallback = countPatchLines(file.structuredPatch);
      const afterContent = resolveCheckpointAfterContent(file);
      const existing = byPath.get(file.path);
      if (!existing) {
        byPath.set(file.path, {
          afterContent,
          beforeContent: file.beforeContent,
          fallbackAdditions: fallback.additions,
          fallbackDeletions: fallback.deletions,
          patches: file.structuredPatch,
          path: file.path,
          toolNames: new Set([artifact.toolName]),
          writeCount: 1,
        });
        continue;
      }
      existing.afterContent = afterContent ?? existing.afterContent;
      existing.fallbackAdditions += fallback.additions;
      existing.fallbackDeletions += fallback.deletions;
      existing.patches.push(...file.structuredPatch);
      existing.toolNames.add(artifact.toolName);
      existing.writeCount += 1;
    }
  }

  const items = Array.from(byPath.values())
    .map((entry) => {
      const consolidated =
        entry.afterContent === undefined
          ? undefined
          : createConsolidatedPatch(entry.path, entry.beforeContent ?? "", entry.afterContent);
      if (entry.afterContent !== undefined && consolidated === undefined) {
        // 差分不可得（超时/超出编辑距离）。退回逐次写入的口径：宁可报逐次相加的行数，
        // 也不能报 0/0——那是在宣称这个文件没有改动。
        onConsolidatedPatchUnavailable?.(entry.path);
      }
      const patches = consolidated ?? entry.patches;
      const stat =
        consolidated === undefined
          ? {
              additions: entry.fallbackAdditions,
              deletions: entry.fallbackDeletions,
            }
          : countPatchLines(consolidated);
      return {
        path: entry.path,
        additions: stat.additions,
        deletions: stat.deletions,
        writeCount: entry.writeCount,
        toolNames: Array.from(entry.toolNames).sort(),
        patches,
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  return {
    files: items.length,
    additions: items.reduce((total, item) => total + item.additions, 0),
    deletions: items.reduce((total, item) => total + item.deletions, 0),
    items,
  };
}

export async function readConversationFileChangesFromEvents(input: {
  events: readonly SessionEvent[];
  messageIds: readonly string[];
  readArtifact: ReadArtifact;
  targetTurnId?: TurnId | null;
  /** 测试/闸门注入点：默认用带 timeout 的真实差分。 */
  createConsolidatedPatch?: CreateConsolidatedPatch;
  onConsolidatedPatchUnavailable?: (path: string) => void;
}): Promise<V4ConversationFileChangesResult> {
  const checkpoints = selectWorkspaceCheckpointsForFileSummary(
    input.events,
    input.messageIds,
    input.targetTurnId,
  );
  const result = await aggregateWorkspaceCheckpoints(
    checkpoints,
    input.readArtifact,
    input.createConsolidatedPatch,
    input.onConsolidatedPatchUnavailable,
  );
  const summary =
    result.items.length > 0
      ? result
      : (readModelCompleteFileChangesFallback(input.events, input.targetTurnId) ?? {
          files: 0,
          additions: 0,
          deletions: 0,
          items: [],
        });
  // 尾窗裁剪后，更早的轮在 hydrate 阶段没有 fileChanges，投影因此无法消费持久
  // RewindTriggered（它要求 turnHeader 已有 fileChanges 才改成 reverted）。按需读取
  // 必须把撤销状态一并返回；否则补种会把已撤销轮重新写成 active，重新打开撤销入口。
  return isFileSummaryReverted(input.events, input.messageIds, input.targetTurnId)
    ? { ...summary, state: "reverted" }
    : summary;
}

/**
 * 该轮是否执行过「按文件撤销」。
 *
 * 与 `ProductProjection` 消费 RewindTriggered 的口径一致：scope=workspace 且
 * reason=file_summary_rewind。匹配优先用 targetMessageId（checkpoint/轮身份都用 user
 * messageId）；model-only 轮可能没有可见 user 行，再用 runtime turnId 兜底。
 */
function isFileSummaryReverted(
  events: readonly SessionEvent[],
  messageIds: readonly string[],
  targetTurnId?: TurnId | null,
): boolean {
  const messageIdSet = new Set(messageIds.map(String));
  for (const event of events) {
    if (event.type !== SessionEventType.RewindTriggered) continue;
    let payload: ReturnType<typeof parseRewindTriggeredPayload>;
    try {
      payload = parseRewindTriggeredPayload(event.payload);
    } catch {
      // 单条非法 rewind 不能让整个按需读取失败；投影侧同样按无效事件跳过。
      continue;
    }
    if (payload.scope !== RewindScope.Workspace || payload.reason !== "file_summary_rewind") {
      continue;
    }
    if (payload.targetMessageId && messageIdSet.has(String(payload.targetMessageId))) {
      return true;
    }
    if (targetTurnId && event.turnId && String(event.turnId) === String(targetTurnId)) {
      return true;
    }
  }
  return false;
}

export async function buildColdFileChangeSummaries(input: {
  events: readonly SessionEvent[];
  messageIds: readonly string[];
  onArtifactError?: (messageId: string, error: unknown) => void;
  readArtifact: ReadArtifact;
  /** 测试/闸门注入点：默认用带 timeout 的真实差分。 */
  createConsolidatedPatch?: CreateConsolidatedPatch;
  onConsolidatedPatchUnavailable?: (messageId: string, path: string) => void;
}): Promise<ReadonlyMap<string, TurnFileChangeSummary>> {
  const durableMessageIds = new Set(input.messageIds);
  const checkpointsByMessageId = new Map<string, WorkspaceCheckpointWithTurn[]>();
  for (const entry of workspaceCheckpoints(input.events)) {
    const messageId = String(entry.checkpoint.targetMessageId ?? entry.checkpoint.messageId);
    if (!durableMessageIds.has(messageId)) continue;
    const entries = checkpointsByMessageId.get(messageId) ?? [];
    entries.push(entry);
    checkpointsByMessageId.set(messageId, entries);
  }

  const summaries = new Map<string, TurnFileChangeSummary>();
  const groups = [...checkpointsByMessageId.entries()];
  let cursor = 0;
  const workerCount = Math.min(8, groups.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < groups.length) {
        const group = groups[cursor];
        cursor += 1;
        if (!group) continue;
        const [messageId, checkpoints] = group;
        try {
          const result = await aggregateWorkspaceCheckpoints(
            checkpoints,
            input.readArtifact,
            input.createConsolidatedPatch,
            input.onConsolidatedPatchUnavailable
              ? (path) => input.onConsolidatedPatchUnavailable?.(messageId, path)
              : undefined,
          );
          if (result.items.length === 0) continue;
          summaries.set(messageId, {
            additions: result.additions,
            deletions: result.deletions,
            files: result.files,
            items: result.items.map((item) => ({
              additions: item.additions,
              deletions: item.deletions,
              path: item.path,
              toolNames: item.toolNames,
              writeCount: item.writeCount,
            })),
          });
        } catch (error) {
          input.onArtifactError?.(messageId, error);
        }
      }
    }),
  );
  return summaries;
}

function createFinalPatch(
  path: string,
  beforeContent: string,
  afterContent: string,
): DiffHunk[] | undefined {
  // 命中 timeout 时 structuredPatch 返回 undefined（diff 的 TimeoutOption）；
  // 这里必须原样透出，不能 `?? []` 把它变成「没有改动」。
  return structuredPatch(path, path, beforeContent, afterContent, undefined, undefined, {
    timeout: CONSOLIDATED_PATCH_TIMEOUT_MS,
  })?.hunks;
}

function resolveCheckpointAfterContent(
  file: ReturnType<typeof parseWorkspaceCheckpointArtifact>["files"][number],
): string | undefined {
  if (typeof file.afterContent === "string") return file.afterContent;
  if (!file.existedBefore && file.beforeContent === null && file.structuredPatch.length === 0) {
    return undefined;
  }
  const patch: StructuredPatch = {
    oldFileName: file.path,
    newFileName: file.path,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: file.structuredPatch,
  };
  const patched = applyPatch(file.beforeContent ?? "", patch, {
    autoConvertLineEndings: false,
    fuzzFactor: 0,
  });
  return typeof patched === "string" ? patched : undefined;
}

function countPatchLines(hunks: readonly DiffHunk[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.startsWith("+")) additions += 1;
      if (line.startsWith("-")) deletions += 1;
    }
  }
  return { additions, deletions };
}
