/**
 * 配置同步（GitHub 私有 gist）的通用契约：子智能体与 MCP 服务器共用同一套形状。
 *
 * 每个功能提供自己的「条目」语义（子智能体 = 一个 md 文件，MCP = 一个 server 配置对象）
 * 与可选「额外通道」（子智能体的 agents-state.json），核心只负责快照、校验、指纹、上传下载与回滚。
 */

/** 同步失败的分类；UI 按 code 选本地化文案，message 只作技术细节。 */
export type ConfigSyncErrorCode =
  | "not_authenticated"
  | "unauthorized"
  | "insufficient_scope"
  | "not_found"
  | "rate_limited"
  | "network"
  | "timeout"
  | "remote_invalid"
  | "too_large"
  | "local_invalid"
  | "conflict"
  | "busy"
  | "secret_warning"
  | "unknown";

export interface ConfigSyncSecretWarning {
  /** 命中所在文件名。 */
  readonly fileName: string;
  /** 1 起的行号。 */
  readonly line: number;
  /** 规则名，**不含命中值**。 */
  readonly pattern: string;
}

export interface ConfigSyncError {
  readonly code: ConfigSyncErrorCode;
  /** 技术细节；不含 token、不含文件内容、不含命中值。 */
  readonly message: string;
  /** 仅 `secret_warning` 时给。 */
  readonly secretWarnings?: readonly ConfigSyncSecretWarning[];
}

export type ConfigSyncResult<T> = T | { readonly status: "error"; readonly error: ConfigSyncError };

/** 一个参与同步的条目：名称是稳定身份，content 是它的完整文本。 */
export interface ConfigSyncItem {
  readonly name: string;
  readonly content: string;
}

/** 额外通道：随同条目一起上传/下载、但不参与按名 diff 的文件（如 agents-state.json）。 */
export interface ConfigSyncExtra {
  readonly fileName: string;
  readonly content: string;
}

export interface ConfigSyncSnapshot {
  readonly items: readonly ConfigSyncItem[];
  readonly extras: readonly ConfigSyncExtra[];
  /** 本机存在但未纳入同步的文件，用于状态展示（如子智能体子目录里的 md）。 */
  readonly skippedLocalFiles: readonly string[];
}

/**
 * 功能适配器：把「远端文件名映射、内容校验」与「读写本机事实」交给各功能，核心不感知业务语义。
 */
export interface ConfigSyncProfile {
  /** 名称 → 远端文件名；返回 null 表示该名称无法安全映射（调用方报 local_invalid）。 */
  fileNameFor(name: string): string | null;
  /** 远端文件名 → 名称；返回 null 表示不是本功能的条目文件。 */
  nameFromFileName(fileName: string): string | null;
  /** 内容能否被本功能加载：上传侧拦坏文件，下载侧拦坏远端内容。 */
  isValidContent(fileName: string, content: string): boolean;
  /**
   * 额外通道的内容能否被本功能加载；缺省只校验 sha256、不校验语义。
   * 远端额外通道语义非法时，下载侧要在这里拦下来（报 `remote_invalid`），
   * 否则问题会推迟到写盘阶段才暴露，错误码只能退化成 `unknown`。
   */
  isValidExtraContent?(fileName: string, content: string): boolean;
  /** 额外通道的文件名；这些文件参与完整性校验，内容语义由功能自己解释。 */
  readonly extraFileNames: readonly string[];
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
}

export interface ConfigSyncManifestItem {
  readonly name: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ConfigSyncManifestExtra {
  readonly fileName: string;
  readonly sha256: string;
}

export interface ConfigSyncManifest {
  readonly schemaVersion: number;
  readonly revision: number;
  readonly updatedAt: string;
  readonly items: readonly ConfigSyncManifestItem[];
  readonly extras: readonly ConfigSyncManifestExtra[];
}

export interface ConfigSyncSkippedRemoteFile {
  readonly fileName: string;
  readonly reason: "unknown_file" | "invalid";
}

export type ConfigSyncPlanEntryKind = "add" | "update" | "same" | "localOnly";

export interface ConfigSyncPlanEntry {
  readonly name: string;
  readonly kind: ConfigSyncPlanEntryKind;
}

export interface ConfigSyncDownloadPlan {
  /** 固定为 `ok`：让三个同步操作的返回值都能用 `result.status === "error"` 统一判别。 */
  readonly status: "ok";
  readonly remoteRevision: number;
  readonly remoteUpdatedAt: string;
  readonly gistIdShort: string;
  readonly gistUrl: string;
  readonly entries: readonly ConfigSyncPlanEntry[];
  /** 本地自上次同步后被改过：应用会覆盖这些本地修改。 */
  readonly localChangedSinceLastSync: boolean;
  readonly remoteSkipped: readonly ConfigSyncSkippedRemoteFile[];
}

/** 一份本地备份的目录与时间（核心层只认这些，不感知业务条目）。 */
export interface ConfigSyncBackupDir {
  readonly backupDir: string;
  readonly createdAt: number;
}

export interface ConfigSyncBackupDirList {
  readonly backupRoot: string;
  /** 新的在前。 */
  readonly backups: readonly ConfigSyncBackupDir[];
}

/** 展示用备份：附带条目数（无法统计时为 null）。 */
export interface ConfigSyncBackupInfo extends ConfigSyncBackupDir {
  readonly itemCount: number | null;
}

export interface ConfigSyncBackupList {
  /** 备份根目录（落在数据存储路径下，界面上直接展示给用户）。 */
  readonly backupRoot: string;
  /** 新的在前。 */
  readonly backups: readonly ConfigSyncBackupInfo[];
}

export interface ConfigSyncRestoreResult {
  /** 固定为 `ok`：让结果都能用 `result.status === "error"` 统一判别。 */
  readonly status: "ok";
  /** 已还原的备份目录。 */
  readonly backupDir: string;
  /** 还原前对「当前状态」做的安全备份；还原错了可以再还原回来。 */
  readonly safetyBackupDir: string;
  readonly itemCount: number | null;
}

export interface ConfigSyncStatus {
  /** 凭据库里是否存在 token（不代表 token 有效）。 */
  readonly connected: boolean;
  readonly gistIdShort?: string;
  readonly gistUrl?: string;
  readonly lastRemoteRevision?: number;
  readonly lastSyncedAt?: number;
  readonly localItemCount: number;
  readonly localFingerprint: string;
  readonly localChangedSinceLastSync: boolean;
  readonly skippedLocalFiles: readonly string[];
  /** 本地可用备份份数（>0 时界面才提供「从备份还原」）。 */
  readonly backupCount: number;
}

export interface ConfigSyncUploadResult {
  readonly status: "ok" | "unchanged";
  readonly gistIdShort: string;
  readonly gistUrl: string;
  readonly remoteRevision: number;
  readonly itemCount: number;
}

export interface ConfigSyncDownloadResult {
  readonly status: "ok" | "up_to_date";
  readonly applied: {
    readonly added: number;
    readonly updated: number;
    readonly removed: number;
    readonly kept: number;
  };
  readonly remoteRevision: number;
  /** 应用前备份目录；`up_to_date` 时不产生备份。 */
  readonly backupDir?: string;
}

export type ConfigSyncRemoteParseResult =
  | {
      readonly status: "ok";
      readonly manifest: ConfigSyncManifest;
      readonly items: readonly ConfigSyncItem[];
      readonly extras: ReadonlyMap<string, string>;
      readonly skipped: readonly ConfigSyncSkippedRemoteFile[];
    }
  | {
      readonly status: "invalid" | "too_large";
      readonly message: string;
    };

export interface ConfigSyncMetadata {
  readonly schemaVersion: number;
  readonly gistId?: string;
  readonly lastRemoteRevision?: number;
  readonly lastLocalFingerprint?: string;
  readonly lastSyncedAt?: number;
}
