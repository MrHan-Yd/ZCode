import type {
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  McpSyncCandidateListResult,
  McpSyncExportResult,
  McpSyncExportedServer,
  McpSyncImportResult,
  McpSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
  SaveCliMcpToUserDirectoryRequest,
  ZCodeAgentMcpServer,
  ZCodeMcpListMode,
  ZCodeMcpListResult,
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

export interface IMcpSyncService {
  loadMcpFromUserDirectory(
    request?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult>;
  /**
   * workspace MCP server 运行态状态列表（原 UI 直调 zcodeAgentService 的
   * mcp/list）。真实 connect/listTools 检查必须发生在 agent 进程（PATH/cwd 是
   * workspace 环境），本服务只是 UI 的注入面——mcp/list 词的 host 消费收拢到实现一处。
   */
  listWorkspaceMcpServerStatuses(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    mcpServers?: ZCodeAgentMcpServer[];
    mode?: ZCodeMcpListMode;
  }): Promise<ZCodeMcpListResult>;
  saveMcpToUserDirectory(payload: SaveCliMcpToUserDirectoryRequest): Promise<void>;
  listLocalUserMcpCandidates(): Promise<McpSyncCandidateListResult>;
  listRemoteUserMcpStatuses(params: { names: string[] }): Promise<McpSyncRemoteStatusResult>;
  exportMcpServers(params: { serverIds: string[] }): Promise<McpSyncExportResult>;
  checkRemoteUserMcpWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importMcpServers(params: {
    servers: McpSyncExportedServer[];
    localHomeDir: string;
    localWorkspacePath?: string;
    remoteWorkspacePath?: string;
    overwrite?: false;
  }): Promise<McpSyncImportResult>;

  /** 列出本地备份（新的在前，含备份目录路径与条目数）；只读、不联网。 */
  listConfigSyncBackups(): Promise<ConfigSyncBackupList>;

  /**
   * 从指定备份整份还原本地配置（不是合并）。`backupDir` 必须来自 `listConfigSyncBackups`；
   * 还原前会先给当前状态做一份安全备份，还原出错时可再还原回来。
   */
  restoreConfigSyncBackup(params: {
    backupDir: string;
  }): Promise<ConfigSyncResult<ConfigSyncRestoreResult>>;

  /** 只读本机同步状态与元数据（gistId / 上次同步时间 / 本地是否变化）；不联网。 */
  getConfigSyncStatus(): Promise<ConfigSyncStatus>;

  /**
   * 把用户级 MCP server 配置上传到当前登录 GitHub 账号的私有 gist。
   * 本地内容与上次成功上传一致时不发网络请求；命中疑似密钥时先返回 `secret_warning`，
   * 由 UI 确认后带 `confirmSecretUpload` 重调。
   */
  syncConfigToGist(params?: {
    confirmSecretUpload?: boolean;
  }): Promise<ConfigSyncResult<ConfigSyncUploadResult>>;

  /** 只读远端与本地快照产出下载计划；不写任何文件。 */
  previewConfigFromGist(): Promise<ConfigSyncResult<ConfigSyncDownloadPlan>>;

  /**
   * 应用下载计划。`merge` 只覆盖远端存在的同名 server、保留本地独有项；
   * `replace` 镜像远端并删除本地独有项，必须带 `confirmReplace: true`。
   */
  applyConfigFromGist(params: {
    strategy: "merge" | "replace";
    expectedRemoteRevision: number;
    confirmReplace?: boolean;
  }): Promise<ConfigSyncResult<ConfigSyncDownloadResult>>;
}

export const IMcpSyncService = createServiceDescriptor<IMcpSyncService>(ServiceChannels.McpSync);
