import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  normalizeOrchestrationOwner,
  orchestrationOwnerKey,
  OrchestrationStoreError,
  type OrchestrationRunOwner,
} from "@zcode/contracts";

export function orchestrationDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class OrchestrationStoragePaths {
  readonly owner: OrchestrationRunOwner;
  readonly directory: string;
  private readonly rootDirectory: string;

  constructor(options: { rootDirectory: string; owner: OrchestrationRunOwner }) {
    this.owner = Object.freeze(normalizeOrchestrationOwner(options.owner));
    if (!options.rootDirectory.trim()) {
      throw new OrchestrationStoreError(
        "invalid_record",
        "Orchestration storage requires a data directory.",
      );
    }
    this.rootDirectory = resolve(options.rootDirectory);
    this.directory = join(
      this.rootDirectory,
      "orchestration",
      orchestrationDigest(orchestrationOwnerKey(this.owner)),
    );
  }

  file(kind: "runs" | "artifacts", key: string): string {
    if (typeof key !== "string" || !key.trim()) {
      throw new OrchestrationStoreError(
        "invalid_record",
        "Orchestration storage key must be non-empty.",
      );
    }
    return join(this.directory, kind, `${orchestrationDigest(key)}.json`);
  }

  /** 冷恢复只在 runs 目录里枚举快照；artifacts 由 run 记录引用，不参与列表。 */
  get runsDirectory(): string {
    return join(this.directory, "runs");
  }

  async prepare(filePath: string): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true });
    const root = await realpath(this.rootDirectory);
    let directory = this.rootDirectory;
    const segments = relative(this.rootDirectory, filePath).split(sep).slice(0, -1);
    for (const segment of segments) {
      directory = join(directory, segment);
      await mkdir(directory, { recursive: true });
      const resolvedDirectory = await realpath(directory);
      assertContainedPath(root, resolvedDirectory);
    }
    try {
      assertContainedPath(root, await realpath(filePath));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
    try {
      // 文件锁回收会删除目录条目，不能跟随越界 symlink / junction 去清理根外文件。
      const lockPath = `${filePath}.lock`;
      if ((await lstat(lockPath)).isSymbolicLink()) {
        throw new OrchestrationStoreError(
          "owner_mismatch",
          "Orchestration lock must not be a symbolic link.",
        );
      }
      assertContainedPath(root, await realpath(lockPath));
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }
  }
}

function assertContainedPath(root: string, filePath: string): void {
  const relativePath = relative(root, filePath);
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    throw new OrchestrationStoreError(
      "owner_mismatch",
      "Orchestration storage path escapes its data directory.",
    );
  }
}

export function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function readOrchestrationJson(filePath: string): Promise<unknown | undefined> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new OrchestrationStoreError(
      "invalid_record",
      "Orchestration persisted JSON is invalid.",
      { cause: error },
    );
  }
}
