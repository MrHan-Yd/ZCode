import { basename, join } from "node:path";
import { createProjectId, type ProjectId } from "@zcode/contracts";
import { resolveProjectMemoryRoot } from "@zcode/core";

export function getCliStorageRoot(storageRoot: string): string {
  return basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
}

export function getPluginStorageRoot(cliStorageRoot: string): string {
  return join(cliStorageRoot, "plugins");
}

export function getModelIoDir(cliStorageRoot: string, isDevelopment: boolean): string {
  return join(cliStorageRoot, isDevelopment ? "debug" : "rollout");
}

/**
 * 记忆根所用的 cliStorageRoot。
 *
 * 记忆是设置页可见、可编辑的用户数据（storageCatalog 把它归在 config 类），必须与
 * 设置页同根：设置页读 `<dataBaseDir>/.zcode/cli/memories/projects`。而 memory.cliStorageRoot
 * 原先直接取 CLI 自己的 storage.dir（默认 ~/.zcode），不认 ZCODE_DATA_BASE_DIR，于是数据根
 * 搬家后 agent 继续把新记忆写进旧根，设置页把它读成「存在但不生效」——两端口径永久分叉。
 *
 * 只覆盖记忆：cli/db、cli/log、cli/rollout、cli/agents、cli/plugins 等运行时状态继续留在
 * storage.dir（裸 CLI 也走同样的回退）。见 specs/memory-data-root-continuity.md。
 */
export function getMemoryCliStorageRoot(
  cliStorageRoot: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const dataBaseDir = env.ZCODE_DATA_BASE_DIR?.trim();
  return dataBaseDir ? getCliStorageRoot(join(dataBaseDir, ".zcode")) : cliStorageRoot;
}

export function getProjectMemoryRoot(
  cliStorageRoot: string,
  workingDirectory: string,
  workspaceIdentity?: string,
): string {
  return resolveProjectMemoryRoot({
    cliStorageRoot,
    workspaceIdentity,
    workspacePath: workingDirectory,
  });
}

export function projectIdFromDirectory(directory: string): ProjectId {
  return createProjectId(
    directory
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "default",
  );
}
