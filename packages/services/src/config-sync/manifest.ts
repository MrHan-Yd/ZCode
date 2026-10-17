import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  ConfigSyncItem,
  ConfigSyncManifest,
  ConfigSyncManifestItem,
  ConfigSyncProfile,
  ConfigSyncRemoteParseResult,
  ConfigSyncSkippedRemoteFile,
} from "./types.js";

/**
 * 远端 gist 的 manifest schema 与「本机内容 ↔ 远端文件」的纯计算。
 * 与功能无关：文件名映射与内容校验由 `ConfigSyncProfile` 注入。
 */

export const CONFIG_SYNC_MANIFEST_FILE_NAME = "manifest.json";
const SCHEMA_VERSION = 1;

const manifestItemSchema = z
  .object({
    name: z.string().trim().min(1),
    fileName: z.string().trim().min(1),
    sha256: z.string().trim().min(1),
    bytes: z.number().int().nonnegative(),
  })
  .strict();

const manifestExtraSchema = z
  .object({
    fileName: z.string().trim().min(1),
    sha256: z.string().trim().min(1),
  })
  .strict();

const manifestSchema = z
  .object({
    schemaVersion: z.number().int(),
    revision: z.number().int().nonnegative(),
    updatedAt: z.string().trim().min(1),
    items: z.array(manifestItemSchema),
    extras: z.array(manifestExtraSchema).default([]),
  })
  .strict();

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 稳定序列化：键排序后输出，用于把对象内容变成可比对的文本（指纹、diff 都依赖它）。 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export function parseManifest(input: unknown): ConfigSyncManifest | null {
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success || parsed.data.schemaVersion !== SCHEMA_VERSION) return null;
  return parsed.data;
}

/**
 * 内容指纹：与条目顺序无关（先排序再哈希），只覆盖会参与同步的内容。
 * 用途是「本地是否变化」的幂等键，因此不能掺时间戳。
 */
export function computeFingerprint(
  items: readonly ConfigSyncItem[],
  extras: readonly { fileName: string; content: string }[],
): string {
  const lines = items.map((item) => `item\u0000${item.name}\u0000${sha256Hex(item.content)}`);
  for (const extra of extras) {
    lines.push(`extra\u0000${extra.fileName}\u0000${sha256Hex(extra.content)}`);
  }
  return sha256Hex(lines.sort().join("\n"));
}

/** 上传前的大小上限检查；返回超限的条目名。 */
export function findOversizedItem(
  profile: ConfigSyncProfile,
  items: readonly ConfigSyncItem[],
): string | null {
  let totalBytes = 0;
  for (const item of items) {
    const bytes = Buffer.byteLength(item.content, "utf8");
    if (bytes > profile.maxFileBytes) return item.name;
    totalBytes += bytes;
    if (totalBytes > profile.maxTotalBytes) return item.name;
  }
  return null;
}

export function buildRemoteFiles(
  profile: ConfigSyncProfile,
  params: {
    readonly items: readonly ConfigSyncItem[];
    readonly extras: readonly { fileName: string; content: string }[];
    readonly revision: number;
    readonly updatedAt: string;
    /** 远端当前已有的文件名（含上一版 manifest 里的条目文件）。 */
    readonly previousFileNames: readonly string[];
  },
): { files: Record<string, string | null>; manifest: ConfigSyncManifest } | null {
  const files: Record<string, string | null> = {};
  const manifestItems: ConfigSyncManifestItem[] = [];
  for (const item of params.items) {
    const fileName = profile.fileNameFor(item.name);
    if (!fileName) return null;
    files[fileName] = item.content;
    manifestItems.push({
      name: item.name,
      fileName,
      sha256: sha256Hex(item.content),
      bytes: Buffer.byteLength(item.content, "utf8"),
    });
  }
  const extras = params.extras.map((extra) => {
    files[extra.fileName] = extra.content;
    return { fileName: extra.fileName, sha256: sha256Hex(extra.content) };
  });
  const manifest: ConfigSyncManifest = {
    schemaVersion: SCHEMA_VERSION,
    revision: params.revision,
    updatedAt: params.updatedAt,
    items: manifestItems.sort((left, right) => left.name.localeCompare(right.name)),
    extras: extras.sort((left, right) => left.fileName.localeCompare(right.fileName)),
  };
  files[CONFIG_SYNC_MANIFEST_FILE_NAME] = `${JSON.stringify(manifest, null, 2)}\n`;
  // 上传即镜像：远端多出来的条目文件在本轮删除（gist 删除文件 = 传 null）。
  const kept = new Set(Object.keys(files));
  for (const fileName of params.previousFileNames) {
    if (profile.nameFromFileName(fileName) !== null && !kept.has(fileName)) files[fileName] = null;
  }
  return { files, manifest };
}

/** 解析 `GET /gists/{id}` 的 `files`：校验 manifest、额外通道与每个条目文件的 sha256、大小与可加载性。 */
export function parseRemoteFiles(
  profile: ConfigSyncProfile,
  files: unknown,
): ConfigSyncRemoteParseResult {
  if (!isRecord(files)) return { status: "invalid", message: "远端 gist 缺少 files" };
  const manifestRaw = readGistFileContent(files[CONFIG_SYNC_MANIFEST_FILE_NAME]);
  if (manifestRaw === null) {
    return { status: "invalid", message: `远端缺少 ${CONFIG_SYNC_MANIFEST_FILE_NAME}` };
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch {
    return { status: "invalid", message: `${CONFIG_SYNC_MANIFEST_FILE_NAME} 不是合法 JSON` };
  }
  const manifest = parseManifest(manifestJson);
  if (!manifest) {
    return {
      status: "invalid",
      message: `${CONFIG_SYNC_MANIFEST_FILE_NAME} 校验失败或 schemaVersion 不受支持`,
    };
  }

  const extras = new Map<string, string>();
  for (const extra of manifest.extras) {
    if (!profile.extraFileNames.includes(extra.fileName)) {
      return { status: "invalid", message: `manifest 声明了未支持的额外文件：${extra.fileName}` };
    }
    const content = readGistFileContent(files[extra.fileName]);
    if (content === null) return { status: "invalid", message: `远端缺少 ${extra.fileName}` };
    if (sha256Hex(content) !== extra.sha256) {
      return { status: "invalid", message: `${extra.fileName} 与 manifest 记录的校验和不一致` };
    }
    extras.set(extra.fileName, content);
  }

  const items: ConfigSyncItem[] = [];
  let totalBytes = 0;
  for (const entry of manifest.items) {
    const name = profile.nameFromFileName(entry.fileName);
    if (name === null || name !== entry.name) {
      return { status: "invalid", message: `manifest 中的文件名不合法：${entry.fileName}` };
    }
    const content = readGistFileContent(files[entry.fileName]);
    if (content === null) return { status: "invalid", message: `远端缺少 ${entry.fileName}` };
    if (sha256Hex(content) !== entry.sha256) {
      return { status: "invalid", message: `${entry.fileName} 与 manifest 记录的校验和不一致` };
    }
    // 先判大小再判可加载性：超限的诊断更准确，也避免为超大内容做无谓解析。
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > profile.maxFileBytes) {
      return { status: "too_large", message: `${entry.fileName} 超过单文件大小上限` };
    }
    totalBytes += bytes;
    if (totalBytes > profile.maxTotalBytes) {
      return { status: "too_large", message: "远端配置总量超过大小上限" };
    }
    if (!profile.isValidContent(entry.fileName, content)) {
      return { status: "invalid", message: `${entry.fileName} 内容无法被本功能加载` };
    }
    items.push({ name, content });
  }

  // manifest 未登记的文件不算失败：可能是用户手工放的说明文件，报出来即可。
  const known = new Set<string>([
    CONFIG_SYNC_MANIFEST_FILE_NAME,
    ...manifest.extras.map((extra) => extra.fileName),
    ...manifest.items.map((entry) => entry.fileName),
  ]);
  const skipped: ConfigSyncSkippedRemoteFile[] = Object.keys(files)
    .filter((fileName) => !known.has(fileName))
    .sort()
    .map((fileName) => ({
      fileName,
      reason: profile.nameFromFileName(fileName) === null ? "unknown_file" : "invalid",
    }));

  return {
    status: "ok",
    manifest,
    items: items.sort((left, right) => left.name.localeCompare(right.name)),
    extras,
    skipped,
  };
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => sortJson(entry));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, sortJson(entry)]),
    );
  }
  return value;
}

/** GitHub gist 的 `files[name]` 结构；`content` 缺省或文件被截断时按「读不到」处理。 */
function readGistFileContent(entry: unknown): string | null {
  if (!isRecord(entry)) return null;
  if (entry.truncated === true) return null;
  return typeof entry.content === "string" ? entry.content : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
