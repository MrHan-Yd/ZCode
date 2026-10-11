// 「彻底删除」的磁盘侧实现：按 sessionId 清理仅属于该会话的产物目录。
//
// 路径必须与写入方逐一对应，否则会删不掉或删错：
// - artifacts / image-cache / pdf-cache / video-cache / exec：create-app 用
//   `join(storageRoot, "cli", ...)` 建根，适配器再拼 `sanitizePathSegment(sessionId)`；
// - workflow 脚本目录：`join(storageRoot, "cli", "sessions", sessionId, "workflows")`
//   （见 script-workflow-tool-port，用裸 sessionId，不做归一化）；
// - 子代理产物：`join(cliStorageRoot, "agents", sessionId)`（见 create-app 的
//   subagentOutputRootDir）。
//
// 会话行与消息由 SessionStorePort.purgeSession 负责，本模块只碰文件产物。
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { sanitizePathSegment } from "@zcode/adapters";

/**
 * 进程级 storage root。
 *
 * 一次 CLI 进程只服务一套 config，storage root 因此是进程级事实；在这里登记一次，
 * 清理侧就不必重复解析 config（重复解析正是删除路径与写入路径分叉的来源）。
 */
let resolvedRoots: { storageRoot: string; cliStorageRoot: string } | null = null;

export function rememberSessionDataRoots(input: {
  storageRoot: string;
  cliStorageRoot: string;
}): void {
  resolvedRoots = input;
}

/** 该会话独占的产物目录（无论是否存在都返回；删除侧用 force 忽略缺失）。 */
export function listSessionDataDirs(sessionId: string): string[] {
  const roots = resolvedRoots;
  if (!roots) return [];
  const segment = sanitizePathSegment(sessionId);
  return [
    join(roots.storageRoot, "cli", "artifacts", segment),
    join(roots.storageRoot, "cli", "image-cache", segment),
    join(roots.storageRoot, "cli", "pdf-cache", segment),
    join(roots.storageRoot, "cli", "video-cache", segment),
    join(roots.storageRoot, "cli", "exec", segment),
    join(roots.storageRoot, "cli", "sessions", sessionId),
    join(roots.cliStorageRoot, "agents", sessionId),
  ];
}

/**
 * 删除该会话的产物目录。
 *
 * 根未登记时**显式失败**：静默返回等于「DB 行删了、产物一个没删」，上层会把这种
 * 半清理当成功报给用户。当前调用链不会走到这里（handler 要求会话常驻，常驻即意味着
 * create-app 跑过），所以抛错只会暴露接线断裂，不会误伤正常路径。
 *
 * 单个目录删除失败不阻断其它目录：这些只是产物，权限或占用问题不该把已经承诺的
 * 「删除会话」整体判失败（会话行删除才是不可回滚的主体，由 store 负责）。
 * 返回实际尝试删除的目录数，供调用方做诊断日志。
 */
export async function purgeSessionDataDirs(sessionId: string): Promise<number> {
  const dirs = listSessionDataDirs(sessionId);
  if (dirs.length === 0) {
    throw new Error("session data roots are not registered; refusing to report a partial purge");
  }
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)),
  );
  return dirs.length;
}
