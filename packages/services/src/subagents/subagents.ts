import type {
  ZCodeProvider,
  AgentSummary,
  AgentsListResult,
  AgentCreateParams,
  AgentUpdateParams,
  AgentDeleteParams,
  BuiltInSubagentModelOverrideParams,
  PluginSubagentModelOverrideParams,
  SubagentsListMode,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  ConfigSyncBackupList,
  ConfigSyncDownloadResult,
  ConfigSyncRestoreResult,
  ConfigSyncResult,
  ConfigSyncStatus,
  ConfigSyncUploadResult,
} from "../config-sync/types.js";
import type { SubagentConfigDownloadPlan } from "./subagentConfigSync.js";

export interface ISubagentsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    mode?: SubagentsListMode;
  }): Promise<AgentsListResult>;

  setEnabled(params: { agentId: string; enabled: boolean }): Promise<void>;

  setBuiltInModelOverride(params: BuiltInSubagentModelOverrideParams): Promise<void>;

  /** 只写用户 state 的完整覆盖，不改插件 Markdown。 */
  setPluginAgentModelOverride(params: PluginSubagentModelOverrideParams): Promise<void>;

  /** 当前筛选来源对应的用户级 agent 根目录（与内置扫描顺序一致，取 buildUserRoots 的首项）。 */
  getPrimaryUserAgentsDirectory(params: { provider: ZCodeProvider }): Promise<{ path: string }>;

  /** 创建新的 agent 文件 */
  createAgent(params: AgentCreateParams): Promise<{ agent: AgentSummary }>;

  /** 更新现有 agent 文件 */
  updateAgent(params: AgentUpdateParams): Promise<{ agent: AgentSummary }>;

  /** 删除 agent 文件 */
  deleteAgent(params: AgentDeleteParams): Promise<void>;

  /** 列出本地备份（新的在前，含备份目录路径与条目数）；只读、不联网。按作用域分开。 */
  listConfigSyncBackups(params?: {
    workspacePath?: string;
  }): Promise<ConfigSyncBackupList>;

  /**
   * 从指定备份整份还原本地配置（不是合并）。`backupDir` 必须来自 `listConfigSyncBackups`；
   * 还原前会先给当前状态做一份安全备份，还原出错时可再还原回来。
   */
  restoreConfigSyncBackup(params: {
    backupDir: string;
    workspacePath?: string;
  }): Promise<ConfigSyncResult<ConfigSyncRestoreResult>>;

  /** 只读本机同步状态与元数据（gistId / 上次同步时间 / 本地是否变化）；不联网。 */
  getConfigSyncStatus(params?: { workspacePath?: string }): Promise<ConfigSyncStatus>;

  /**
   * 把子智能体配置上传到当前登录 GitHub 账号的私有 gist。
   * 本地内容与上次成功上传一致时不发网络请求；命中疑似密钥时先返回 `secret_warning`，
   * 由 UI 确认后带 `confirmSecretUpload` 重调。
   *
   * 省略 `workspacePath` 即用户级；给出即工作区级（同步该项目的 `<workspace>/.zcode/agents`，
   * 远端 gist 按项目目录名区分，且没有 state 额外通道）。
   */
  syncConfigToGist(params?: {
    confirmSecretUpload?: boolean;
    workspacePath?: string;
  }): Promise<ConfigSyncResult<ConfigSyncUploadResult>>;

  /** 只读远端与本地快照产出下载计划；不写任何文件。 */
  previewConfigFromGist(params?: {
    workspacePath?: string;
  }): Promise<ConfigSyncResult<SubagentConfigDownloadPlan>>;

  /**
   * 应用下载计划。`merge` 只覆盖远端存在的同名 agent、保留本地独有项；
   * `replace` 镜像远端并删除本地独有项，必须带 `confirmReplace: true`。
   */
  applyConfigFromGist(params: {
    strategy: "merge" | "replace";
    expectedRemoteRevision: number;
    confirmReplace?: boolean;
    workspacePath?: string;
  }): Promise<ConfigSyncResult<ConfigSyncDownloadResult>>;
}

export const ISubagentsService = createServiceDescriptor<ISubagentsService>(
  ServiceChannels.Subagents,
);
