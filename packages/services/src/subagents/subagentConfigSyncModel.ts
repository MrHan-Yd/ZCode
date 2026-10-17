import {
  modelSelectionSchema,
  parsePluginSubagentModelSelectionOverrides,
  type BuiltInSubagentModelSelectionOverrides,
  type PluginSubagentModelSelectionOverrides,
} from "@zcode/shared";
import { z } from "zod";
import type { ConfigSyncProfile } from "../config-sync/types.js";
import { parseSubagentMarkdown } from "./subagentMarkdown.js";

/**
 * 子智能体侧的同步语义：远端文件名映射、内容可加载性判定，以及 `agents-state.json` 的精选子集。
 * 通用部分（manifest / 指纹 / 计划 / 密钥扫描）在 `config-sync/` 里。
 */

/** 私有 gist 的固定 description：只用于「本机没有 gistId」时的一次性发现。 */
export const SUBAGENT_CONFIG_GIST_DESCRIPTION = "zcode-subagents-config-sync";
export const SUBAGENT_CONFIG_STATE_FILE_NAME = "state.json";
const AGENT_FILE_PREFIX = "agent.";
const AGENT_FILE_SUFFIX = ".md";

/** `agents-state.json` 的同步子集：旧版回滚字段（builtInModelOverrides 等）不进快照。 */
export interface SubagentConfigCuratedState {
  readonly disabledAgentIds: readonly string[];
  readonly builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  readonly pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
}

export interface SubagentConfigStateChange {
  readonly disabledAdded: readonly string[];
  readonly disabledRemoved: readonly string[];
  readonly overrideKeysChanged: readonly string[];
}

const stateSchema = z
  .object({
    disabledAgentIds: z.array(z.string().trim().min(1)).default([]),
    builtInModelSelectionOverrides: z.record(z.string(), modelSelectionSchema).default({}),
    pluginAgentModelSelectionOverrides: z.record(z.string(), modelSelectionSchema).default({}),
  })
  .strict();

/**
 * agent 身份 ↔ gist 文件名。名字里不允许出现路径分隔符或控制字符：gist 文件名是扁平的，
 * 带路径语义的名字在下载侧无法安全还原。
 */
export function agentFileName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed !== name) return null;
  // eslint-disable-next-line no-control-regex
  if (/[/\\\u0000-\u001f\u007f]/u.test(trimmed)) return null;
  return `${AGENT_FILE_PREFIX}${trimmed}${AGENT_FILE_SUFFIX}`;
}

export function agentNameFromFileName(fileName: string): string | null {
  if (!fileName.startsWith(AGENT_FILE_PREFIX) || !fileName.endsWith(AGENT_FILE_SUFFIX)) return null;
  const name = fileName.slice(AGENT_FILE_PREFIX.length, -AGENT_FILE_SUFFIX.length);
  return agentFileName(name) === fileName ? name : null;
}

/** 只保留三个精选字段；旧版回滚字段（builtInModelOverrides / builtInThoughtLevelOverrides）必须丢弃。 */
export function pickCuratedState(state: {
  disabledAgentIds?: readonly string[];
  builtInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides?: PluginSubagentModelSelectionOverrides;
}): SubagentConfigCuratedState {
  return {
    disabledAgentIds: [...(state.disabledAgentIds ?? [])]
      .filter((id) => id.trim().length > 0)
      .sort(),
    builtInModelSelectionOverrides: { ...state.builtInModelSelectionOverrides },
    pluginAgentModelSelectionOverrides: parsePluginSubagentModelSelectionOverrides(
      state.pluginAgentModelSelectionOverrides,
    ),
  };
}

export function parseRemoteState(input: unknown): SubagentConfigCuratedState | null {
  const parsed = stateSchema.safeParse(input);
  if (!parsed.success) return null;
  return pickCuratedState(parsed.data);
}

export function serializeCuratedState(state: SubagentConfigCuratedState): string {
  const canonical = canonicalState(state);
  return `${JSON.stringify(
    {
      disabledAgentIds: canonical.disabledAgentIds,
      builtInModelSelectionOverrides: canonical.builtInModelSelectionOverrides,
      pluginAgentModelSelectionOverrides: canonical.pluginAgentModelSelectionOverrides,
    },
    null,
    2,
  )}\n`;
}

/** merge：远端键覆盖本地同名键，本地独有键保留（并集）。 */
export function mergeCuratedState(
  local: SubagentConfigCuratedState,
  remote: SubagentConfigCuratedState,
): SubagentConfigCuratedState {
  return {
    disabledAgentIds: [...new Set([...local.disabledAgentIds, ...remote.disabledAgentIds])].sort(),
    builtInModelSelectionOverrides: {
      ...local.builtInModelSelectionOverrides,
      ...remote.builtInModelSelectionOverrides,
    },
    pluginAgentModelSelectionOverrides: {
      ...local.pluginAgentModelSelectionOverrides,
      ...remote.pluginAgentModelSelectionOverrides,
    },
  };
}

export function diffCuratedState(
  local: SubagentConfigCuratedState,
  remote: SubagentConfigCuratedState,
): SubagentConfigStateChange {
  const localDisabled = new Set(local.disabledAgentIds);
  const remoteDisabled = new Set(remote.disabledAgentIds);
  const localOverrides = overrideFingerprints(local);
  const remoteOverrides = overrideFingerprints(remote);
  const keys = [...new Set([...localOverrides.keys(), ...remoteOverrides.keys()])].sort();
  return {
    disabledAdded: [...remoteDisabled].filter((id) => !localDisabled.has(id)).sort(),
    disabledRemoved: [...localDisabled].filter((id) => !remoteDisabled.has(id)).sort(),
    overrideKeysChanged: keys.filter((key) => localOverrides.get(key) !== remoteOverrides.get(key)),
  };
}

/** 判断两份精选 state 是否等价（用于跳过无意义的写盘）。 */
export function isCuratedStateEqual(
  left: SubagentConfigCuratedState,
  right: SubagentConfigCuratedState,
): boolean {
  const leftOverrides = overrideFingerprints(left);
  const rightOverrides = overrideFingerprints(right);
  if (leftOverrides.size !== rightOverrides.size) return false;
  for (const [key, value] of leftOverrides) {
    if (rightOverrides.get(key) !== value) return false;
  }
  return (
    [...left.disabledAgentIds].sort().join("\u0000") ===
    [...right.disabledAgentIds].sort().join("\u0000")
  );
}

/**
 * 上传/下载两侧共用的「这个 md 能否被子智能体加载器读出来」判定：
 * 上传侧用它拦坏文件（`local_invalid`），下载侧用它拦坏远端内容（`remote_invalid`）。
 */
export function isParsableSubagentMarkdown(fileName: string, content: string): boolean {
  return parseSubagentMarkdown({ content, path: fileName, scope: "user" }).agent !== undefined;
}

export const SUBAGENT_CONFIG_PROFILE: ConfigSyncProfile = {
  fileNameFor: agentFileName,
  nameFromFileName: agentNameFromFileName,
  isValidContent: isParsableSubagentMarkdown,
  extraFileNames: [SUBAGENT_CONFIG_STATE_FILE_NAME],
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};

function canonicalState(state: SubagentConfigCuratedState): SubagentConfigCuratedState {
  const sortedRecord = <T>(record: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
  return {
    disabledAgentIds: [...state.disabledAgentIds].sort(),
    builtInModelSelectionOverrides: sortedRecord(state.builtInModelSelectionOverrides),
    pluginAgentModelSelectionOverrides: sortedRecord(state.pluginAgentModelSelectionOverrides),
  };
}

function overrideFingerprints(state: SubagentConfigCuratedState): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, selection] of Object.entries(state.builtInModelSelectionOverrides)) {
    result.set(`built-in:${key}`, selectionFingerprint(selection));
  }
  for (const [key, selection] of Object.entries(state.pluginAgentModelSelectionOverrides)) {
    result.set(`plugin:${key}`, selectionFingerprint(selection));
  }
  return result;
}

function selectionFingerprint(selection: {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string };
}): string {
  return [selection.providerId, selection.modelId, selection.options?.reasoningLevel ?? ""].join(
    "\u0000",
  );
}
