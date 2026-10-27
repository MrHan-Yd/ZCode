import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ProviderConfigMap,
  type ProviderConfigLayerSnapshot,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import { PERSONAL_PROVIDER_CONFIG_FILE_NAME, decodeProviderConfigFile } from "@zcode/provider-node";
import type { CredentialServiceAccess } from "../credential/credential.js";
import { createConfigSyncBackup } from "../config-sync/backup.js";
import { createConfigSyncMetadataStore } from "../config-sync/metadata.js";
import {
  createConfigSync,
  type ConfigSyncAdapter,
  type ConfigSyncOperations,
} from "../config-sync/orchestrator.js";
import type { ConfigSyncItem, ConfigSyncSnapshot } from "../config-sync/types.js";
import { getAppConfigDir } from "../paths.js";
import {
  mergePersonalModelRules,
  mergeProviderOrder,
  parseProviderItemContent,
  parseProviderSettings,
  providerItemContent,
  PROVIDER_CONFIG_GIST_DESCRIPTION,
  PROVIDER_CONFIG_PROFILE,
  PROVIDER_CONFIG_SETTINGS_FILE_NAME,
  restoreLocalApiKey,
  serializeProviderSettings,
} from "./providerConfigSyncModel.js";

/**
 * 模型设置（个人 Provider 配置层）↔ 私有 gist 的同步：通用编排在 `config-sync/orchestrator.ts`，
 * 这里只描述「条目 = 一个个人 Provider 规则」「额外通道 = providerOrder / modelConfigRules /
 * defaultModelSelection」这两条业务语义。
 *
 * 读写端口由 `ProviderRuntime` 注入（`PersonalProviderConfigRepository` 才是个人配置的唯一所有者）。
 * API Key 永不进快照：上传前剥离、下载后补回本机已有值（见 `providerConfigSyncModel`）。
 */

export interface CreateProviderConfigSyncOptions {
  /** 读本机个人配置层快照（含 providerRules / providerOrder / modelConfigRules / defaultModelSelection）。 */
  readonly readLayer: () => Promise<ProviderConfigLayerSnapshot>;
  /** 在仓库文件锁内读-改-写个人配置层；与设置页的编辑共用同一条写入路径。 */
  readonly updateLayer: (
    transform: (current: ProviderConfigLayerSnapshot) => ProviderConfigLayerUpdate,
  ) => Promise<ProviderConfigLayerSnapshot>;
  /** 个人配置文件绝对路径（备份对象）。 */
  readonly userConfigPath: () => Promise<string>;
  /** 同步元数据与备份的目录；缺省用设置里的数据存储路径（`{dataBaseDir}/.zcode/v2`）。 */
  readonly dataDir?: () => Promise<string>;
  readonly credentialService?: CredentialServiceAccess;
  readonly fetchImpl?: typeof fetch;
  readonly enqueueWrite: <T>(run: () => Promise<T>) => Promise<T>;
  readonly now?: () => number;
}

export function createProviderConfigSync(
  options: CreateProviderConfigSyncOptions,
): ConfigSyncOperations {
  // 元数据与备份跟随设置里的数据存储路径（`{dataBaseDir}/.zcode/v2`），与配置文件同目录。
  const dataDir = options.dataDir ?? (async () => getAppConfigDir());
  const adapter: ConfigSyncAdapter = {
    gistDescription: PROVIDER_CONFIG_GIST_DESCRIPTION,
    profile: PROVIDER_CONFIG_PROFILE,
    metadata: createConfigSyncMetadataStore(async () =>
      join(await dataDir(), "provider-config-sync.json"),
    ),
    backup: createConfigSyncBackup({
      rootDir: async () => join(await dataDir(), "provider-config-sync-backup"),
      entries: async () => [
        { source: await options.userConfigPath(), name: PERSONAL_PROVIDER_CONFIG_FILE_NAME },
      ],
    }),
    collectSnapshot: () => collectProviderSnapshot(options.readLayer),
    countBackupItems: countProviderBackupItems,

    // 个人配置的唯一写入路径是 `PersonalProviderConfigRepository.update`（文件锁 + 原子写 + 落盘前校验）。
    // 还原不能直接拷文件：那样既绕过锁，也会把「备份内容非法」直接写成生效配置。
    async restoreFromBackup(backupDir) {
      try {
        const raw = await readFile(join(backupDir, PERSONAL_PROVIDER_CONFIG_FILE_NAME), "utf-8");
        const layer = decodeProviderConfigFile(JSON.parse(raw) as unknown);
        await options.updateLayer(() => layer);
        return true;
      } catch {
        // 备份读不出来或内容非法：保持本地不变，由编排层报「还原失败」。
        return false;
      }
    },

    async apply({ removals, remoteItems, remoteExtras, strategy }) {
      const settings = parseProviderSettings(remoteExtras.get(PROVIDER_CONFIG_SETTINGS_FILE_NAME));
      // 远端 settings.json 解析不了就整体拒绝：写入非法个人配置会让读取端整份降级为空配置。
      if (!settings) throw new Error("远端 settings.json 无法解析");
      const remoteProviders = parseRemoteProviderMap(remoteItems);

      await options.updateLayer((current) => {
        const base = strategy === "merge" ? current.providers : ProviderConfigMap.empty();
        const overlaid = base.overlay(remoteProviders);
        // 条目内容不含 apiKey；任何策略都要把本机已有 Key 补回来，不能因「镜像远端」清空凭据。
        let providers = overlaid.mapConfigs((config, providerId) =>
          restoreLocalApiKey(config, current.providers.get(providerId)),
        );
        for (const providerId of removals) {
          providers = providers.delete(providerId);
        }
        return {
          providers,
          models:
            strategy === "merge"
              ? mergePersonalModelRules(current.models, settings.modelConfigRules)
              : settings.modelConfigRules,
          providerOrder:
            strategy === "merge"
              ? mergeProviderOrder(current.providerOrder ?? [], settings.providerOrder)
              : settings.providerOrder,
          // 远端没有默认选择时保留本机现值：下载不应顺带清掉用户的默认模型选择。
          defaultModelSelection: settings.defaultModelSelection ?? current.defaultModelSelection,
        };
      });
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

/** 统计一份备份里的 Provider 规则数（备份里是整份 provider_config.json）。 */
async function countProviderBackupItems(backupDir: string): Promise<number | null> {
  try {
    const raw = await readFile(join(backupDir, PERSONAL_PROVIDER_CONFIG_FILE_NAME), "utf-8");
    const parsed = JSON.parse(raw) as {
      config?: { providerConfigRules?: { providerRules?: unknown } };
    };
    const rules = parsed.config?.providerConfigRules?.providerRules;
    return Array.isArray(rules) ? rules.length : null;
  } catch {
    return null;
  }
}

async function collectProviderSnapshot(
  readLayer: () => Promise<ProviderConfigLayerSnapshot>,
): Promise<ConfigSyncSnapshot> {
  const snapshot = await readLayer();
  const items: ConfigSyncItem[] = snapshot.providers
    .rules()
    .map((rule) => ({ name: rule.providerId, content: providerItemContent(rule) }));
  items.sort((left, right) => left.name.localeCompare(right.name));
  return {
    items,
    extras: [
      {
        fileName: PROVIDER_CONFIG_SETTINGS_FILE_NAME,
        content: serializeProviderSettings({
          providerOrder: snapshot.providerOrder,
          models: snapshot.models,
          defaultModelSelection: snapshot.defaultModelSelection,
        }),
      },
    ],
    skippedLocalFiles: [],
  };
}

/** 远端全部条目 → 个人 Provider 映射；任一条目无法加载即整体失败，由调用方中止本次写入。 */
function parseRemoteProviderMap(items: readonly ConfigSyncItem[]): ProviderConfigMap {
  return new ProviderConfigMap(
    items.map((item) => {
      const rule = parseProviderItemContent(item.content);
      if (!rule) throw new Error(`远端条目无法解析：${item.name}`);
      return rule;
    }),
  );
}
