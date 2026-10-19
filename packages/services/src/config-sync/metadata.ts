import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { USER_CONFIG_SYNC_SCOPE, type ConfigSyncScope } from "./scope.js";
import type { ConfigSyncMetadata } from "./types.js";

/**
 * 本机同步元数据（gistId / 上次 revision / 内容指纹 / 时间）。
 *
 * 每个功能用自己的文件，互不覆盖；**一份文件按作用域分片**（`user` 与 `workspaces[label]`），
 * 每个作用域只读写自己那一片，所以用户级与项目级各自记住自己的 gist。
 *
 * 这是「我们以为远端是什么」的缓存，丢了只会多一次 GET，不会产生错误的远端状态，所以解析失败一律按
 * 「没有元数据」处理。磁盘格式版本由本模块独占（编排层不再传 `schemaVersion`）。
 */

const log = createServiceLogger("configSync");

/** v1 是「扁平字段」的旧格式（只有用户级），v2 起是分作用域的信封。 */
const SCHEMA_VERSION = 2;

const recordSchema = z.object({
  gistId: z.string().trim().min(1).optional(),
  lastRemoteRevision: z.number().int().nonnegative().optional(),
  lastLocalFingerprint: z.string().trim().min(1).optional(),
  lastSyncedAt: z.number().int().nonnegative().optional(),
});

const envelopeSchema = z.object({
  schemaVersion: z.number().int(),
  user: recordSchema.optional(),
  workspaces: z.record(z.string(), recordSchema).optional(),
});

interface Envelope {
  schemaVersion: number;
  user?: ConfigSyncMetadata;
  workspaces?: Record<string, ConfigSyncMetadata>;
}

export type ReadConfigSyncMetadata = () => Promise<ConfigSyncMetadata>;

export interface ConfigSyncMetadataStore {
  read: ReadConfigSyncMetadata;
  write(next: ConfigSyncMetadata): Promise<void>;
}

/**
 * 同一文件的写入串行链。
 *
 * 元数据写入发生在写队列之外（上传成功后直接落盘），而两个作用域共用同一份文件，读改写并发会丢更新
 * （用户级刚写下的 gistId 被工作区级的写覆盖）。这里是这一层唯一的并发保护点，按文件路径串行。
 */
const writeChains = new Map<string, Promise<void>>();

function enqueueFileWrite<T>(filePath: string, run: () => Promise<T>): Promise<T> {
  const previous = writeChains.get(filePath) ?? Promise.resolve();
  const queued = previous.then(run, run);
  writeChains.set(
    filePath,
    queued.then(
      () => undefined,
      () => undefined,
    ),
  );
  return queued;
}

export function createConfigSyncMetadataStore(
  resolveFilePath: () => Promise<string>,
  scope: ConfigSyncScope = USER_CONFIG_SYNC_SCOPE,
): ConfigSyncMetadataStore {
  const readEnvelope = async (filePath: string): Promise<Envelope> => {
    const empty: Envelope = { schemaVersion: SCHEMA_VERSION };
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      return empty;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      log.warn(undefined, "config sync metadata is not valid JSON, treating as absent", { filePath });
      return empty;
    }
    const envelope = envelopeSchema.safeParse(parsed);
    if (envelope.success && envelope.data.schemaVersion === SCHEMA_VERSION) {
      return envelope.data;
    }
    // v1 → v2：旧格式的扁平字段就是用户级记录，多出来的 schemaVersion 会被 recordSchema 丢掉；
    // 下一次写入落成 v2，旧文件被原子替换。
    if (isLegacyMetadata(parsed)) {
      const record = recordSchema.safeParse(parsed);
      return { schemaVersion: SCHEMA_VERSION, ...(record.success ? { user: record.data } : {}) };
    }
    log.warn(undefined, "config sync metadata invalid, treating as absent", { filePath });
    return empty;
  };

  return {
    async read() {
      const envelope = await readEnvelope(await resolveFilePath());
      const record =
        scope.kind === "user" ? envelope.user : envelope.workspaces?.[scope.label];
      return record ?? {};
    },

    async write(next) {
      const filePath = await resolveFilePath();
      await enqueueFileWrite(filePath, async () => {
        // 队列内重新读一次：并发写时拿到的才是最新的其它作用域分片。
        const envelope = await readEnvelope(filePath);
        const merged = mergeRecord(envelope, scope, next);
        await mkdir(dirname(filePath), { recursive: true });
        await atomicWriteText(filePath, `${JSON.stringify(merged, null, 2)}\n`);
      });
    },
  };
}

function isLegacyMetadata(parsed: unknown): boolean {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as { schemaVersion?: unknown }).schemaVersion === 1
  );
}

/** 只替换本作用域那一片，其它分片原样保留。 */
function mergeRecord(
  envelope: Envelope,
  scope: ConfigSyncScope,
  next: ConfigSyncMetadata,
): Envelope {
  if (scope.kind === "user") {
    return { ...envelope, schemaVersion: SCHEMA_VERSION, user: next };
  }
  return {
    ...envelope,
    schemaVersion: SCHEMA_VERSION,
    workspaces: { ...envelope.workspaces, [scope.label]: next },
  };
}
