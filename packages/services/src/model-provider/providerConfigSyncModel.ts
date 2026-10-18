import {
  ApiKeyAccessConfig,
  isApiKeyAccess,
  ModelConfigRules,
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  ProviderConfig,
  type ModelConfigRule,
  type ProviderConfigObject,
  type ProviderConfigRule,
} from "@zcode/provider";
import { modelSelectionSchema, type ModelSelection } from "@zcode/shared/model-selection";
import { z } from "zod";
import { canonicalJson } from "../config-sync/manifest.js";
import type { ConfigSyncProfile } from "../config-sync/types.js";

/**
 * 模型设置（个人 Provider 配置层）侧的同步语义：文件名映射、内容可加载性判定、
 * `settings.json` 额外通道，以及「API Key 永不出网、下载时补回本机 Key」这条规则。
 * 通用部分（manifest / 指纹 / 计划 / 密钥扫描）在 `config-sync/` 里。
 */

/** 私有 gist 的固定 description：只用于「本机没有 gistId」时的一次性发现。 */
export const PROVIDER_CONFIG_GIST_DESCRIPTION = "zcode-provider-config-sync";
export const PROVIDER_CONFIG_SETTINGS_FILE_NAME = "settings.json";
const PROVIDER_FILE_PREFIX = "provider.";
const PROVIDER_FILE_SUFFIX = ".json";

/**
 * providerId 通常是 `[a-z0-9-]`，但内置/账号 Provider 的个人覆盖可能是 `account:xxx`，
 * 而 `:` 在 Windows 文件名里非法；`% \ / `、`:` 与控制字符一并转义，其余（含中文）原样保留以便在 gist 里可读。
 */
// eslint-disable-next-line no-control-regex -- 控制字符正是要转义的对象
const UNSAFE_NAME_CHARS = /[%\\/\u0000-\u001f\u007f:]/gu;

function encodeProviderName(name: string): string {
  return name.replace(UNSAFE_NAME_CHARS, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `%${code.toString(16).padStart(2, "0")}`;
  });
}

function decodeProviderName(encoded: string): string | null {
  if (!encoded.includes("%")) return encoded;
  try {
    const decoded = decodeURIComponent(encoded);
    // 只有「再编码后与原文完全一致」才算合法，避免把用户手写的 %xx 当成转义。
    return encodeProviderName(decoded) === encoded ? decoded : null;
  } catch {
    return null;
  }
}

export function providerFileName(name: string): string | null {
  const encoded = encodeProviderName(name);
  return encoded.length > 0 ? `${PROVIDER_FILE_PREFIX}${encoded}${PROVIDER_FILE_SUFFIX}` : null;
}

export function providerNameFromFileName(fileName: string): string | null {
  if (!fileName.startsWith(PROVIDER_FILE_PREFIX) || !fileName.endsWith(PROVIDER_FILE_SUFFIX)) {
    return null;
  }
  const encoded = fileName.slice(PROVIDER_FILE_PREFIX.length, -PROVIDER_FILE_SUFFIX.length);
  return decodeProviderName(encoded);
}

/**
 * 剥离 API Key：私有 gist 不是加密存储，凭据不进远端。
 * 只摘掉 `access.apiKey`，`access.type` / `apiKeyManagementUrl` 等其余配置参数照常同步。
 */
export function stripProviderApiKey(config: ProviderConfigObject): ProviderConfigObject {
  const access = config.access;
  if (!access || !isApiKeyAccess(access)) return config;
  const { apiKey: _apiKey, ...rest } = access;
  return { ...config, access: rest };
}

/** 条目内容 = 规范化后的个人 Provider 规则（已剥离 apiKey），保证往返一致与指纹稳定。 */
export function providerItemContent(rule: ProviderConfigRule): string {
  return canonicalJson({
    providerId: rule.providerId,
    templateId: rule.templateId,
    providerName: rule.providerName,
    enabled: rule.enabled,
    config: stripProviderApiKey(rule.config.toJSON()),
  });
}

/** 上传侧拦坏文件、下载侧拦坏远端内容：必须能被个人 Provider 规则 schema 加载。 */
export function parseProviderItemContent(content: string): ProviderConfigRule | null {
  try {
    const parsed = parsePersonalProviderConfigMap({
      providerRules: [JSON.parse(content) as unknown],
    });
    return parsed.rules()[0] ?? null;
  } catch {
    return null;
  }
}

/** `settings.json`：随条目一起上传/下载、但不参与按名 diff 的个人层其余配置参数。 */
export interface ProviderConfigSettings {
  readonly providerOrder: readonly string[];
  readonly modelConfigRules: ModelConfigRules;
  readonly defaultModelSelection?: ModelSelection;
}

const settingsSchema = z
  .object({
    providerOrder: z.array(z.string().trim().min(1)).default([]),
    modelConfigRules: z.unknown(),
    defaultModelSelection: modelSelectionSchema.optional(),
  })
  .strict();

export function serializeProviderSettings(input: {
  readonly providerOrder?: readonly string[];
  readonly models: ModelConfigRules;
  readonly defaultModelSelection?: ModelSelection;
}): string {
  return canonicalJson({
    providerOrder: [...(input.providerOrder ?? [])],
    modelConfigRules: input.models.toPersonalJSON(),
    defaultModelSelection: input.defaultModelSelection,
  });
}

export function parseProviderSettings(content: string | undefined): ProviderConfigSettings | null {
  if (!content) return null;
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return null;
  }
  const parsed = settingsSchema.safeParse(json);
  if (!parsed.success) return null;
  let modelConfigRules: ModelConfigRules;
  try {
    modelConfigRules = parsePersonalModelConfigRules(parsed.data.modelConfigRules);
  } catch {
    return null;
  }
  return {
    providerOrder: parsed.data.providerOrder,
    modelConfigRules,
    ...(parsed.data.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: parsed.data.defaultModelSelection }),
  };
}

/**
 * 把本机已有的 API Key 补回即将写盘的配置。
 *
 * 条目内容刻意不含 apiKey（它从不参与同步），所以「镜像远端」也不能顺带清空本机凭据：
 * 只有同一 providerId 且 access 类型一致时才补回，类型被远端改掉或本机本来没有 Key 时保持远端结果。
 */
export function restoreLocalApiKey(
  config: ProviderConfig,
  localConfig: ProviderConfig | undefined,
): ProviderConfig {
  const localAccess = localConfig?.access;
  if (!localAccess || !isApiKeyAccess(localAccess)) return config;
  const remoteAccess = config.access;
  if (!remoteAccess || !isApiKeyAccess(remoteAccess) || remoteAccess.type !== localAccess.type) {
    return config;
  }
  if (localAccess.apiKey === undefined) return config;
  return config.overlay(
    new ProviderConfig({
      access: new ApiKeyAccessConfig({ type: localAccess.type, apiKey: localAccess.apiKey }),
    }),
  );
}

/** 供应商顺序的稳定合并：远端顺序在前，本地独有项按本地顺序追加。 */
export function mergeProviderOrder(
  local: readonly string[],
  remote: readonly string[],
): readonly string[] {
  const remoteIds = new Set(remote);
  return [...remote, ...local.filter((providerId) => !remoteIds.has(providerId))];
}

/** 个人层只承载精确规则；正则/接口/站点/模板规则不属于个人配置层（由读取 schema 保证）。 */
type PersonalModelRule = Extract<
  ModelConfigRule,
  { readonly type: "provider-model" | "manual-provider-model" }
>;

function isPersonalModelRule(rule: ModelConfigRule): rule is PersonalModelRule {
  return rule.type === "provider-model" || rule.type === "manual-provider-model";
}

/**
 * 个人精确模型规则的合并：按 `(providerId, modelId)` 覆盖，远端同键胜出，本机独有键保留。
 *
 * 刻意不复用 `mergeModelConfigRules`：那是**纯拼接**，服务于「builtin 层 + modelSmart 层」这种互不相交的层。
 * 本机个人层与远端个人层可能含同键，拼接会同时踩两个坑：
 * 1. 非幂等——每次「下载(merge)」都再追加一遍远端规则，配置文件持续膨胀；
 * 2. 可能产出「同一 Provider/Model 既是智能规则又是手动规则」的非法组合，
 *    被 `personalModelConfigRulesSchema` 拒绝后整次写入失败（`toPersonalJSON` 在落盘前抛错）。
 * 键唯一性由 Map 保证，因此结果必然能被个人规则 schema 接受。
 */
export function mergePersonalModelRules(
  local: ModelConfigRules,
  remote: ModelConfigRules,
): ModelConfigRules {
  const byKey = new Map<string, PersonalModelRule>();
  const collect = (rules: readonly ModelConfigRule[]): void => {
    for (const rule of rules) {
      if (!isPersonalModelRule(rule)) continue;
      // 同键覆盖（含跨「智能 / 手动」类型）：同一 Provider/Model 只允许留下一条规则。
      byKey.set(`${rule.providerId}\u0000${rule.modelId}`, rule);
    }
  };
  collect(local.rules());
  collect(remote.rules());
  return new ModelConfigRules([...byKey.values()]);
}

export const PROVIDER_CONFIG_PROFILE: ConfigSyncProfile = {
  fileNameFor: providerFileName,
  nameFromFileName: providerNameFromFileName,
  isValidContent: (_fileName, content) => parseProviderItemContent(content) !== null,
  // 额外通道的 sha256 由核心校验，语义由这里校验：远端 settings.json 非法必须在预览阶段就报
  // `remote_invalid`，不能拖到写盘阶段才失败（那时错误码只剩 `unknown`）。
  isValidExtraContent: (fileName, content) =>
    fileName === PROVIDER_CONFIG_SETTINGS_FILE_NAME && parseProviderSettings(content) !== null,
  extraFileNames: [PROVIDER_CONFIG_SETTINGS_FILE_NAME],
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};
