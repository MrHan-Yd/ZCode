import { join, resolve } from "node:path";

const ZCODE_DATA_DIR_NAME = ".zcode";
const CLI_STORAGE_DIR_NAME = "cli";
const MEMORIES_DIR_NAME = "memories";
const PROJECTS_DIR_NAME = "projects";

export type ProjectMemoryRootId = "home" | "dataBaseDir";

export interface ProjectMemoryRootCandidate {
  rootId: ProjectMemoryRootId;
  /** `<根>/cli/memories/projects`，即 catalog 与运行时共同使用的那一层。 */
  path: string;
}

/**
 * Project Memory 的候选根。家目录的 `.zcode` 是"永远存在"的基线，自定义数据目录是覆盖层；
 * 桌面端把数据根搬走后，旧记忆会留在基线根里不再生效——本模块只负责把两个根算出来，
 * 供服务层探测"存在但不生效"的记忆（见 specs/memory-data-root-continuity.md）。
 *
 * 两个根解析到同一路径时只返回一个，避免出现"自己对自己"的差异提示。
 */
export function resolveCandidateProjectMemoryRoots(params: {
  homeDir: string;
  dataBaseDir: string;
}): ProjectMemoryRootCandidate[] {
  const homeRoot = resolve(params.homeDir);
  const dataBaseRoot = resolve(params.dataBaseDir);
  const candidates: ProjectMemoryRootCandidate[] = [
    { rootId: "home", path: resolveProjectMemoryPath(homeRoot) },
  ];

  if (homeRoot !== dataBaseRoot) {
    candidates.push({ rootId: "dataBaseDir", path: resolveProjectMemoryPath(dataBaseRoot) });
  }

  return candidates;
}

/** 除当前生效根之外、需要被探测的其它根。 */
export function resolveInactiveProjectMemoryRoots(params: {
  homeDir: string;
  dataBaseDir: string;
  activeRootPath: string;
}): ProjectMemoryRootCandidate[] {
  const activePath = normalizeForComparison(params.activeRootPath);
  return resolveCandidateProjectMemoryRoots(params).filter(
    (candidate) => normalizeForComparison(candidate.path) !== activePath,
  );
}

function resolveProjectMemoryPath(dataRoot: string): string {
  return join(
    dataRoot,
    ZCODE_DATA_DIR_NAME,
    CLI_STORAGE_DIR_NAME,
    MEMORIES_DIR_NAME,
    PROJECTS_DIR_NAME,
  );
}

function normalizeForComparison(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
