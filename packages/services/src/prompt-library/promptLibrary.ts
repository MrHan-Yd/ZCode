import type {
  PromptLibraryWarning,
  PromptTemplate,
  PromptTemplateSummary,
  PromptTemplateInput,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import type {
  ConfigSyncBackupList,
  ConfigSyncDownloadPlan,
  ConfigSyncDownloadResult,
  ConfigSyncRestoreResult,
  ConfigSyncResult,
  ConfigSyncStatus,
  ConfigSyncUploadResult,
} from "../config-sync/types.js";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 提示词库服务契约（browser-safe）。
 *
 * 预期失败通过可序列化 result union 返回，只有传输/进程级失败才抛异常；
 * 这样 renderer 经 RPC 代理调用时不会丢失失败原因。
 */
export type PromptLibraryFailureReason =
  | "invalid-title"
  | "invalid-content"
  | "invalid-tags"
  | "invalid-alias"
  | "alias-conflict"
  | "too-many-items"
  | "not-found"
  | "conflict"
  | "unsupported-version"
  | "corrupt"
  | "io-error";

export type { PromptLibraryWarning };

export interface PromptLibraryListResult {
  items: PromptTemplateSummary[];
  warning: PromptLibraryWarning | null;
  readOnly: boolean;
}

export type PromptLibraryGetResult =
  | { ok: true; item: PromptTemplate }
  | { ok: false; reason: PromptLibraryFailureReason; message?: string };

export type PromptLibraryMutationResult =
  | { ok: true; item: PromptTemplate }
  | {
      ok: false;
      reason: PromptLibraryFailureReason;
      message?: string;
      current?: PromptTemplateSummary;
    };

export type PromptLibraryRemoveResult =
  | { ok: true }
  | { ok: false; reason: PromptLibraryFailureReason; message?: string };

export type PromptLibraryResetResult = PromptLibraryRemoveResult;

export type { PromptTemplateInput };

export interface IPromptLibraryService {
  list(): Promise<PromptLibraryListResult>;
  get(params: { id: string }): Promise<PromptLibraryGetResult>;
  create(params: PromptTemplateInput): Promise<PromptLibraryMutationResult>;
  update(
    params: PromptTemplateInput & { id: string; expectedUpdatedAt?: number },
  ): Promise<PromptLibraryMutationResult>;
  /** 幂等：未知 id 视为成功。 */
  remove(params: { id: string }): Promise<PromptLibraryRemoveResult>;
  setPinned(params: { id: string; pinned: boolean }): Promise<PromptLibraryMutationResult>;
  /** best-effort；失败不影响插入。 */
  recordUsage(params: { id: string }): Promise<void>;
  /** 损坏恢复：先备份当前文件，再写入空 v1。 */
  reset(): Promise<PromptLibraryResetResult>;
  // 以下同步方法可选：旧 Host / 测试替身可不实现，UI 用 typeof fn === "function" 判断。
  getSyncStatus?(): Promise<ConfigSyncStatus>;
  uploadToGithub?(params?: {
    confirmSecretUpload?: boolean;
  }): Promise<ConfigSyncResult<ConfigSyncUploadResult>>;
  previewDownload?(): Promise<ConfigSyncResult<ConfigSyncDownloadPlan>>;
  applyDownload?(params: {
    strategy: "merge" | "replace";
    expectedRemoteRevision: number;
    confirmReplace?: boolean;
  }): Promise<ConfigSyncResult<ConfigSyncDownloadResult>>;
  listSyncBackups?(): Promise<ConfigSyncBackupList>;
  restoreSyncBackup?(params: {
    backupDir: string;
  }): Promise<ConfigSyncResult<ConfigSyncRestoreResult>>;
}

export const IPromptLibraryService = createServiceDescriptor<IPromptLibraryService>(
  ServiceChannels.PromptLibrary,
);
