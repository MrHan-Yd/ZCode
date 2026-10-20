import { mkdir, rm } from "node:fs/promises";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import type { ICredentialService } from "../credential/credential.js";
import { createConfigSyncBackup } from "../config-sync/backup.js";
import {
  createConfigSync,
  type ConfigSyncAdapter,
  type ConfigSyncOperations,
} from "../config-sync/orchestrator.js";
import { resolveConfigSyncScope, scopeGistDescription } from "../config-sync/scope.js";
import type { ConfigSyncDownloadPlan } from "../config-sync/types.js";
import {
  diffCuratedState,
  isCuratedStateEqual,
  mergeCuratedState,
  parseRemoteState,
  SUBAGENT_CONFIG_GIST_DESCRIPTION,
  SUBAGENT_CONFIG_PROFILE,
  SUBAGENT_CONFIG_STATE_FILE_NAME,
  SUBAGENT_WORKSPACE_CONFIG_PROFILE,
  type SubagentConfigCuratedState,
  type SubagentConfigStateChange,
} from "./subagentConfigSyncModel.js";
import {
  collectSubagentSyncSnapshot,
  countSubagentBackupItems,
  resolveSubagentAgentPath,
  resolveSubagentAgentsRoot,
  resolveSubagentSyncBackupEntries,
  resolveSubagentSyncBackupRoot,
  resolveSubagentSyncMetadataStore,
} from "./subagentConfigSyncStorage.js";
import type { SubagentStorageOptions } from "./subagentStorage.js";

/** 下载计划 + 子智能体自己的额外变更摘要（启用状态与模型覆盖）。 */
export type SubagentConfigDownloadPlan = ConfigSyncDownloadPlan & {
  readonly stateChange: SubagentConfigStateChange;
};

export interface CreateSubagentConfigSyncOptions {
  readonly storageOptions?: SubagentStorageOptions;
  /**
   * 给出即**工作区级**：条目读写成 `<workspace>/.zcode/agents`，且没有 state 额外通道
   * （工作区 agent 恒为启用）。省略即用户级。
   */
  readonly workspacePath?: string;
  readonly credentialService?: Pick<ICredentialService, "load">;
  readonly fetchImpl?: typeof fetch;
  /** 读 `agents-state.json` 的精选子集；由 `SubagentsService` 提供（含迁移与归一化）。 */
  readonly readCuratedState: () => Promise<SubagentConfigCuratedState>;
  /** 把精选子集合并写回 `agents-state.json`（保留旧版回滚字段）。调用方需保证已在写队列内。 */
  readonly writeCuratedState: (next: SubagentConfigCuratedState) => Promise<void>;
  /** 与其它写路径串行的执行器，由 `SubagentsService` 提供。 */
  readonly enqueueWrite: <T>(run: () => Promise<T>) => Promise<T>;
  readonly now?: () => number;
}

/**
 * 子智能体配置 ↔ 私有 gist 的同步：通用编排在 `config-sync/orchestrator.ts`，
 * 这里只描述「条目 = agents 根目录下的 md」「额外通道 = 用户级 state.json」这两条业务语义。
 *
 * 作用域（用户级 / 工作区级）只影响四处注入：gist description、profile（额外通道有无）、
 * 元数据分片与备份根目录、快照的读取根目录；编排层不感知作用域。
 */
export function createSubagentConfigSync(
  options: CreateSubagentConfigSyncOptions,
): ConfigSyncOperations<SubagentConfigDownloadPlan> {
  const storageOptions = options.storageOptions;
  const readCuratedState = options.readCuratedState;
  const workspacePath = options.workspacePath?.trim() || undefined;
  const scope = resolveConfigSyncScope(workspacePath);

  const parseStateContent = (content: string | undefined): SubagentConfigCuratedState | null => {
    if (!content) return null;
    try {
      return parseRemoteState(JSON.parse(content) as unknown);
    } catch {
      return null;
    }
  };

  const adapter: ConfigSyncAdapter<SubagentConfigDownloadPlan> = {
    gistDescription: scopeGistDescription(SUBAGENT_CONFIG_GIST_DESCRIPTION, scope),
    ...(scope.kind === "workspace" ? { scopeLabel: scope.label } : {}),
    profile: workspacePath ? SUBAGENT_WORKSPACE_CONFIG_PROFILE : SUBAGENT_CONFIG_PROFILE,
    metadata: resolveSubagentSyncMetadataStore(workspacePath),
    backup: createConfigSyncBackup({
      rootDir: () => resolveSubagentSyncBackupRoot(workspacePath),
      entries: resolveSubagentSyncBackupEntries(workspacePath, storageOptions),
    }),
    collectSnapshot: () =>
      collectSubagentSyncSnapshot(workspacePath, storageOptions, readCuratedState),
    countBackupItems: countSubagentBackupItems,

    async apply({ writes, removals, remoteExtras, strategy }) {
      const agentsRoot = await resolveSubagentAgentsRoot(workspacePath, storageOptions);
      await mkdir(agentsRoot, { recursive: true });
      for (const write of writes) {
        await atomicWriteText(resolveSubagentAgentPath(agentsRoot, write.name), write.content);
      }
      for (const name of removals) {
        await rm(resolveSubagentAgentPath(agentsRoot, name), { force: true });
      }
      // 工作区级的 profile 没有额外通道，远端 extras 为空、这里自然跳过 state。
      const remoteState = parseStateContent(remoteExtras.get(SUBAGENT_CONFIG_STATE_FILE_NAME));
      // 远端 state 一定存在（否则 parseRemoteFiles 会拒绝），这里的判断只是类型收窄。
      if (remoteState) {
        const localState = await readCuratedState();
        const nextState =
          strategy === "replace" ? remoteState : mergeCuratedState(localState, remoteState);
        // 合并结果与本地等价时跳过写盘，避免只改了 md 的场景多写一次 state。
        if (!isCuratedStateEqual(nextState, localState)) {
          await options.writeCuratedState(nextState);
        }
      }
    },

    decoratePlan(plan, { local, remoteExtras }) {
      const remoteState = parseStateContent(remoteExtras.get(SUBAGENT_CONFIG_STATE_FILE_NAME));
      const localState = parseStateContent(
        local.extras.find((extra) => extra.fileName === SUBAGENT_CONFIG_STATE_FILE_NAME)?.content,
      );
      return {
        ...plan,
        stateChange:
          remoteState && localState
            ? diffCuratedState(localState, remoteState)
            : { disabledAdded: [], disabledRemoved: [], overrideKeysChanged: [] },
      };
    },
  };

  return createConfigSync({
    adapter,
    credentialService: options.credentialService,
    fetchImpl: options.fetchImpl,
    enqueueWrite: options.enqueueWrite,
    ...(options.now ? { now: options.now } : {}),
  });
}
