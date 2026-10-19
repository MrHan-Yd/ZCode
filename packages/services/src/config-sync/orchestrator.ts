import { describeRequestError } from "#src/http/describeRequestError.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { ICredentialService } from "../credential/credential.js";
import { GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY } from "../github/githubAuth.js";
import { isKnownBackupDir, type ConfigSyncBackup } from "./backup.js";
import { createGistClient, gistHtmlUrl } from "./gistClient.js";
import { buildRemoteFiles, computeFingerprint, findOversizedItem } from "./manifest.js";
import type { ConfigSyncMetadataStore } from "./metadata.js";
import { buildPlan, resolveApplySet } from "./plan.js";
import { createRemoteResolver } from "./remoteResolver.js";
import { scanSecrets } from "./secretScan.js";
import type {
  ConfigSyncBackupList,
  ConfigSyncDownloadPlan,
  ConfigSyncDownloadResult,
  ConfigSyncError,
  ConfigSyncItem,
  ConfigSyncProfile,
  ConfigSyncResult,
  ConfigSyncRestoreResult,
  ConfigSyncSnapshot,
  ConfigSyncStatus,
  ConfigSyncUploadResult,
} from "./types.js";

const log = createServiceLogger("configSync");

/**
 * 一个功能的同步适配器：核心只认「条目 + 额外通道 + profile + 读写端口」，
 * 业务语义（子智能体的 md/state、MCP 的 server 配置）留在各自功能里。
 */
export interface ConfigSyncAdapter<TPlan extends ConfigSyncDownloadPlan = ConfigSyncDownloadPlan> {
  /** 私有 gist 的固定 description：只用于「本机没有 gistId」时的一次性发现。 */
  readonly gistDescription: string;
  readonly profile: ConfigSyncProfile;
  readonly metadata: ConfigSyncMetadataStore;
  readonly backup: ConfigSyncBackup;
  /** 读本机快照（条目 + 额外通道 + 未纳入同步的文件）。 */
  collectSnapshot(): Promise<ConfigSyncSnapshot>;
  /** 写盘：由核心在写队列内、备份完成后调用；额外通道的合并语义由功能决定。 */
  apply(params: {
    readonly writes: readonly ConfigSyncItem[];
    readonly removals: readonly string[];
    /** 远端全部条目（含 `same`）：整份重写本机配置的功能需要它，逐文件写盘的功能可忽略。 */
    readonly remoteItems: readonly ConfigSyncItem[];
    readonly local: ConfigSyncSnapshot;
    readonly remoteExtras: ReadonlyMap<string, string>;
    readonly strategy: "merge" | "replace";
  }): Promise<void>;
  /** 统计一份备份里的条目数，供还原界面区分备份；读不出来返回 null。 */
  countBackupItems(backupDir: string): Promise<number | null>;
  /**
   * 用功能自己的写入路径整份还原备份，返回是否成功。
   * 缺省由核心直接 `cp` 备份文件覆盖目标；当功能的唯一写入路径带锁 / 原子写 / 落盘前校验时
   * （如个人 Provider 配置必须经 `PersonalProviderConfigRepository.update`），应实现它，
   * 否则还原会绕过这些约束。
   */
  restoreFromBackup?(backupDir: string): Promise<boolean>;
  /** 计划装饰：功能补自己的额外变更摘要（子智能体：启用状态与模型覆盖）。 */
  decoratePlan?(
    plan: ConfigSyncDownloadPlan,
    context: {
      readonly local: ConfigSyncSnapshot;
      readonly remoteExtras: ReadonlyMap<string, string>;
    },
  ): TPlan;
}

export interface ConfigSyncOperations<
  TPlan extends ConfigSyncDownloadPlan = ConfigSyncDownloadPlan,
> {
  getStatus(): Promise<ConfigSyncStatus>;
  /** 列出本地备份（新的在前）；只读、不联网、不参与单飞。 */
  listBackups(): Promise<ConfigSyncBackupList>;
  /** 从指定备份整份还原本地配置；还原前会先给当前状态做一份安全备份。 */
  restore(params: { backupDir: string }): Promise<ConfigSyncResult<ConfigSyncRestoreResult>>;
  upload(params?: {
    confirmSecretUpload?: boolean;
  }): Promise<ConfigSyncResult<ConfigSyncUploadResult>>;
  preview(): Promise<ConfigSyncResult<TPlan>>;
  apply(params: {
    strategy: "merge" | "replace";
    expectedRemoteRevision: number;
    confirmReplace?: boolean;
  }): Promise<ConfigSyncResult<ConfigSyncDownloadResult>>;
}

export interface CreateConfigSyncOptions<
  TPlan extends ConfigSyncDownloadPlan = ConfigSyncDownloadPlan,
> {
  readonly adapter: ConfigSyncAdapter<TPlan>;
  /** 凭据读取端口；缺省时同步方法一律返回 `not_authenticated`。 */
  readonly credentialService?: Pick<ICredentialService, "load">;
  /** 必须注入 host 的代理感知传输（`hostApiNetworkTransport.fetch`）；缺省用全局 fetch。 */
  readonly fetchImpl?: typeof fetch;
  /** 与其它写路径串行的执行器，由所属服务提供。 */
  readonly enqueueWrite: <T>(run: () => Promise<T>) => Promise<T>;
  readonly now?: () => number;
}

/**
 * 配置 ↔ 私有 gist 的同步编排：单飞、凭据、快照、校验、上传/预览/应用与备份回滚。
 *
 * 不持有长期状态：持久事实只有本机同步元数据与远端 gist 本身。token 按需从凭据库读取，
 * 只存在于本次调用的函数栈内，不进返回值、不进日志。
 */
export function createConfigSync<TPlan extends ConfigSyncDownloadPlan = ConfigSyncDownloadPlan>(
  options: CreateConfigSyncOptions<TPlan>,
): ConfigSyncOperations<TPlan> {
  const { adapter } = options;
  const now = options.now ?? Date.now;
  const gist = createGistClient(options.fetchImpl ?? globalThis.fetch);
  const remote = createRemoteResolver({
    client: gist,
    gistDescription: adapter.gistDescription,
    profile: adapter.profile,
    readMetadata: adapter.metadata.read,
  });
  // 单飞：并发点击 / 多窗口下只允许一个同步操作在跑，不排队、不用超时掩盖。
  let inFlight: "upload" | "preview" | "apply" | "restore" | null = null;

  const withSingleFlight = async <T>(
    kind: "upload" | "preview" | "apply" | "restore",
    run: () => Promise<ConfigSyncResult<T>>,
  ): Promise<ConfigSyncResult<T>> => {
    if (inFlight) {
      log.debug(undefined, "config sync busy", { kind, inFlight });
      return fail("busy", "已有同步操作在进行中");
    }
    inFlight = kind;
    try {
      return await run();
    } finally {
      inFlight = null;
    }
  };

  const loadToken = async (): Promise<string | null> => {
    if (!options.credentialService) return null;
    const token =
      (await options.credentialService.load(GITHUB_ACCESS_TOKEN_CREDENTIAL_KEY))?.trim() ?? "";
    return token.length > 0 ? token : null;
  };

  const fingerprintOf = (snapshot: ConfigSyncSnapshot): string =>
    computeFingerprint(snapshot.items, snapshot.extras);

  const getStatus = async (): Promise<ConfigSyncStatus> => {
    const [metadata, token, snapshot, backups] = await Promise.all([
      adapter.metadata.read(),
      loadToken(),
      adapter.collectSnapshot(),
      adapter.backup.list(),
    ]);
    const localFingerprint = fingerprintOf(snapshot);
    return {
      connected: token !== null,
      ...(metadata.gistId ? { gistIdShort: metadata.gistId.slice(0, 8) } : {}),
      ...(metadata.gistId ? { gistUrl: gistHtmlUrl(metadata.gistId) } : {}),
      ...(metadata.lastRemoteRevision !== undefined
        ? { lastRemoteRevision: metadata.lastRemoteRevision }
        : {}),
      ...(metadata.lastSyncedAt !== undefined ? { lastSyncedAt: metadata.lastSyncedAt } : {}),
      localItemCount: snapshot.items.length,
      localFingerprint,
      localChangedSinceLastSync:
        metadata.lastLocalFingerprint !== undefined &&
        metadata.lastLocalFingerprint !== localFingerprint,
      skippedLocalFiles: snapshot.skippedLocalFiles,
      backupCount: backups.backups.length,
    };
  };

  const listBackups = async (): Promise<ConfigSyncBackupList> => {
    const { backupRoot, backups } = await adapter.backup.list();
    return {
      backupRoot,
      backups: await Promise.all(
        backups.map(async (entry) => ({
          ...entry,
          itemCount: await adapter.countBackupItems(entry.backupDir),
        })),
      ),
    };
  };

  const restore = async (params: {
    backupDir: string;
  }): Promise<ConfigSyncResult<ConfigSyncRestoreResult>> =>
    withSingleFlight("restore", async () => {
      // 只接受真实存在的完整备份，杜绝把任意路径当备份拷到本地配置上。
      if (!(await isKnownBackupDir(adapter.backup, params.backupDir))) {
        return fail("unknown", "指定的备份不存在或已不完整");
      }
      const itemCount = await adapter.countBackupItems(params.backupDir);
      return options.enqueueWrite(async () => {
        // 先给「当前状态」也备份一份：还原错了还能再还原回来。
        let safetyBackupDir: string;
        try {
          safetyBackupDir = await adapter.backup.create();
        } catch (error) {
          return fail("unknown", `备份当前配置失败，未做还原：${describeRequestError(error)}`);
        }
        // 功能实现了自己的还原路径时优先用它：直接拷文件会绕过功能的锁与落盘前校验。
        const restored = adapter.restoreFromBackup
          ? await adapter.restoreFromBackup(params.backupDir)
          : await adapter.backup.restore(params.backupDir);
        if (!restored) {
          return fail(
            "unknown",
            `还原失败，当前配置可能处于中间状态（还原前备份在 ${safetyBackupDir}）`,
          );
        }
        // 刻意不动同步元数据：还原后本地与上次同步不一致，状态行会如实显示「本地有未上传的修改」。
        log.info(undefined, "config restored from backup", { itemCount });
        return { status: "ok", backupDir: params.backupDir, safetyBackupDir, itemCount };
      });
    });

  const upload = async (params?: {
    confirmSecretUpload?: boolean;
  }): Promise<ConfigSyncResult<ConfigSyncUploadResult>> =>
    withSingleFlight("upload", async () => {
      const token = await loadToken();
      if (!token) return fail("not_authenticated", "未登录");

      const snapshot = await adapter.collectSnapshot();
      const unparsable = snapshot.items.find(
        (item) =>
          !adapter.profile.isValidContent(
            adapter.profile.fileNameFor(item.name) ?? item.name,
            item.content,
          ),
      );
      if (unparsable) return fail("local_invalid", unparsable.name);
      const oversized = findOversizedItem(adapter.profile, snapshot.items);
      if (oversized) return fail("too_large", oversized);

      const fingerprint = fingerprintOf(snapshot);
      const metadata = await adapter.metadata.read();
      if (metadata.gistId && metadata.lastLocalFingerprint === fingerprint) {
        // 内容与上次成功上传时一致：不发任何网络请求。
        return {
          status: "unchanged",
          gistIdShort: metadata.gistId.slice(0, 8),
          gistUrl: gistHtmlUrl(metadata.gistId),
          remoteRevision: metadata.lastRemoteRevision ?? 0,
          itemCount: snapshot.items.length,
        };
      }

      if (!params?.confirmSecretUpload) {
        const warnings = snapshot.items.flatMap((item) =>
          scanSecrets(adapter.profile.fileNameFor(item.name) ?? item.name, item.content),
        );
        if (warnings.length > 0) {
          // 私有 gist 不是加密存储：命中疑似密钥先让用户确认，且只回文件名 / 行号 / 规则名。
          return {
            status: "error",
            error: {
              code: "secret_warning",
              message: `${warnings.length} 处疑似密钥`,
              secretWarnings: warnings,
            },
          };
        }
      }

      const target = await remote.resolveUploadTarget(token, metadata);
      if ("error" in target) return { status: "error", error: target.error };
      const revision = target.revision + 1;
      const built = buildRemoteFiles(adapter.profile, {
        items: snapshot.items,
        extras: snapshot.extras,
        revision,
        updatedAt: new Date(now()).toISOString(),
        previousFileNames: Object.keys(target.gist?.files ?? {}),
      });
      if (!built) return fail("local_invalid", "本地名称无法映射到 gist 文件名");

      const written = target.gist
        ? await gist.patchGist(token, target.gist.id, built.files)
        : await gist.createGist(token, adapter.gistDescription, built.files);
      if (!written.ok) return { status: "error", error: written.error };

      await adapter.metadata.write({
        gistId: written.value.id,
        lastRemoteRevision: revision,
        lastLocalFingerprint: fingerprint,
        lastSyncedAt: now(),
      });
      log.info(undefined, "config uploaded", {
        gistId: written.value.id.slice(0, 8),
        items: snapshot.items.length,
        revision,
      });
      return {
        status: "ok",
        gistIdShort: written.value.id.slice(0, 8),
        gistUrl: written.value.htmlUrl,
        remoteRevision: revision,
        itemCount: snapshot.items.length,
      };
    });

  const preview = async (): Promise<ConfigSyncResult<TPlan>> =>
    withSingleFlight("preview", async () => {
      const token = await loadToken();
      if (!token) return fail("not_authenticated", "未登录");
      const source = await remote.resolveDownloadSource(token);
      if ("error" in source) return { status: "error", error: source.error };
      const [snapshot, metadata] = await Promise.all([
        adapter.collectSnapshot(),
        adapter.metadata.read(),
      ]);
      const plan = buildPlan({
        localItems: snapshot.items,
        remoteItems: source.parsed.items,
        localFingerprint: fingerprintOf(snapshot),
        manifest: source.parsed.manifest,
        gistId: source.gist.id,
        gistUrl: source.gist.htmlUrl,
        skipped: source.parsed.skipped,
        lastLocalFingerprint: metadata.lastLocalFingerprint,
      });
      return adapter.decoratePlan
        ? adapter.decoratePlan(plan, { local: snapshot, remoteExtras: source.parsed.extras })
        : (plan as TPlan);
    });

  const apply = async (params: {
    strategy: "merge" | "replace";
    expectedRemoteRevision: number;
    confirmReplace?: boolean;
  }): Promise<ConfigSyncResult<ConfigSyncDownloadResult>> => {
    if (params.strategy === "replace" && params.confirmReplace !== true) {
      return fail("unknown", "镜像下载会删除本地独有的条目，需要显式确认");
    }
    return withSingleFlight("apply", async () => {
      const token = await loadToken();
      if (!token) return fail("not_authenticated", "未登录");
      const source = await remote.resolveDownloadSource(token);
      if ("error" in source) return { status: "error", error: source.error };
      const { manifest, items: remoteItems, extras: remoteExtras } = source.parsed;
      if (manifest.revision !== params.expectedRemoteRevision) {
        return fail(
          "conflict",
          `expected revision ${params.expectedRemoteRevision}, remote ${manifest.revision}`,
        );
      }

      return options.enqueueWrite(async () => {
        // 队列内重算：预览之后本地可能又被改过，写入内容必须来自最新本地状态。
        const snapshot = await adapter.collectSnapshot();
        const plan = buildPlan({
          localItems: snapshot.items,
          remoteItems,
          localFingerprint: fingerprintOf(snapshot),
          manifest,
          gistId: source.gist.id,
          gistUrl: source.gist.htmlUrl,
          skipped: source.parsed.skipped,
        });
        const { writes, added, updated, removals, kept } = resolveApplySet({
          entries: plan.entries,
          remoteItems,
          strategy: params.strategy,
        });
        if (
          writes.length === 0 &&
          removals.length === 0 &&
          !extrasNeedWrite(snapshot, remoteExtras)
        ) {
          return {
            status: "up_to_date",
            applied: { added: 0, updated: 0, removed: 0, kept },
            remoteRevision: manifest.revision,
          };
        }

        let backupDir: string;
        try {
          backupDir = await adapter.backup.create();
        } catch (error) {
          // 备份失败就不动本地：宁可本次失败，也不要出现「改了一半、无法回滚」。
          return fail("unknown", `备份失败：${describeRequestError(error)}`);
        }

        try {
          await adapter.apply({
            writes,
            removals,
            remoteItems,
            local: snapshot,
            remoteExtras,
            strategy: params.strategy,
          });
          const after = await adapter.collectSnapshot();
          await adapter.metadata.write({
            gistId: source.gist.id,
            lastRemoteRevision: manifest.revision,
            lastLocalFingerprint: fingerprintOf(after),
            lastSyncedAt: now(),
          });
        } catch (error) {
          const detail = describeRequestError(error);
          const restored = await adapter.backup.restore(backupDir);
          log.warn(undefined, "config apply failed", { detail, restored });
          return fail(
            "unknown",
            restored ? `${detail}（已回滚）` : `${detail}（备份在 ${backupDir}）`,
          );
        }

        log.info(undefined, "config applied", {
          gistId: source.gist.id.slice(0, 8),
          added,
          updated,
          removed: removals.length,
          strategy: params.strategy,
          revision: manifest.revision,
        });
        return {
          status: "ok",
          applied: { added, updated, removed: removals.length, kept },
          remoteRevision: manifest.revision,
          backupDir,
        };
      });
    });
  };

  return { getStatus, listBackups, restore, upload, preview, apply };
}

/**
 * 额外通道是否需要写盘：远端内容与本地不同 ⇒ 应用后本地一定会被改写
 * （merge 取并集、replace 整份替换，两者都不会等于原本地内容）。
 */
function extrasNeedWrite(
  local: ConfigSyncSnapshot,
  remoteExtras: ReadonlyMap<string, string>,
): boolean {
  if (remoteExtras.size === 0) return false;
  const localByName = new Map(local.extras.map((extra) => [extra.fileName, extra.content]));
  for (const [fileName, content] of remoteExtras) {
    if (localByName.get(fileName) !== content) return true;
  }
  return false;
}

function fail(
  code: ConfigSyncError["code"],
  message: string,
): { status: "error"; error: ConfigSyncError } {
  return { status: "error", error: { code, message } };
}
