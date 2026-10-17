import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ConfigSyncMetadata } from "./types.js";

/**
 * 本机同步元数据（gistId / 上次 revision / 内容指纹 / 时间）。
 *
 * 每个功能用自己的文件名，互不覆盖；这是「我们以为远端是什么」的缓存，丢了只会多一次 GET，
 * 不会产生错误的远端状态，所以解析失败一律按「没有元数据」处理。
 */

const log = createServiceLogger("configSync");

const SCHEMA_VERSION = 1;

const metadataSchema = z.object({
  schemaVersion: z.number().int(),
  gistId: z.string().trim().min(1).optional(),
  lastRemoteRevision: z.number().int().nonnegative().optional(),
  lastLocalFingerprint: z.string().trim().min(1).optional(),
  lastSyncedAt: z.number().int().nonnegative().optional(),
});

export type ReadConfigSyncMetadata = () => Promise<ConfigSyncMetadata>;

export interface ConfigSyncMetadataStore {
  read: ReadConfigSyncMetadata;
  write(next: ConfigSyncMetadata): Promise<void>;
}

export function createConfigSyncMetadataStore(
  resolveFilePath: () => Promise<string>,
): ConfigSyncMetadataStore {
  return {
    async read() {
      const filePath = await resolveFilePath();
      try {
        const raw = await readFile(filePath, "utf-8");
        const parsed = metadataSchema.safeParse(JSON.parse(raw) as unknown);
        if (!parsed.success || parsed.data.schemaVersion !== SCHEMA_VERSION) {
          log.warn(undefined, "config sync metadata invalid, treating as absent", { filePath });
          return { schemaVersion: SCHEMA_VERSION };
        }
        return parsed.data;
      } catch {
        return { schemaVersion: SCHEMA_VERSION };
      }
    },
    async write(next) {
      const filePath = await resolveFilePath();
      await mkdir(dirname(filePath), { recursive: true });
      await atomicWriteText(filePath, `${JSON.stringify(next, null, 2)}\n`);
    },
  };
}
