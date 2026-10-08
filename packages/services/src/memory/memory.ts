import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export const PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE =
  "PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED";
export const PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE = "PROJECT_MEMORY_FILE_CHANGED";

export interface ProjectMemoryFileSummary {
  name: string;
  /** 已由 MemoryService 校验并限制在本地 Project Memory 根目录内的实际路径。 */
  path: string;
  kind: "index" | "item";
  size: number;
  updatedAt: number;
}

export interface ProjectMemoryWorkspaceSummary {
  id: string;
  label: string;
  updatedAt: number;
  files: ProjectMemoryFileSummary[];
}

/**
 * 存在记忆、但当前不生效的其它数据根摘要。数据目录从家目录搬走后，旧记忆会留在原根里，
 * 既不进目录列表也不参与注入；这条摘要用于把该情况告诉用户
 * （见 specs/memory-data-root-continuity.md）。
 */
export interface ProjectMemoryInactiveRootSummary {
  rootId: "home" | "dataBaseDir";
  path: string;
  workspaceCount: number;
  fileCount: number;
}

/** 当前生效根与"存在记忆但不生效"的其它根；供 UI 提示使用。 */
export interface ProjectMemoryRootsDescription {
  activeRootPath: string;
  inactiveRoots: ProjectMemoryInactiveRootSummary[];
}

export interface IMemoryService {
  /** 列出当前本地 profile 中可查看的 Project Memory。 */
  listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]>;

  /**
   * 描述 Project Memory 的根分布：当前生效根 + 其它存在记忆但不生效的根。
   * 只做只读探测：不参与列表展示，也不影响会话注入。
   */
  describeProjectMemoryRoots(): Promise<ProjectMemoryRootsDescription>;

  /** 原样读取一个 Project Memory Markdown 文件。 */
  readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{ content: string; updatedAt: number }>;

  /**
   * 删除一条 Project Memory 文件，并清理 `MEMORY.md` 中指回它的索引行。
   * 索引每轮注入上下文，残留的失效指针会误导模型，因此清理属于本动作的一部分而非可选项。
   */
  deleteProjectMemoryFile(params: { workspaceId: string; fileName: string }): Promise<void>;
}

export const IMemoryService = createServiceDescriptor<IMemoryService>(ServiceChannels.Memory);
