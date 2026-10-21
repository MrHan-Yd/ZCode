/* eslint-disable max-lines -- 单文件集中 read-modify-write、损坏恢复与各 mutation 的锁内校验，拆分会削弱同一锁域的可读性。 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ZodError } from "zod";
import {
  PROMPT_LIBRARY_LIMITS,
  comparePromptTemplates,
  createUuid,
  formatZodError,
  promptLibraryFileV1Schema,
  promptTemplateInputSchema,
  promptTemplateUpdateInputSchema,
  toPromptTemplateSummary,
  type PromptLibraryFileV1,
  type PromptTemplate,
  type PromptTemplateInput,
} from "@zcode/shared";
import { atomicWritePrivateTextFile, backupCorruptFile, withFileLock } from "@zcode/shared/node";
import type { ICredentialService } from "../credential/credential.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";
import {
  createPromptLibraryConfigSync,
  type PromptLibrarySyncAccess,
} from "./promptLibraryConfigSync.js";
import type {
  IPromptLibraryService,
  PromptLibraryFailureReason,
  PromptLibraryGetResult,
  PromptLibraryListResult,
  PromptLibraryMutationResult,
  PromptLibraryRemoveResult,
  PromptLibraryResetResult,
  PromptLibraryWarning,
} from "./promptLibrary.js";

const logger = createServiceLogger("promptLibraryService");

const PROMPT_LIBRARY_FILE_NAME = "prompt-library.json";
const BACKUP_FILE_SUFFIX = ".bak";

export interface CreatePromptLibraryServiceOptions {
  /** 覆盖默认的 `{appConfigDir}/prompt-library.json`（测试/迁移用）。 */
  filePath?: string;
  now?: () => number;
  idFactory?: () => string;
  /** GitHub 同步凭据；缺省时 upload/preview/apply 返回 not_authenticated。 */
  credentialService?: Pick<ICredentialService, "load">;
  /** 必须由 Host 注入代理感知传输（与 MCP / Skills 一致）。 */
  fetchImpl?: typeof fetch;
}

interface LoadedState {
  file: PromptLibraryFileV1;
  existed: boolean;
  warning: PromptLibraryWarning | null;
  readOnly: boolean;
  /** false 表示当前主文件是损坏/更高版本，禁止任何覆盖写。 */
  canWrite: boolean;
}

type RawFileRead =
  | { kind: "missing" }
  | { kind: "valid"; file: PromptLibraryFileV1 }
  | { kind: "unsupported-version"; version: number }
  | { kind: "corrupt"; message: string; oversized?: boolean };

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeFile(file: PromptLibraryFileV1): string {
  return JSON.stringify(file, null, 2);
}

function createEmptyFile(timestamp: number): PromptLibraryFileV1 {
  return { version: 1, updatedAt: timestamp, items: [] };
}

function nextTimestamp(timestamp: number, previous: number | undefined): number {
  // 同毫秒内多次写入也要保持 updatedAt 单调，否则 UI 的乐观排序会抖动。
  return previous === undefined ? timestamp : Math.max(timestamp, previous + 1);
}

async function readRawFile(filePath: string): Promise<RawFileRead> {
  let fileSize: number;
  try {
    fileSize = (await stat(filePath)).size;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }

  // 异常大文件不能整份读进内存阻塞 Host；按损坏处理并走只读/备份恢复路径。
  if (fileSize > PROMPT_LIBRARY_LIMITS.maxFileBytes) {
    return {
      kind: "corrupt",
      message: `file exceeds ${PROMPT_LIBRARY_LIMITS.maxFileBytes} bytes`,
      oversized: true,
    };
  }

  const raw = await readFile(filePath, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", message: "invalid JSON" };
  }

  if (isRecord(parsed)) {
    const version = parsed.version;
    if (typeof version === "number" && Number.isInteger(version) && version > 1) {
      // 新版本数据不能被旧 Host 当成损坏覆盖；所有写操作统一拒绝。
      return { kind: "unsupported-version", version };
    }
  }

  const validated = promptLibraryFileV1Schema.safeParse(parsed);
  if (!validated.success) {
    return { kind: "corrupt", message: formatZodError(validated.error) };
  }
  return { kind: "valid", file: validated.data };
}

async function readBackupFile(filePath: string): Promise<PromptLibraryFileV1 | null> {
  try {
    const outcome = await readRawFile(`${filePath}${BACKUP_FILE_SUFFIX}`);
    return outcome.kind === "valid" ? outcome.file : null;
  } catch (error) {
    logger.warn(undefined, "prompt library backup read failed", {
      code: getErrorCode(error),
    });
    return null;
  }
}

async function persistFile(params: {
  filePath: string;
  next: PromptLibraryFileV1;
  backupSource: PromptLibraryFileV1 | null;
}): Promise<void> {
  if (params.backupSource) {
    // 备份是 best-effort：备份失败不能阻止本次主文件写入。
    await atomicWritePrivateTextFile(
      `${params.filePath}${BACKUP_FILE_SUFFIX}`,
      serializeFile(params.backupSource),
    ).catch((error: unknown) => {
      logger.warn(undefined, "prompt library backup write failed", {
        code: getErrorCode(error),
      });
    });
  }
  await atomicWritePrivateTextFile(params.filePath, serializeFile(params.next));
}

async function resolveOutcome(
  outcome: RawFileRead,
  filePath: string,
  timestamp: number,
): Promise<LoadedState> {
  switch (outcome.kind) {
    case "missing":
      return {
        file: createEmptyFile(timestamp),
        existed: false,
        warning: null,
        readOnly: false,
        canWrite: true,
      };
    case "valid":
      return {
        file: outcome.file,
        existed: true,
        warning: null,
        readOnly: false,
        canWrite: true,
      };
    case "unsupported-version":
      return {
        file: createEmptyFile(timestamp),
        existed: true,
        warning: {
          code: "unsupported-version",
          message: `prompt library file version ${outcome.version} is newer than this host supports`,
          version: outcome.version,
        },
        readOnly: true,
        canWrite: false,
      };
    case "corrupt": {
      // 超大文件不做隔离复制：避免为了备份再把异常文件整份读进内存。
      const quarantinePath = outcome.oversized
        ? undefined
        : await backupCorruptFile(filePath).catch((error: unknown) => {
            logger.warn(undefined, "prompt library quarantine failed", {
              code: getErrorCode(error),
            });
            return undefined;
          });
      const backup = await readBackupFile(filePath);
      if (backup) {
        // 恢复 .bak 后主文件重新可写；警告仍返回给 UI 提示发生过恢复。
        await atomicWritePrivateTextFile(filePath, serializeFile(backup));
        return {
          file: backup,
          existed: true,
          warning: {
            code: "corrupt-recovered",
            message: "prompt library was corrupt and has been restored from backup",
            ...(quarantinePath ? { quarantinePath } : {}),
          },
          readOnly: false,
          canWrite: true,
        };
      }
      return {
        file: createEmptyFile(timestamp),
        existed: true,
        warning: {
          code: "corrupt-quarantined",
          message: outcome.message,
          ...(quarantinePath ? { quarantinePath } : {}),
        },
        readOnly: true,
        canWrite: false,
      };
    }
  }
}

/** list/get 不加锁；只有检测到损坏需要恢复时才短暂进入锁。 */
async function loadStateForRead(filePath: string, timestamp: number): Promise<LoadedState> {
  const outcome = await readRawFile(filePath);
  if (outcome.kind !== "corrupt") {
    return resolveOutcome(outcome, filePath, timestamp);
  }
  return withFileLock(filePath, async () => {
    // 等锁期间其他进程可能已经修复，重新读取避免误隔离有效文件。
    return resolveOutcome(await readRawFile(filePath), filePath, timestamp);
  });
}

async function loadStateLocked(filePath: string, timestamp: number): Promise<LoadedState> {
  return resolveOutcome(await readRawFile(filePath), filePath, timestamp);
}

function failureFromZodError(error: ZodError): {
  reason: PromptLibraryFailureReason;
  message: string;
} {
  const field = error.issues[0]?.path[0];
  const reason: PromptLibraryFailureReason =
    field === "title"
      ? "invalid-title"
      : field === "content"
        ? "invalid-content"
        : field === "tags"
          ? "invalid-tags"
          : field === "alias"
            ? "invalid-alias"
            : field === "id"
              ? "not-found"
              : field === "expectedUpdatedAt"
                ? "conflict"
                : "invalid-content";
  return { reason, message: formatZodError(error) };
}

function failureFromState(state: LoadedState): {
  reason: PromptLibraryFailureReason;
  message: string;
} {
  return {
    reason: state.warning?.code === "unsupported-version" ? "unsupported-version" : "corrupt",
    message: state.warning?.message ?? "prompt library is not writable",
  };
}

function ioFailure(error: unknown): { reason: "io-error"; message: string } {
  return { reason: "io-error", message: getErrorMessage(error) };
}

function hasAliasConflict(items: PromptTemplate[], alias: string, excludeId?: string): boolean {
  const normalized = alias.toLowerCase();
  return items.some(
    (item) =>
      item.id !== excludeId &&
      typeof item.alias === "string" &&
      item.alias.toLowerCase() === normalized,
  );
}

function buildTemplateInput(input: PromptTemplateInput): {
  title: string;
  content: string;
  tags: string[];
  alias?: string;
} {
  return {
    title: input.title,
    content: input.content,
    tags: input.tags ?? [],
    ...(input.alias ? { alias: input.alias } : {}),
  };
}

export function createPromptLibraryService(
  options: CreatePromptLibraryServiceOptions = {},
): IPromptLibraryService {
  const now = options.now ?? (() => Date.now());
  const idFactory = options.idFactory ?? (() => `pl_${createUuid()}`);
  const resolveFilePath = () =>
    options.filePath ?? join(getAppConfigDir(), PROMPT_LIBRARY_FILE_NAME);

  // 同步写盘复用普通 mutation 的锁与原子写；readOnly（损坏/未来版本）由同步入口拒绝。
  const syncAccess: PromptLibrarySyncAccess = {
    async read() {
      const state = await loadStateForRead(resolveFilePath(), now());
      return { file: state.file, readOnly: !state.canWrite };
    },

    async update(mutate) {
      const filePath = resolveFilePath();
      await withFileLock(filePath, async () => {
        const timestamp = now();
        const state = await loadStateLocked(filePath, timestamp);
        if (!state.canWrite) {
          throw new Error(state.warning?.message ?? "prompt library is read-only");
        }
        const next = mutate(state.file);
        // 合并可能超过 500 条或引入非法字段：校验失败直接抛错，绝不写盘。
        const validated = promptLibraryFileV1Schema.safeParse(next);
        if (!validated.success) {
          throw new Error(formatZodError(validated.error));
        }
        await persistFile({
          filePath,
          next: validated.data,
          backupSource: state.existed ? state.file : null,
        });
      });
    },

    async restore(file) {
      const filePath = resolveFilePath();
      try {
        await withFileLock(filePath, async () => {
          const timestamp = now();
          const state = await loadStateLocked(filePath, timestamp);
          // 未来版本的数据不能被旧 Host 用备份覆盖；损坏则允许用备份恢复。
          if (state.warning?.code === "unsupported-version") {
            throw new Error(state.warning.message);
          }
          const validated = promptLibraryFileV1Schema.safeParse(file);
          if (!validated.success) {
            throw new Error(formatZodError(validated.error));
          }
          await persistFile({
            filePath,
            next: validated.data,
            backupSource: state.canWrite && state.existed ? state.file : null,
          });
        });
        return true;
      } catch (error) {
        logger.warn(undefined, "prompt library sync restore failed", {
          code: getErrorCode(error),
        });
        return false;
      }
    },

    filePath: () => resolveFilePath(),
  };

  const syncOperations = createPromptLibraryConfigSync({
    access: syncAccess,
    credentialService: options.credentialService,
    fetchImpl: options.fetchImpl,
    now,
  });

  /** upload/preview/apply 前的只读检查：避免损坏库以空快照覆盖远端。 */
  const resolveSyncLocalInvalid = async (): Promise<{
    status: "error";
    error: { code: "local_invalid"; message: string };
  } | null> => {
    try {
      const { readOnly } = await syncAccess.read();
      if (!readOnly) return null;
      return {
        status: "error",
        error: {
          code: "local_invalid",
          message: "prompt library is read-only (corrupt or unsupported version)",
        },
      };
    } catch (error) {
      return {
        status: "error",
        error: { code: "local_invalid", message: getErrorMessage(error) },
      };
    }
  };

  return {
    async list(): Promise<PromptLibraryListResult> {
      try {
        const state = await loadStateForRead(resolveFilePath(), now());
        const items = [...state.file.items]
          .sort((left, right) => comparePromptTemplates(left, right))
          .map(toPromptTemplateSummary);
        return { items, warning: state.warning, readOnly: state.readOnly };
      } catch (error) {
        logger.error(undefined, "prompt library list failed", {
          code: getErrorCode(error),
        });
        return { items: [], warning: null, readOnly: true };
      }
    },

    async get(params: { id: string }): Promise<PromptLibraryGetResult> {
      try {
        const state = await loadStateForRead(resolveFilePath(), now());
        if (!state.canWrite) {
          return { ok: false, ...failureFromState(state) };
        }
        const item = state.file.items.find((entry) => entry.id === params.id);
        return item ? { ok: true, item } : { ok: false, reason: "not-found" };
      } catch (error) {
        return { ok: false, ...ioFailure(error) };
      }
    },

    async create(params: PromptTemplateInput): Promise<PromptLibraryMutationResult> {
      const validated = promptTemplateInputSchema.safeParse(params);
      if (!validated.success) {
        return { ok: false, ...failureFromZodError(validated.error) };
      }
      const input = buildTemplateInput(validated.data);
      const filePath = resolveFilePath();
      try {
        return await withFileLock(filePath, async () => {
          const timestamp = now();
          const state = await loadStateLocked(filePath, timestamp);
          if (!state.canWrite) {
            return { ok: false, ...failureFromState(state) };
          }
          if (state.file.items.length >= PROMPT_LIBRARY_LIMITS.maxItems) {
            return {
              ok: false,
              reason: "too-many-items" as const,
              message: `prompt library already has ${PROMPT_LIBRARY_LIMITS.maxItems} items`,
            };
          }
          if (input.alias && hasAliasConflict(state.file.items, input.alias)) {
            return {
              ok: false,
              reason: "alias-conflict" as const,
              message: "alias is already used by another prompt",
            };
          }

          const item: PromptTemplate = {
            id: idFactory(),
            title: input.title,
            content: input.content,
            tags: input.tags,
            pinned: false,
            createdAt: timestamp,
            updatedAt: timestamp,
            ...(input.alias ? { alias: input.alias } : {}),
          };
          const next: PromptLibraryFileV1 = {
            version: 1,
            updatedAt: nextTimestamp(timestamp, state.file.updatedAt),
            items: [...state.file.items, item],
          };
          await persistFile({
            filePath,
            next,
            backupSource: state.existed ? state.file : null,
          });
          return { ok: true, item };
        });
      } catch (error) {
        logger.error(undefined, "prompt library create failed", {
          code: getErrorCode(error),
        });
        return { ok: false, ...ioFailure(error) };
      }
    },

    async update(
      params: PromptTemplateInput & { id: string; expectedUpdatedAt?: number },
    ): Promise<PromptLibraryMutationResult> {
      const validated = promptTemplateUpdateInputSchema.safeParse(params);
      if (!validated.success) {
        return { ok: false, ...failureFromZodError(validated.error) };
      }
      const input = buildTemplateInput(validated.data);
      const filePath = resolveFilePath();
      try {
        return await withFileLock(filePath, async () => {
          const timestamp = now();
          const state = await loadStateLocked(filePath, timestamp);
          if (!state.canWrite) {
            return { ok: false, ...failureFromState(state) };
          }
          const index = state.file.items.findIndex((item) => item.id === validated.data.id);
          const current = state.file.items[index];
          if (index < 0 || !current) {
            return { ok: false, reason: "not-found" as const };
          }
          if (
            validated.data.expectedUpdatedAt !== undefined &&
            validated.data.expectedUpdatedAt !== current.updatedAt
          ) {
            return {
              ok: false,
              reason: "conflict" as const,
              message: "prompt was modified by another window",
              current: toPromptTemplateSummary(current),
            };
          }
          if (input.alias && hasAliasConflict(state.file.items, input.alias, current.id)) {
            return {
              ok: false,
              reason: "alias-conflict" as const,
              message: "alias is already used by another prompt",
            };
          }

          const item: PromptTemplate = {
            id: current.id,
            title: input.title,
            content: input.content,
            tags: input.tags,
            pinned: current.pinned,
            createdAt: current.createdAt,
            updatedAt: nextTimestamp(timestamp, current.updatedAt),
            ...(input.alias ? { alias: input.alias } : {}),
            ...(current.lastUsedAt !== undefined ? { lastUsedAt: current.lastUsedAt } : {}),
          };
          const items = [...state.file.items];
          items[index] = item;
          const next: PromptLibraryFileV1 = {
            version: 1,
            updatedAt: nextTimestamp(timestamp, state.file.updatedAt),
            items,
          };
          await persistFile({
            filePath,
            next,
            backupSource: state.existed ? state.file : null,
          });
          return { ok: true, item };
        });
      } catch (error) {
        logger.error(undefined, "prompt library update failed", {
          code: getErrorCode(error),
        });
        return { ok: false, ...ioFailure(error) };
      }
    },

    async remove(params: { id: string }): Promise<PromptLibraryRemoveResult> {
      const filePath = resolveFilePath();
      try {
        return await withFileLock(filePath, async () => {
          const timestamp = now();
          const state = await loadStateLocked(filePath, timestamp);
          if (!state.canWrite) {
            return { ok: false, ...failureFromState(state) };
          }
          const index = state.file.items.findIndex((item) => item.id === params.id);
          if (index < 0) {
            // 幂等：另一个窗口已经删除时视为成功。
            return { ok: true as const };
          }
          const next: PromptLibraryFileV1 = {
            version: 1,
            updatedAt: nextTimestamp(timestamp, state.file.updatedAt),
            items: state.file.items.filter((item) => item.id !== params.id),
          };
          await persistFile({
            filePath,
            next,
            backupSource: state.existed ? state.file : null,
          });
          return { ok: true as const };
        });
      } catch (error) {
        logger.error(undefined, "prompt library remove failed", {
          code: getErrorCode(error),
        });
        return { ok: false, ...ioFailure(error) };
      }
    },

    async setPinned(params: { id: string; pinned: boolean }): Promise<PromptLibraryMutationResult> {
      if (typeof params.pinned !== "boolean") {
        return {
          ok: false,
          reason: "invalid-content",
          message: "pinned must be a boolean",
        };
      }
      const filePath = resolveFilePath();
      try {
        return await withFileLock(filePath, async () => {
          const timestamp = now();
          const state = await loadStateLocked(filePath, timestamp);
          if (!state.canWrite) {
            return { ok: false, ...failureFromState(state) };
          }
          const index = state.file.items.findIndex((item) => item.id === params.id);
          const current = state.file.items[index];
          if (index < 0 || !current) {
            return { ok: false, reason: "not-found" as const };
          }
          const item: PromptTemplate = {
            ...current,
            pinned: params.pinned,
            updatedAt: nextTimestamp(timestamp, current.updatedAt),
          };
          const items = [...state.file.items];
          items[index] = item;
          const next: PromptLibraryFileV1 = {
            version: 1,
            updatedAt: nextTimestamp(timestamp, state.file.updatedAt),
            items,
          };
          await persistFile({
            filePath,
            next,
            backupSource: state.existed ? state.file : null,
          });
          return { ok: true, item };
        });
      } catch (error) {
        logger.error(undefined, "prompt library setPinned failed", {
          code: getErrorCode(error),
        });
        return { ok: false, ...ioFailure(error) };
      }
    },

    async recordUsage(params: { id: string }): Promise<void> {
      const filePath = resolveFilePath();
      try {
        await withFileLock(filePath, async () => {
          const timestamp = now();
          const state = await loadStateLocked(filePath, timestamp);
          // best-effort：损坏/更高版本或记录已删除时直接放弃，不覆盖任何数据。
          if (!state.canWrite) return;
          const index = state.file.items.findIndex((item) => item.id === params.id);
          const current = state.file.items[index];
          if (index < 0 || !current) return;
          const items = [...state.file.items];
          items[index] = { ...current, lastUsedAt: timestamp };
          await persistFile({
            filePath,
            next: {
              version: 1,
              updatedAt: nextTimestamp(timestamp, state.file.updatedAt),
              items,
            },
            backupSource: state.existed ? state.file : null,
          });
        });
      } catch (error) {
        logger.warn(undefined, "prompt library recordUsage failed", {
          code: getErrorCode(error),
        });
      }
    },

    async reset(): Promise<PromptLibraryResetResult> {
      const filePath = resolveFilePath();
      try {
        return await withFileLock(filePath, async () => {
          const timestamp = now();
          const outcome = await readRawFile(filePath);
          if (outcome.kind === "unsupported-version") {
            return {
              ok: false,
              reason: "unsupported-version" as const,
              message: `prompt library file version ${outcome.version} is newer than this host supports`,
            };
          }
          // 重建前保留证据；文件不存在时 backupCorruptFile 会 ENOENT，直接忽略。
          // 超大异常文件不再整份读取备份，避免重建动作本身阻塞 Host。
          const shouldBackup = !(outcome.kind === "corrupt" && outcome.oversized);
          if (shouldBackup) {
            await backupCorruptFile(filePath).catch((error: unknown) => {
              if (getErrorCode(error) !== "ENOENT") {
                logger.warn(undefined, "prompt library reset backup failed", {
                  code: getErrorCode(error),
                });
              }
            });
          }
          const empty = createEmptyFile(timestamp);
          await persistFile({ filePath, next: empty, backupSource: null });
          // 旧 .bak 可能保存着重置前的数据；用空文件覆盖，避免下次损坏时把已清理的内容复活。
          await atomicWritePrivateTextFile(
            `${filePath}${BACKUP_FILE_SUFFIX}`,
            serializeFile(empty),
          ).catch((error: unknown) => {
            logger.warn(undefined, "prompt library reset backup write failed", {
              code: getErrorCode(error),
            });
          });
          return { ok: true as const };
        });
      } catch (error) {
        logger.error(undefined, "prompt library reset failed", {
          code: getErrorCode(error),
        });
        return { ok: false, ...ioFailure(error) };
      }
    },

    getSyncStatus: () => syncOperations.getStatus(),

    async uploadToGithub(params) {
      const localInvalid = await resolveSyncLocalInvalid();
      return localInvalid ?? syncOperations.upload(params);
    },

    async previewDownload() {
      const localInvalid = await resolveSyncLocalInvalid();
      return localInvalid ?? syncOperations.preview();
    },

    async applyDownload(params) {
      const localInvalid = await resolveSyncLocalInvalid();
      return localInvalid ?? syncOperations.apply(params);
    },

    listSyncBackups: () => syncOperations.listBackups(),

    restoreSyncBackup: (params) => syncOperations.restore(params),
  };
}
