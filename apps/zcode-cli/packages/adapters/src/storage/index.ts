// Storage adapters - EventStore, ArtifactStore, MemoryStore implementations

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ImageAttachmentPathPrimeRequest,
  MediaAttachmentPathPrimeRequest,
  MediaAttachmentPathEnsureRequest,
  MediaAttachmentPathResult,
  ToolBinaryArtifactWriteRequest,
  ToolArtifactStorePort,
  ToolArtifactReadRequest,
  ToolArtifactReadResult,
  ToolArtifactStatRequest,
  ToolArtifactStatResult,
  ToolArtifactWriteRequest,
  ToolArtifactWriteResult,
  ToolBinaryArtifactReadResult,
} from "@zcode/contracts";
import { maybeThrowStorageFsFault } from "./fs-fault-injection.js";

export * from "./session-store.js";

// 内存 event store 实现已下沉到 @zcode/contracts，
// 这里保持 `@zcode/adapters/storage` 的导出路径不变，避免调用方改 import。
export {
  InMemorySessionEventStore,
  createInMemorySessionEventStore,
  type InMemorySessionEventStoreOptions,
} from "@zcode/contracts";

export interface NodeToolArtifactStoreOptions {
  imageCacheRootDir: string;
  pdfCacheRootDir?: string;
  rootDir: string;
  videoCacheRootDir: string;
}

/**
 * 会话 artifact 目录索引的 LRU 上限。只影响性能：未命中的目录下次读取会重新枚举。
 * 单个会话的索引是几百到几千个文件名，64 个目录的量级在 MB 以内。
 */
const ARTIFACT_DIRECTORY_INDEX_CACHE_LIMIT = 64;

interface ArtifactDirectoryIndex {
  byArtifactId: Map<string, string>;
  names: string[];
}

export class NodeToolArtifactStore implements ToolArtifactStorePort {
  private readonly imageCacheRootDir: string;
  private readonly pdfCacheRootDir: string;
  private readonly rootDir: string;
  private readonly videoCacheRootDir: string;
  private readonly listDirectory: (path: string) => Promise<string[]>;
  // 冷恢复会对同一个会话目录按 artifact 逐个定位；每次 readdir 的代价远高于一次 Map 查找。
  // 缓存按会话目录保存，写入时增量更新，跨进程变化由 miss / ENOENT 刷新兜底。
  private readonly artifactDirectoryIndexes = new Map<string, ArtifactDirectoryIndex>();
  private readonly artifactDirectoryIndexFlights = new Map<string, Promise<ArtifactDirectoryIndex>>();
  private readonly mediaAttachmentPathFlights = new Map<
    string,
    Promise<MediaAttachmentPathResult>
  >();

  constructor(
    options: NodeToolArtifactStoreOptions,
    testHooks?: { listDirectory?: (path: string) => Promise<string[]> },
  ) {
    this.imageCacheRootDir = options.imageCacheRootDir;
    this.rootDir = options.rootDir;
    this.pdfCacheRootDir = options.pdfCacheRootDir ?? join(dirname(options.rootDir), "pdf-cache");
    this.videoCacheRootDir = options.videoCacheRootDir;
    this.listDirectory = testHooks?.listDirectory ?? ((path) => readdir(path));
  }

  async writeToolResultArtifact(
    request: ToolArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact write cancelled");
    }

    const artifactId = `tool-result-${crypto.randomUUID()}`;
    const contentType = request.contentType ?? "application/json";
    const extension = extensionForContentType(contentType);
    const sessionDir = join(this.rootDir, sanitizePathSegment(request.sessionId));
    const fileName = `${sanitizePathSegment(String(request.toolCallId))}-${artifactId}${extension}`;
    const path = join(sessionDir, fileName);

    maybeThrowStorageFsFault({ operation: "mkdir", path: sessionDir });
    await mkdir(sessionDir, { recursive: true });
    maybeThrowStorageFsFault({ operation: "writeFile", path });
    await writeFile(path, request.content, "utf8");
    this.rememberArtifactFileName(sessionDir, artifactId, fileName);

    return {
      id: artifactId,
      uri: `zcode-artifact://${encodeURIComponent(request.sessionId)}/${encodeURIComponent(artifactId)}`,
      path,
      bytes: Buffer.byteLength(request.content, "utf8"),
      contentType,
      createdAt: new Date(),
    };
  }

  async writeToolResultBinaryArtifact(
    request: ToolBinaryArtifactWriteRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactWriteResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool binary artifact write cancelled");
    }

    const artifactId = `tool-result-${crypto.randomUUID()}`;
    const extension = normalizeArtifactExtension(
      request.extension ?? extensionForBinaryContentType(request.contentType),
    );
    const sessionDir = join(this.rootDir, sanitizePathSegment(request.sessionId));
    const fileName = `${sanitizePathSegment(String(request.toolCallId))}-${artifactId}${extension}`;
    const path = join(sessionDir, fileName);
    const content = Buffer.from(request.content);

    maybeThrowStorageFsFault({ operation: "mkdir", path: sessionDir });
    await mkdir(sessionDir, { recursive: true });
    maybeThrowStorageFsFault({ operation: "writeFile", path });
    await writeFile(path, content);
    this.rememberArtifactFileName(sessionDir, artifactId, fileName);

    return {
      id: artifactId,
      uri: `zcode-artifact://${encodeURIComponent(request.sessionId)}/${encodeURIComponent(artifactId)}`,
      path,
      bytes: content.byteLength,
      contentType: request.contentType,
      createdAt: new Date(),
    };
  }
  async readToolResultArtifact(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactReadResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact read cancelled");
    }

    const { path, contentType, bytes } = await this.readArtifactFile(request.uri);
    const content = isTextArtifactContentType(contentType)
      ? bytes.toString("utf8")
      : bytes.toString("base64");
    return {
      uri: request.uri,
      path,
      content,
      bytes: bytes.byteLength,
      contentType,
    };
  }

  /**
   * 直接读取原始字节，供 v4 分块查询和查看器使用，避免编解码改变内容。
   * contentType 仍按文件名推断，仅作兜底。
   */
  async readToolResultBinaryArtifact(
    request: ToolArtifactReadRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolBinaryArtifactReadResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact read cancelled");
    }
    const { path, contentType, bytes } = await this.readArtifactFile(request.uri);
    return { uri: request.uri, path, bytes: new Uint8Array(bytes), contentType };
  }

  /** 两条读回共用的定位 + 读文件：uri → 会话目录里含 artifactId 的那个文件。 */
  private async readArtifactFile(
    uri: string,
  ): Promise<{ path: string; contentType: string; bytes: Buffer }> {
    const { artifactId, sessionId } = parseArtifactUri(uri);
    const sessionDir = join(this.rootDir, sanitizePathSegment(sessionId));
    let fileName = await this.resolveArtifactFileName(sessionDir, artifactId, uri);
    try {
      return await this.readResolvedArtifact(sessionDir, fileName);
    } catch (error) {
      if (!isFileMissingError(error)) throw error;
      // 缓存的文件名可能已被另一个进程删除或替换；刷新一次目录再重试。
      fileName = await this.refreshArtifactFileName(sessionDir, artifactId, uri);
      return await this.readResolvedArtifact(sessionDir, fileName);
    }
  }

  async statToolResultArtifact(
    request: ToolArtifactStatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ToolArtifactStatResult> {
    if (options?.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Tool artifact stat cancelled");
    }
    const { artifactId, sessionId } = parseArtifactUri(request.uri);
    const sessionDir = join(this.rootDir, sanitizePathSegment(sessionId));
    let fileName = await this.resolveArtifactFileName(sessionDir, artifactId, request.uri);
    try {
      return await this.statResolvedArtifact(request.uri, sessionDir, fileName);
    } catch (error) {
      if (!isFileMissingError(error)) throw error;
      fileName = await this.refreshArtifactFileName(sessionDir, artifactId, request.uri);
      return await this.statResolvedArtifact(request.uri, sessionDir, fileName);
    }
  }

  private async readResolvedArtifact(
    sessionDir: string,
    fileName: string,
  ): Promise<{ path: string; contentType: string; bytes: Buffer }> {
    const path = join(sessionDir, fileName);
    return { path, contentType: contentTypeForFileName(fileName), bytes: await readFile(path) };
  }

  private async statResolvedArtifact(
    uri: string,
    sessionDir: string,
    fileName: string,
  ): Promise<ToolArtifactStatResult> {
    const path = join(sessionDir, fileName);
    const artifactStat = await stat(path);
    return {
      uri,
      bytes: artifactStat.size,
      contentType: contentTypeForFileName(fileName),
      path,
      mtimeMs: artifactStat.mtimeMs,
    };
  }

  /**
   * 目录索引只在缓存 miss 时枚举一次。目录可能被其他 CLI 进程追加，
   * 因此 miss 后必须重新枚举一次再判定 not found。
   */
  private async resolveArtifactFileName(
    sessionDir: string,
    artifactId: string,
    uri: string,
  ): Promise<string> {
    const index = await this.getArtifactDirectoryIndex(sessionDir);
    const fileName = findArtifactFileName(index, artifactId);
    if (fileName) return fileName;
    return await this.refreshArtifactFileName(sessionDir, artifactId, uri);
  }

  private async refreshArtifactFileName(
    sessionDir: string,
    artifactId: string,
    uri: string,
  ): Promise<string> {
    const index = await this.refreshArtifactDirectoryIndex(sessionDir);
    const fileName = findArtifactFileName(index, artifactId);
    if (!fileName) throw new Error(`Tool artifact not found: ${uri}`);
    return fileName;
  }

  private async getArtifactDirectoryIndex(sessionDir: string): Promise<ArtifactDirectoryIndex> {
    const cached = this.artifactDirectoryIndexes.get(sessionDir);
    if (cached) {
      // 命中即刷新 LRU 位置；delete + set 不改变缓存内容。
      this.artifactDirectoryIndexes.delete(sessionDir);
      this.artifactDirectoryIndexes.set(sessionDir, cached);
      return cached;
    }
    const inFlight = this.artifactDirectoryIndexFlights.get(sessionDir);
    if (inFlight) return inFlight;

    let flight!: Promise<ArtifactDirectoryIndex>;
    flight = this.listDirectory(sessionDir)
      .then((names) => buildArtifactDirectoryIndex(names))
      .then((index) => {
        this.storeArtifactDirectoryIndex(sessionDir, index);
        return index;
      })
      .finally(() => {
        if (this.artifactDirectoryIndexFlights.get(sessionDir) === flight) {
          this.artifactDirectoryIndexFlights.delete(sessionDir);
        }
      });
    this.artifactDirectoryIndexFlights.set(sessionDir, flight);
    return flight;
  }

  private async refreshArtifactDirectoryIndex(
    sessionDir: string,
  ): Promise<ArtifactDirectoryIndex> {
    // 先等掉在飞的旧枚举（它会写回缓存），再重新枚举覆盖；避免旧结果在新结果之后写回。
    const inFlight = this.artifactDirectoryIndexFlights.get(sessionDir);
    if (inFlight) await inFlight.catch(() => undefined);
    const index = buildArtifactDirectoryIndex(await this.listDirectory(sessionDir));
    this.storeArtifactDirectoryIndex(sessionDir, index);
    return index;
  }

  private storeArtifactDirectoryIndex(sessionDir: string, index: ArtifactDirectoryIndex): void {
    this.artifactDirectoryIndexes.delete(sessionDir);
    this.artifactDirectoryIndexes.set(sessionDir, index);
    while (this.artifactDirectoryIndexes.size > ARTIFACT_DIRECTORY_INDEX_CACHE_LIMIT) {
      const oldest = this.artifactDirectoryIndexes.keys().next().value;
      if (oldest === undefined) break;
      this.artifactDirectoryIndexes.delete(oldest);
    }
  }

  private rememberArtifactFileName(
    sessionDir: string,
    artifactId: string,
    fileName: string,
  ): void {
    const index = this.artifactDirectoryIndexes.get(sessionDir);
    // 索引还没建立时不用主动预热：下一次读取会枚举到刚写入的文件。
    if (!index) return;
    index.names.push(fileName);
    index.byArtifactId.set(artifactId, fileName);
  }

  primeImageAttachmentPath(
    request: ImageAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult> {
    return this.primeMediaAttachmentPath(request);
  }

  primeMediaAttachmentPath(
    request: MediaAttachmentPathPrimeRequest,
  ): Promise<MediaAttachmentPathResult> {
    return this.runMediaAttachmentPathFlight(request.uri, () =>
      this.writeDerivedMediaAttachment(request.uri, request.mediaType, Buffer.from(request.bytes)),
    );
  }

  ensureMediaAttachmentPath(
    request: MediaAttachmentPathEnsureRequest,
  ): Promise<MediaAttachmentPathResult> {
    return this.runMediaAttachmentPathFlight(request.uri, async () => {
      const requestedPath = derivedMediaAttachmentPath(
        this.imageCacheRootDir,
        this.pdfCacheRootDir,
        this.videoCacheRootDir,
        request.uri,
        request.mediaType,
      );
      if (!requestedPath) return { status: "unsupported" };
      if (await isRegularFile(requestedPath)) return { status: "ready", path: requestedPath };

      const artifact = await this.readToolResultArtifact({ uri: request.uri });
      const decoded = decodeMediaDataUrlArtifact(
        artifact.content,
        request.uri,
        mediaKindForContentType(request.mediaType)!,
      );
      if (mediaKindForContentType(decoded.mediaType) === "pdf" && !isPdfBytes(decoded.bytes)) {
        throw new Error(`Media attachment artifact is not a PDF: ${request.uri}`);
      }
      return this.writeDerivedMediaAttachment(request.uri, decoded.mediaType, decoded.bytes);
    });
  }

  private runMediaAttachmentPathFlight(
    uri: string,
    materialize: () => Promise<MediaAttachmentPathResult>,
  ): Promise<MediaAttachmentPathResult> {
    const inFlight = this.mediaAttachmentPathFlights.get(uri);
    if (inFlight) return inFlight;

    // paste 落盘与紧随其后的发送会并发进入物化；URI 级 singleflight
    // 保证发送等待同一写任务，不会对同一派生媒体重复落盘。
    let flight!: Promise<MediaAttachmentPathResult>;
    flight = materialize().finally(() => {
      if (this.mediaAttachmentPathFlights.get(uri) === flight) {
        this.mediaAttachmentPathFlights.delete(uri);
      }
    });
    this.mediaAttachmentPathFlights.set(uri, flight);
    return flight;
  }

  private async writeDerivedMediaAttachment(
    uri: string,
    mediaType: string,
    bytes: Buffer,
  ): Promise<MediaAttachmentPathResult> {
    const path = derivedMediaAttachmentPath(
      this.imageCacheRootDir,
      this.pdfCacheRootDir,
      this.videoCacheRootDir,
      uri,
      mediaType,
    );
    // 既有媒体处理链可接收派生缓存无法命名的格式。
    // 派生 path 是增强信息，不支持该 MIME 时应跳过，不能阻断原 media/base64 请求。
    if (!path) return { status: "unsupported" };
    if (await isRegularFile(path)) return { status: "ready", path };

    const sessionDir = dirname(path);
    const temporaryPath = `${path}.tmp-${randomUUID()}`;
    maybeThrowStorageFsFault({ operation: "mkdir", path: sessionDir });
    await mkdir(sessionDir, { recursive: true });
    try {
      maybeThrowStorageFsFault({ operation: "writeFile", path: temporaryPath });
      await writeFile(temporaryPath, bytes);
      maybeThrowStorageFsFault({ operation: "rename", path });
      await rename(temporaryPath, path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
    return { status: "ready", path };
  }
}

export function createNodeToolArtifactStore(
  options: NodeToolArtifactStoreOptions,
): ToolArtifactStorePort {
  return new NodeToolArtifactStore(options);
}

function buildArtifactDirectoryIndex(names: readonly string[]): ArtifactDirectoryIndex {
  const byArtifactId = new Map<string, string>();
  for (const name of names) {
    // 写入名是 `${toolCallId}-${artifactId}${extension}`，artifactId 固定以
    // `tool-result-` 开头；用 lastIndexOf 避免 toolCallId 里出现同名字面量。
    const marker = name.lastIndexOf("tool-result-");
    if (marker < 0) continue;
    const artifactId = name.slice(marker).replace(/\.[^.]*$/, "");
    if (!byArtifactId.has(artifactId)) byArtifactId.set(artifactId, name);
  }
  return { byArtifactId, names: [...names] };
}

function findArtifactFileName(
  index: ArtifactDirectoryIndex,
  artifactId: string,
): string | undefined {
  // 索引覆盖当前命名；旧命名或异常文件名回退到原来的 includes 语义。
  return index.byArtifactId.get(artifactId) ?? index.names.find((name) => name.includes(artifactId));
}

function isFileMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "unknown";
}

function extensionForContentType(contentType: string): string {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (mime) {
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    case "application/json":
      return ".json";
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "application/pdf":
      return ".pdf";
    default:
      return ".json";
  }
}

function extensionForBinaryContentType(contentType: string): string {
  const extension = extensionForContentType(contentType);
  return extension === ".json" && !contentType.toLowerCase().includes("json") ? ".bin" : extension;
}

function normalizeArtifactExtension(extension: string): string {
  const withDot = extension.startsWith(".") ? extension : `.${extension}`;
  const sanitized = withDot
    .replace(/[^a-zA-Z0-9.]/g, "")
    .slice(0, 16)
    .toLowerCase();
  return /^\.[a-z0-9]+$/.test(sanitized) ? sanitized : ".bin";
}

function contentTypeForFileName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".bin")) return "application/octet-stream";
  // dwf 产物按原扩展名落盘（`extension` 入参），推断表补齐它们。文本类给 text/*
  // （utf8 读回正确），办公文件与 svg 之外的未知二进制一律 octet-stream——**绝不**再让一个
  // 不认识的扩展名落到 application/json 走 utf8（那正是读回损坏的根因）。
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
  if (lower.endsWith(".csv")) return "text/csv";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  // 文本写入的默认扩展名就是 .json（extensionForContentType 的 default），所以既有文件全部
  // 落在上面的分支里；到这里的只有按原扩展名落盘的二进制产物（.xlsx / .docx / .pptx …）。
  if (lower.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

function isTextArtifactContentType(contentType: string): boolean {
  return contentType === "application/json" || contentType.startsWith("text/");
}

function isPdfBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  );
}

type DerivedMediaKind = "image" | "video" | "pdf";

function derivedMediaAttachmentPath(
  imageCacheRootDir: string,
  pdfCacheRootDir: string,
  videoCacheRootDir: string,
  uri: string,
  mediaType: string,
): string | undefined {
  const { sessionId } = parseArtifactUri(uri);
  const kind = mediaKindForContentType(mediaType);
  const extension = extensionForDerivedMediaContentType(mediaType);
  if (!kind || !extension) return undefined;
  const cacheRootDir =
    kind === "image" ? imageCacheRootDir : kind === "video" ? videoCacheRootDir : pdfCacheRootDir;
  const uriHash = createHash("sha256").update(uri).digest("hex").slice(0, 32);
  return join(cacheRootDir, sanitizePathSegment(sessionId), `${kind}-${uriHash}${extension}`);
}

function mediaKindForContentType(mediaType: string): DerivedMediaKind | undefined {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("video/")) return "video";
  if (normalized === "application/pdf") return "pdf";
  return undefined;
}

function extensionForDerivedMediaContentType(mediaType: string): string | undefined {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
  switch (normalized) {
    case "image/png":
      return ".png";
    case "image/jpeg":
    case "image/jpg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "video/mp4":
      return ".mp4";
    case "video/quicktime":
      return ".mov";
    case "video/webm":
      return ".webm";
    case "video/x-matroska":
      return ".mkv";
    case "video/x-m4v":
      return ".m4v";
    case "video/x-msvideo":
      return ".avi";
    case "application/pdf":
      return ".pdf";
    default:
      return undefined;
  }
}

function decodeMediaDataUrlArtifact(
  content: string,
  uri: string,
  expectedKind: DerivedMediaKind,
): { bytes: Buffer; mediaType: string } {
  const commaIndex = content.indexOf(",");
  const headerParts =
    content.slice(0, "data:".length).toLowerCase() === "data:" && commaIndex >= 0
      ? content.slice("data:".length, commaIndex).split(";")
      : [];
  const mediaType = headerParts.shift()?.trim();
  if (
    mediaKindForContentType(mediaType ?? "") !== expectedKind ||
    headerParts.at(-1)?.trim().toLowerCase() !== "base64" ||
    commaIndex < 0
  ) {
    throw new Error(`Media attachment artifact is not a base64 ${expectedKind} data URL: ${uri}`);
  }
  const bytes = Buffer.from(content.slice(commaIndex + 1), "base64");
  if (bytes.byteLength === 0) {
    throw new Error(`Media attachment artifact is empty: ${uri}`);
  }
  return { bytes, mediaType: mediaType! };
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function parseArtifactUri(uri: string): { artifactId: string; sessionId: string } {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (error) {
    throw new Error(`Invalid tool artifact URI: ${uri}`, {
      cause: error instanceof Error ? error : undefined,
    });
  }

  if (parsed.protocol !== "zcode-artifact:") {
    throw new Error(`Unsupported tool artifact URI: ${uri}`);
  }

  const sessionId = decodeURIComponent(parsed.hostname);
  const artifactId = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  if (!sessionId || !artifactId) {
    throw new Error(`Invalid tool artifact URI: ${uri}`);
  }

  return { artifactId, sessionId };
}
export * from "./workspace-hook-trust-store.js";
