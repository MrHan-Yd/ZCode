import type {
  SkillSyncArchiveExportResult,
  SkillSyncCandidateListResult,
  SkillSyncImportResult,
  SkillSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
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

export interface ISkillSyncService {
  listLocalUserSkillCandidates(): Promise<SkillSyncCandidateListResult>;
  listRemoteUserSkillStatuses(params: {
    directoryNames: string[];
    skills?: Array<{
      directoryName: string;
      name: string;
    }>;
  }): Promise<SkillSyncRemoteStatusResult>;
  exportSkillsArchive(params: { skillIds: string[] }): Promise<SkillSyncArchiveExportResult>;
  checkRemoteUserSkillWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importSkillsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<SkillSyncImportResult>;

  /**
   * 技能目录 ↔ GitHub 私有 gist。作用域与 MCP 一致：省略 `workspacePath` 即用户级，
   * 给出即工作区级（读写该项目的 `<workspace>/.zcode/skills`）。
   */
  listConfigSyncBackups(params?: { workspacePath?: string }): Promise<ConfigSyncBackupList>;
  restoreConfigSyncBackup(params: {
    backupDir: string;
    workspacePath?: string;
  }): Promise<ConfigSyncResult<ConfigSyncRestoreResult>>;
  getConfigSyncStatus(params?: { workspacePath?: string }): Promise<ConfigSyncStatus>;
  syncConfigToGist(params?: {
    confirmSecretUpload?: boolean;
    workspacePath?: string;
  }): Promise<ConfigSyncResult<ConfigSyncUploadResult>>;
  previewConfigFromGist(params?: {
    workspacePath?: string;
  }): Promise<ConfigSyncResult<ConfigSyncDownloadPlan>>;
  applyConfigFromGist(params: {
    strategy: "merge" | "replace";
    expectedRemoteRevision: number;
    confirmReplace?: boolean;
    workspacePath?: string;
  }): Promise<ConfigSyncResult<ConfigSyncDownloadResult>>;
}

export const ISkillSyncService = createServiceDescriptor<ISkillSyncService>(
  ServiceChannels.SkillSync,
);
