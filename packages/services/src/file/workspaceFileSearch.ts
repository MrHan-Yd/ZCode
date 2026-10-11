import { setImmediate } from "node:timers/promises";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { unpackWorkspaceFileEntries } from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type WorkspaceFileSearchCandidate,
} from "@zcode/shared/workspaceFileSearch";

/** 分批大小：单批打分保持短任务，批次之间让出事件循环。 */
const HOST_FILE_SEARCH_CHUNK_SIZE = 2048;

function toWorkspaceFileEntry(candidate: WorkspaceFileSearchCandidate): WorkspaceFileEntry {
  return {
    name: candidate.name,
    path: candidate.path,
    relativePath: candidate.relativePath,
    type: candidate.type,
  };
}

/**
 * 空 query 的默认预览顺序：文件优先、再目录，各自保持索引顺序
 * （与 shared 的 sortDefaultWorkspaceFileSearchCandidates 语义一致）。
 *
 * 索引本身已按「目录优先 + 路径」排好序，即所有文件是连续的一段；因此只需扫到前 `limit` 个文件、
 * 不足时再补目录，无需对全部候选做三趟 map+sort+map。大仓库打开 @ 面板时省掉一次全量排序。
 */
function collectDefaultWorkspaceFilePreview(
  candidates: readonly WorkspaceFileSearchCandidate[],
  limit: number,
): WorkspaceFileSearchCandidate[] {
  const preview: WorkspaceFileSearchCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.type === "directory") continue;
    preview.push(candidate);
    if (preview.length >= limit) return preview;
  }
  for (const candidate of candidates) {
    if (candidate.type !== "directory") continue;
    preview.push(candidate);
    if (preview.length >= limit) break;
  }
  return preview;
}

/** 分批解码已有 packed 索引，防止把 Renderer 的长任务简单搬到共享 Host。 */
export async function buildHostFileSearchCandidates(packed: string, rootPath: string) {
  const candidates: WorkspaceFileSearchCandidate[] = [];
  for (let offset = 0; offset < packed.length; ) {
    const newline = packed.indexOf("\n", offset + 128_000);
    const end = newline < 0 ? packed.length : newline + 1;
    const entries = unpackWorkspaceFileEntries(packed.slice(offset, end), rootPath);
    for (const candidate of mapWorkspaceFileEntriesToSearchCandidates(entries))
      candidates.push(candidate);
    offset = end;
    await setImmediate();
  }
  return candidates;
}

export async function searchHostFileCandidates(
  candidates: WorkspaceFileSearchCandidate[],
  query: string,
  limit: number,
  options: { shouldAbort?: () => boolean } = {},
): Promise<WorkspaceFileEntry[]> {
  if (!query.trim()) {
    return collectDefaultWorkspaceFilePreview(candidates, limit).map(toWorkspaceFileEntry);
  }

  let best: WorkspaceFileSearchCandidate[] = [];
  // top-K 的输入按原索引顺序分批；同分时原序稳定，分批合并与整表排序一致。
  for (let offset = 0; offset < candidates.length; offset += HOST_FILE_SEARCH_CHUNK_SIZE) {
    best = filterWorkspaceFileSearchCandidates(
      [...best, ...candidates.slice(offset, offset + HOST_FILE_SEARCH_CHUNK_SIZE)],
      query,
      { limit },
    );
    await setImmediate();
    // 被更新查询取代后提前退出：调用方（renderer）按 query 身份丢弃过期响应，
    // 因此返回部分结果安全；快速输入时不必让旧查询把 Host CPU 跑满。
    if (options.shouldAbort?.()) break;
  }
  return best.map(toWorkspaceFileEntry);
}
