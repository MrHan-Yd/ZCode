import {
  type IMemoryService,
  type ProjectMemoryFileSummary,
  type ProjectMemoryInactiveRootSummary,
  type ProjectMemoryRootsDescription,
  type ProjectMemoryWorkspaceSummary,
} from "./memory.js";
import { lstat, readdir, readFile, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import { stripMemoryIndexEntries } from "#src/memory/index-entries.js";
import { readProjectMemoryFileFromStableHandle } from "#src/memory/projectMemoryStableRead.js";
import { resolveInactiveProjectMemoryRoots } from "#src/memory/roots.js";
import { getDataBaseDir, getZCodeDataRootDir } from "#src/paths.js";

const PROJECT_MEMORY_INDEX_FILE_NAME = "MEMORY.md";
const PROJECT_MEMORY_DIRECTORY_NAME = "memory";
const PROJECT_KEY_SUFFIX_PATTERN = /^(.*)-[a-f0-9]{16}$/i;

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function getProjectMemoriesRoot(): string {
  return join(getZCodeDataRootDir(), "cli", "memories", "projects");
}

function isValidPathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    basename(value) === value &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function isProjectMemoryFileName(fileName: string): boolean {
  return (
    fileName === PROJECT_MEMORY_INDEX_FILE_NAME ||
    (fileName.endsWith(".md") && fileName !== PROJECT_MEMORY_INDEX_FILE_NAME)
  );
}

function resolveWorkspaceLabel(workspaceId: string): string {
  const slug = PROJECT_KEY_SUFFIX_PATTERN.exec(workspaceId)?.[1];
  return slug?.trim() || workspaceId;
}

async function isPlainDirectory(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    return metadata.isDirectory() && !metadata.isSymbolicLink();
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function requirePlainDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Project Memory directory is not a regular directory: ${path}`);
  }
}

async function requireProjectMemoriesRoot(): Promise<string> {
  const projectsRoot = getProjectMemoriesRoot();
  // 只校验 workspace 子目录时，projectsRoot symlink 会让 list/read 跟随到本地数据目录外。
  await requirePlainDirectory(projectsRoot);
  return projectsRoot;
}

async function requireExactProjectMemoryFile(
  memoryRoot: string,
  fileName: string,
): Promise<string> {
  const memoryEntries = await readdir(memoryRoot, { withFileTypes: true });
  const fileEntry = memoryEntries.find((entry) => entry.name === fileName);
  const requestedFilePath = join(memoryRoot, fileName);
  if (!fileEntry) {
    // 文件确实不存在时继续透传原始 ENOENT；只有大小写别名能命中时才拒绝读取。
    await lstat(requestedFilePath);
    throw new Error(`Project Memory file name does not match exactly: ${fileName}`);
  }
  if (!fileEntry.isFile() || fileEntry.isSymbolicLink()) {
    throw new Error(`Project Memory file is not a regular file: ${fileName}`);
  }
  return requestedFilePath;
}

async function assertContainedProjectMemoryPath(
  projectsRoot: string,
  targetPath: string,
): Promise<void> {
  const projectsRootRealPath = await realpath(projectsRoot);
  const targetRealPath = await realpath(targetPath);
  const relativePath = relative(projectsRootRealPath, targetRealPath);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Project Memory path is outside the local profile: ${targetPath}`);
  }
}

function compareProjectMemoryFiles(
  left: ProjectMemoryFileSummary,
  right: ProjectMemoryFileSummary,
): number {
  if (left.kind !== right.kind) {
    return left.kind === "index" ? -1 : 1;
  }
  return left.name.localeCompare(right.name, "en");
}

/**
 * 扫描一个 Project Memory 根，产出 catalog 快照。
 * 抽成模块级函数是为了让"当前生效根"和"其它数据根"两条路径复用同一份遍历与校验。
 */
async function collectProjectMemoryWorkspaces(
  projectsRoot: string,
): Promise<ProjectMemoryWorkspaceSummary[]> {
  const projectEntries = await readdir(projectsRoot, { withFileTypes: true });
  const workspaces: ProjectMemoryWorkspaceSummary[] = [];
  for (const projectEntry of projectEntries) {
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) {
      continue;
    }

    const workspaceId = projectEntry.name;
    const workspaceRoot = join(projectsRoot, workspaceId);
    const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
    if (!(await isPlainDirectory(workspaceRoot)) || !(await isPlainDirectory(memoryRoot))) {
      continue;
    }

    let memoryEntries;
    try {
      memoryEntries = await readdir(memoryRoot, { withFileTypes: true });
    } catch (error) {
      // 目录检查后 Memory Agent 仍可能删除目录；catalog 快照只跳过已消失的 workspace。
      if (isNotFoundError(error)) {
        continue;
      }
      throw error;
    }
    const files: ProjectMemoryFileSummary[] = [];
    for (const memoryEntry of memoryEntries) {
      if (
        !memoryEntry.isFile() ||
        memoryEntry.isSymbolicLink() ||
        !isProjectMemoryFileName(memoryEntry.name)
      ) {
        continue;
      }

      const filePath = join(memoryRoot, memoryEntry.name);
      let fileMetadata;
      try {
        fileMetadata = await lstat(filePath);
      } catch (error) {
        // readdir 后事实文件可能被并发删除；它不再属于本次只读快照。
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }
      if (!fileMetadata.isFile() || fileMetadata.isSymbolicLink()) {
        continue;
      }
      files.push({
        name: memoryEntry.name,
        path: filePath,
        kind: memoryEntry.name === PROJECT_MEMORY_INDEX_FILE_NAME ? "index" : "item",
        size: fileMetadata.size,
        updatedAt: fileMetadata.mtimeMs,
      });
    }

    if (files.length === 0) {
      continue;
    }

    files.sort(compareProjectMemoryFiles);
    workspaces.push({
      id: workspaceId,
      label: resolveWorkspaceLabel(workspaceId),
      updatedAt: Math.max(...files.map((file) => file.updatedAt)),
      files,
    });
  }

  workspaces.sort(
    (left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id, "en"),
  );
  return workspaces;
}

export function createMemoryService(): IMemoryService {
  async function listProjectMemories(): Promise<ProjectMemoryWorkspaceSummary[]> {
    try {
      const projectsRoot = await requireProjectMemoriesRoot();
      return await collectProjectMemoryWorkspaces(projectsRoot);
    } catch (error) {
      // 目录不存在等价于"暂无记忆"：首次启用、或尚未被 Memory Agent 创建过，都走这里。
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  }

  async function describeProjectMemoryRoots(): Promise<ProjectMemoryRootsDescription> {
    const activeRootPath = getProjectMemoriesRoot();
    const inactiveRoots = resolveInactiveProjectMemoryRoots({
      homeDir: homedir(),
      dataBaseDir: getDataBaseDir(),
      activeRootPath,
    });

    const summaries: ProjectMemoryInactiveRootSummary[] = [];
    for (const candidate of inactiveRoots) {
      // 只读探测：另一根不存在、不是普通目录、或没有任何记忆文件时都不产生提示。
      if (!(await isPlainDirectory(candidate.path))) {
        continue;
      }

      let workspaces: ProjectMemoryWorkspaceSummary[];
      try {
        workspaces = await collectProjectMemoryWorkspaces(candidate.path);
      } catch (error) {
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }
      if (workspaces.length === 0) {
        continue;
      }

      summaries.push({
        rootId: candidate.rootId,
        path: candidate.path,
        workspaceCount: workspaces.length,
        fileCount: workspaces.reduce((count, workspace) => count + workspace.files.length, 0),
      });
    }

    return { activeRootPath, inactiveRoots: summaries };
  }

  async function readProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<{ content: string; updatedAt: number }> {
    if (
      !isValidPathSegment(params.workspaceId) ||
      !isValidPathSegment(params.fileName) ||
      !isProjectMemoryFileName(params.fileName)
    ) {
      throw new Error("Invalid Project Memory path");
    }

    const projectsRoot = await requireProjectMemoriesRoot();
    const workspaceRoot = join(projectsRoot, params.workspaceId);
    const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
    await requirePlainDirectory(workspaceRoot);
    await requirePlainDirectory(memoryRoot);

    // 大小写不敏感文件系统会让请求名称命中不同大小写的磁盘文件，绕过 catalog 白名单。
    const filePath = await requireExactProjectMemoryFile(memoryRoot, params.fileName);
    return readProjectMemoryFileFromStableHandle({
      fileName: params.fileName,
      filePath,
      validatePath: async () => {
        await requireProjectMemoriesRoot();
        await requirePlainDirectory(workspaceRoot);
        await requirePlainDirectory(memoryRoot);
        await requireExactProjectMemoryFile(memoryRoot, params.fileName);
        await assertContainedProjectMemoryPath(projectsRoot, filePath);
      },
    });
  }

  async function deleteProjectMemoryFile(params: {
    workspaceId: string;
    fileName: string;
  }): Promise<void> {
    if (
      !isValidPathSegment(params.workspaceId) ||
      !isValidPathSegment(params.fileName) ||
      !isProjectMemoryFileName(params.fileName)
    ) {
      throw new Error("Invalid Project Memory path");
    }

    const projectsRoot = await requireProjectMemoriesRoot();
    const workspaceRoot = join(projectsRoot, params.workspaceId);
    const memoryRoot = join(workspaceRoot, PROJECT_MEMORY_DIRECTORY_NAME);
    await requirePlainDirectory(workspaceRoot);
    await requirePlainDirectory(memoryRoot);

    // 与读取走同一条校验链：精确文件名匹配拦住大小写不敏感文件系统上的别名，containment 确认
    // 目标仍在 projectsRoot 内。unlink 只作用于已确认为普通文件的路径；即使校验与删除之间被换成
    // 符号链接，unlink 删掉的是链接本身而不是它指向的外部文件。
    const filePath = await requireExactProjectMemoryFile(memoryRoot, params.fileName);
    await assertContainedProjectMemoryPath(projectsRoot, filePath);
    await unlink(filePath);

    // 索引每轮注入上下文：删掉文件却留下指向它的索引行会直接误导模型，所以清理不是可选项。
    // 被删除的就是 MEMORY.md 自身时它就是索引，不存在"清理对它的引用"。
    if (params.fileName !== PROJECT_MEMORY_INDEX_FILE_NAME) {
      await removeMemoryIndexEntries(projectsRoot, memoryRoot, params.fileName);
    }
  }

  /**
   * 从 `MEMORY.md` 移除指向已删除文件的索引行。
   * 没有索引文件、或没有匹配行时都不写盘，避免无意义地改动用户内容。
   */
  async function removeMemoryIndexEntries(
    projectsRoot: string,
    memoryRoot: string,
    fileName: string,
  ): Promise<void> {
    const indexPath = join(memoryRoot, PROJECT_MEMORY_INDEX_FILE_NAME);
    let content: string;
    try {
      content = await readFile(indexPath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        return;
      }
      throw error;
    }

    const stripped = stripMemoryIndexEntries(content, fileName);
    if (stripped === content) {
      return;
    }

    // 写回前重跑校验：索引文件可能在第一次校验与写入之间被替换成指向外部的链接。
    await requirePlainDirectory(memoryRoot);
    const exactIndexPath = await requireExactProjectMemoryFile(
      memoryRoot,
      PROJECT_MEMORY_INDEX_FILE_NAME,
    );
    await assertContainedProjectMemoryPath(projectsRoot, exactIndexPath);
    await atomicWriteText(exactIndexPath, stripped);
  }

  return {
    listProjectMemories,
    describeProjectMemoryRoots,
    readProjectMemoryFile,
    deleteProjectMemoryFile,
  };
}
