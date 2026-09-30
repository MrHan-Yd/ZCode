/**
 * 官方版遗留账号态清理。
 *
 * 本二开版本已经下线所有账号登录入口（见 specs/login-entry-retirement.md），
 * 但安装包与官方版共用同一 appId / userData / 数据根 `~/.zcode/v2`，
 * 所以官方版迁移过来的用户会把 OAuth 凭据与 providerFamilyDomain 一起带进来，
 * 落到「入口已下线、状态还在」的错位状态：启动恢复成已登录、登出后无法登回来、
 * 套餐徽标与升级入口仍按 zai/bigmodel 语义工作。
 *
 * 这里在启动链路最早处清掉账号运营态，让迁移用户直接落到「用自定义供应商」的干净状态。
 *
 * 注意：本模块假定当前版本不提供账号登录。**若将来重新开放账号登录，必须同时删除本模块**，
 * 否则每次启动都会把刚登录的凭据清掉。
 */
import type { IServiceAccessor } from "@zcode/services";
import {
  DesktopCommandIds,
  type AppSettings,
  type IPlatformService,
  type OAuthProviderId,
  type ProviderFamilyDomain,
} from "@zcode/shared";
import { logger } from "@/logger.js";

type AccountStateServices = Pick<IServiceAccessor, "oauthService" | "settingService">;

interface LegacyAccountRetirementDeps {
  services: AccountStateServices;
  platform: Pick<IPlatformService, "executeDesktopCommand">;
}

interface LegacyAccountRetirementOutcome {
  readonly retired: boolean;
  readonly activeProvider: OAuthProviderId | null;
  readonly hadProviderFamilyDomain: boolean;
}

/**
 * 只要有残留的 OAuth 会话或 provider 运行域，就说明存在需要清理的账号态。
 * providerFamilyDomain 为空字符串等价于未设置（handleLogout 就是写 `""`）。
 */
export function shouldRetireLegacyAccountState(params: {
  activeOAuthProvider: OAuthProviderId | null;
  providerFamilyDomain: ProviderFamilyDomain | "" | null | undefined;
}): boolean {
  return Boolean(params.activeOAuthProvider) || Boolean(params.providerFamilyDomain);
}

export async function retireLegacyAccountState(
  params: LegacyAccountRetirementDeps,
): Promise<LegacyAccountRetirementOutcome> {
  const [activeProvider, settings] = await Promise.all([
    params.services.oauthService.getActiveProvider(),
    params.services.settingService.get(),
  ]);
  const providerFamilyDomain = settings.providerFamilyDomain;

  if (
    !shouldRetireLegacyAccountState({
      activeOAuthProvider: activeProvider,
      providerFamilyDomain,
    })
  ) {
    return { retired: false, activeProvider: null, hadProviderFamilyDomain: false };
  }

  // 复用 handleLogout 的清理语义（oauthService.clearActiveSession + 清共享 zcodejwttoken +
  // 派生 Coding/Start provider 清理），不另造一套字段清单。
  await params.services.oauthService.logout();
  await params.services.settingService.update({
    providerFamilyDomain: "" as AppSettings["providerFamilyDomain"],
    providerFamilyDomainUpdatedAt: Date.now(),
    // 这一条是清理的关键：ensureProviderFamilyDomainMigration 见到它就返回，
    // 否则迁移会依据残留 provider 把 domain 重新推断并写回来。
    providerFamilyDomainMigrated: true,
  });
  // Coding Plan 官网 webview 使用独立持久 partition，账号态清理必须同步清掉其中的官网会话。
  await params.platform.executeDesktopCommand(DesktopCommandIds.ClearCodingPlanWebviewStorage);

  logger.info("[legacyAccountRetirement] 已清理官方版遗留账号态", {
    activeProvider,
    hadProviderFamilyDomain: Boolean(providerFamilyDomain),
  });
  return {
    retired: true,
    activeProvider,
    hadProviderFamilyDomain: Boolean(providerFamilyDomain),
  };
}

// 启动链路上有两个 consumer（provider family 迁移与账号会话恢复）必须等清理结束后再继续，
// 否则恢复会把残留凭据显示成「已登录」、迁移会把 domain 重新写回来。
// 按 services 实例记忆（同一 Environment 共享一次，跨 Local/Remote 不互相顶替），
// 先到者发起清理，后到者等同一个 promise。
const retirementByServices = new WeakMap<
  AccountStateServices,
  Promise<LegacyAccountRetirementOutcome>
>();

export function retireLegacyAccountStateOnce(
  params: LegacyAccountRetirementDeps,
): Promise<LegacyAccountRetirementOutcome> {
  const pending = retirementByServices.get(params.services);
  if (pending) {
    return pending;
  }

  // 清理失败不能阻断启动：记 warn 后按「未清理」继续，启动链路本身不依赖清理结果。
  const run = retireLegacyAccountState(params).catch((error: unknown) => {
    logger.warn("[legacyAccountRetirement] 遗留账号态清理失败，继续启动", { error });
    return { retired: false, activeProvider: null, hadProviderFamilyDomain: false };
  });
  retirementByServices.set(params.services, run);
  return run;
}
