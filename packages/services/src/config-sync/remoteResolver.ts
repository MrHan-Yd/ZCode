import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { readGistRevision, type GistClient, type RemoteGist } from "./gistClient.js";
import { CONFIG_SYNC_MANIFEST_FILE_NAME, parseRemoteFiles } from "./manifest.js";
import type { ReadConfigSyncMetadata } from "./metadata.js";
import type {
  ConfigSyncError,
  ConfigSyncMetadata,
  ConfigSyncProfile,
  ConfigSyncRemoteParseResult,
} from "./types.js";

const log = createServiceLogger("configSync");

export type ParsedRemoteGist = Extract<ConfigSyncRemoteParseResult, { status: "ok" }>;

export interface ConfigSyncRemoteResolver {
  /** 上传侧：gistId 失效（404）时返回 null 让调用方新建，其它错误原样上抛。 */
  resolveUploadTarget(
    token: string,
    metadata: ConfigSyncMetadata,
  ): Promise<{ gist: RemoteGist | null; revision: number } | { error: ConfigSyncError }>;
  /** 下载侧：取回并校验远端内容；gist 不存在或内容非法都返回错误。 */
  resolveDownloadSource(
    token: string,
  ): Promise<{ gist: RemoteGist; parsed: ParsedRemoteGist } | { error: ConfigSyncError }>;
}

/**
 * 远端定位与校验：本机元数据里的 gistId 是权威，没有才按 description 发现一次。
 *
 * 发现走列表接口，而列表的 `files` 只给文件名、不含 `content`，所以发现之后必须再 GET 一次单条 gist：
 * 否则读不到 manifest（revision 会被误判为 0），也拿不到任何 md 内容。
 */
export function createRemoteResolver(options: {
  readonly client: GistClient;
  readonly gistDescription: string;
  readonly profile: ConfigSyncProfile;
  readonly readMetadata: ReadConfigSyncMetadata;
}): ConfigSyncRemoteResolver {
  const { client } = options;

  const discoverFullGist = async (
    token: string,
  ): Promise<{ gist: RemoteGist | null } | { error: ConfigSyncError }> => {
    const listed = await client.listGists(token);
    if (!listed.ok) return { error: listed.error };
    const match = listed.value.find(
      (candidate) =>
        candidate.description === options.gistDescription &&
        CONFIG_SYNC_MANIFEST_FILE_NAME in candidate.files,
    );
    if (!match) return { gist: null };
    const full = await client.fetchGist(token, match.id);
    if (!full.ok) return { error: full.error };
    return { gist: full.value };
  };

  return {
    async resolveUploadTarget(token, metadata) {
      if (metadata.gistId) {
        const existing = await client.fetchGist(token, metadata.gistId);
        if (existing.ok) {
          return { gist: existing.value, revision: readGistRevision(existing.value) };
        }
        if (existing.error.code !== "not_found") return { error: existing.error };
        log.warn(undefined, "subagent config gist missing, recreating");
      }
      const discovered = await discoverFullGist(token);
      if ("error" in discovered) return { error: discovered.error };
      if (discovered.gist) {
        return { gist: discovered.gist, revision: readGistRevision(discovered.gist) };
      }
      return { gist: null, revision: 0 };
    },

    async resolveDownloadSource(token) {
      const metadata = await options.readMetadata();
      let resolved: { ok: true; value: RemoteGist } | { ok: false; error: ConfigSyncError };
      if (metadata.gistId) {
        resolved = await client.fetchGist(token, metadata.gistId);
      } else {
        const discovered = await discoverFullGist(token);
        if ("error" in discovered) return { error: discovered.error };
        if (!discovered.gist) return { error: { code: "not_found", message: "no gist found" } };
        resolved = { ok: true, value: discovered.gist };
      }
      if (!resolved.ok) return { error: resolved.error };
      const parsed = parseRemoteFiles(options.profile, resolved.value.files);
      if (parsed.status !== "ok") {
        return {
          error: {
            code: parsed.status === "too_large" ? "too_large" : "remote_invalid",
            message: parsed.message,
          },
        };
      }
      return { gist: resolved.value, parsed };
    },
  };
}
