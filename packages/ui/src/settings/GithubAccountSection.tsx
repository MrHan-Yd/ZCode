import { useCallback, useEffect, useReducer, useState } from "react";
import { CircleUserRound, ExternalLink, Loader2, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { logger } from "@/logger.js";
import {
  buildGithubAuthPollRequest,
  githubAuthAccountLabel,
  githubAuthFlowReducer,
  githubAuthRemainingSeconds,
  INITIAL_GITHUB_AUTH_FLOW_STATE,
  shouldPollGithubAuth,
  type GithubAuthFlowState,
  type GithubAuthPhase,
} from "@/settings/githubAuthFlowModel.js";
import { SettingsGroupCard } from "@/settings/SettingsPageParts.js";

/** 秒 → 毫秒。轮询排期与设备码倒计时共用同一个节奏常量。 */
const MS_PER_SECOND = 1000;

/**
 * GitHub 账号分区（三态卡片）。
 *
 * 授权走 OAuth Device Flow：UI 只负责「拿设备码 → 打开系统浏览器 → 轮询 → 展示结果」，
 * token 的唯一所有者是 host 侧服务，UI 不缓存明文。所有状态迁移都收敛在
 * `githubAuthFlowModel` 的纯 reducer 里，组件不做额外的分支推断。
 */
export function GithubAccountSection() {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const services = useServices();
  const service = services.githubAuthService;
  const [state, dispatch] = useReducer(githubAuthFlowReducer, INITIAL_GITHUB_AUTH_FLOW_STATE);
  // 读取账号状态失败（RPC/网络）单独记一份，不混进授权流程状态机。
  const [accountError, setAccountError] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const formatMessage = useCallback(
    (id: string, values?: Record<string, string | number>) => intl.formatMessage({ id }, values),
    [intl],
  );

  const refreshAccount = useCallback(async () => {
    if (!service) {
      return;
    }
    try {
      const account = await service.getAccount();
      dispatch({ type: "accountLoaded", account });
      setAccountError(null);
    } catch (error) {
      // getAccount 本身已在「token 在但 API 不可达」时降级返回 connected:true；
      // 这里只处理真正抛出来的 RPC/网络异常，按未登录展示并给出可重试提示。
      const message = getErrorMessage(error);
      logger.warn("[GithubAccountSection] 读取 GitHub 账号状态失败", { error: message });
      setAccountError(message);
    }
  }, [service]);

  useEffect(() => {
    void refreshAccount();
  }, [refreshAccount]);

  // 轮询：等上一次返回再排下一次（setTimeout 链），而不是固定 setInterval 无条件发包。
  // intervalSeconds 只存在本地游标里、不进依赖：一旦进依赖，每次 slow_down 都会重启 effect，
  // 在同一个 deviceCode 上叠加多条 RPC（BotsDialog 里记录过的同类问题）。
  useEffect(() => {
    if (!service || !shouldPollGithubAuth(state)) {
      return undefined;
    }
    const request = buildGithubAuthPollRequest(state);
    if (!request) {
      return undefined;
    }
    const { deviceCode } = request;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 本地游标与 reducer 用同一个纯函数折叠，保证两边结果一致。
    let cursor = state;

    const pollOnce = async () => {
      try {
        const result = await service.pollDeviceAuth({
          deviceCode,
          // 必须回传上次使用的间隔，否则 host 无法在 slow_down 时递进。
          interval: cursor.intervalSeconds,
        });
        if (cancelled) {
          return;
        }
        cursor = githubAuthFlowReducer(cursor, { type: "pollResult", result });
        dispatch({ type: "pollResult", result });
        if (shouldPollGithubAuth(cursor)) {
          timer = setTimeout(() => void pollOnce(), cursor.intervalSeconds * MS_PER_SECOND);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        const message = getErrorMessage(error);
        logger.warn("[GithubAccountSection] 轮询 GitHub 设备码失败", { error: message });
        dispatch({ type: "pollResult", result: { status: "error", message } });
      }
    };

    timer = setTimeout(() => void pollOnce(), cursor.intervalSeconds * MS_PER_SECOND);

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
    // 依赖只保留「是否还在轮询」与 deviceCode：见上方关于间隔的说明。
  }, [service, state.phase, state.deviceCode]);

  /**
   * 设备码倒计时，**纯展示**。
   *
   * `expiresAt` 由 host 时钟产生；手机远控（web-remote）下渲染端与 host 是两台机器，
   * 渲染端时钟不可作为过期判据——手机时钟快几分钟就会把一个仍然有效的授权提前掐断。
   * 因此这里只驱动数字刷新，归零后最多多轮询一个 interval，由 host 的 `expired` 权威终止。
   */
  useEffect(() => {
    if (state.phase !== "authorizing" || state.expiresAt === undefined) {
      return undefined;
    }
    const timer = setInterval(() => setNowMs(Date.now()), MS_PER_SECOND);
    return () => clearInterval(timer);
  }, [state.expiresAt, state.phase]);

  // 只用于显示；注意不要用 remainingSeconds 派生任何状态迁移（见上方注释）。
  const remainingSeconds = githubAuthRemainingSeconds(state.expiresAt, nowMs);

  const handleSignIn = useCallback(async () => {
    if (!service) {
      return;
    }
    setAccountError(null);
    try {
      const result = await service.beginDeviceAuth();
      if (result.status === "not_configured") {
        dispatch({ type: "beginFailed", reason: "not_configured" });
        return;
      }
      if (result.status === "device_flow_disabled") {
        dispatch({ type: "beginFailed", reason: "device_flow_disabled" });
        return;
      }
      if (result.status === "error") {
        dispatch({ type: "beginFailed", reason: "error", message: result.message });
        return;
      }
      // status === "ok" 是判别联合，deviceCode / userCode / verificationUri 在类型上已是必填，
      // 缺字段由 host 侧映射成 status: "error"，这里不再重复兜底。
      dispatch({
        type: "beginSucceeded",
        deviceCode: result.deviceCode,
        userCode: result.userCode,
        verificationUri: result.verificationUri,
        intervalSeconds: result.interval,
        expiresAt: result.expiresAt,
      });
      setNowMs(Date.now());
      if (result.verificationUri) {
        // 平台操作只走 IPlatformService，不直接碰 window.zcode。
        platform.openExternal(result.verificationUri);
      }
      logger.info("[GithubAccountSection] GitHub 设备码授权已启动");
    } catch (error) {
      const message = getErrorMessage(error);
      logger.warn("[GithubAccountSection] 发起 GitHub 设备码授权失败", { error: message });
      dispatch({ type: "beginFailed", reason: "error", message });
    }
  }, [platform, service]);

  const handleReopenBrowser = useCallback(() => {
    if (state.verificationUri) {
      platform.openExternal(state.verificationUri);
    }
  }, [platform, state.verificationUri]);

  const handleCancel = useCallback(() => {
    // 设备码在 host 侧是无状态的，取消只需停止本地轮询并回到未登录态。
    dispatch({ type: "cancelled" });
  }, []);

  const handleSignOut = useCallback(async () => {
    if (!service) {
      return;
    }
    try {
      await service.signOut();
      dispatch({ type: "signedOut" });
      toast(formatMessage("settings.syncConfig.githubSignedOut"));
    } catch (error) {
      // 退出失败不能把 UI 改成未登录：凭据可能还留在 host 侧，
      // 保持 connected 态让用户重试，并明确提示「退出失败」而不是网络错误。
      const message = getErrorMessage(error);
      logger.warn("[GithubAccountSection] 退出 GitHub 登录失败", { error: message });
      toast(formatMessage("settings.syncConfig.githubSignOutFailed"));
    }
  }, [formatMessage, service]);

  if (!service) {
    return (
      <p className="text-ui-base leading-6 text-foreground-subtle">
        {formatMessage("settings.syncConfig.githubUnavailable")}
      </p>
    );
  }

  return (
    <SettingsGroupCard>
      <div className="px-4 py-3" data-testid="github-account-section" data-phase={state.phase}>
        {renderPhaseBody({
          state,
          remainingSeconds,
          accountError,
          formatMessage,
          onSignIn: () => void handleSignIn(),
          onReopenBrowser: handleReopenBrowser,
          onCancel: handleCancel,
          onSignOut: () => void handleSignOut(),
        })}
      </div>
    </SettingsGroupCard>
  );
}

interface PhaseBodyProps {
  state: GithubAuthFlowState;
  remainingSeconds: number | null;
  accountError: string | null;
  formatMessage: (id: string, values?: Record<string, string | number>) => string;
  onSignIn: () => void;
  onReopenBrowser: () => void;
  onCancel: () => void;
  onSignOut: () => void;
}

function renderPhaseBody({
  state,
  remainingSeconds,
  accountError,
  formatMessage,
  onSignIn,
  onReopenBrowser,
  onCancel,
  onSignOut,
}: PhaseBodyProps) {
  if (state.phase === "authorizing") {
    return (
      <div className="space-y-3">
        <p className="text-ui-base leading-6 text-foreground-subtle">
          {formatMessage("settings.syncConfig.githubDeviceHint")}
        </p>
        <div>
          <div className="text-ui-sm text-foreground-subtle">
            {formatMessage("settings.syncConfig.githubUserCodeLabel")}
          </div>
          {/* 刻意选择 text-ui-xl（text-ui-* 体系上限，非任意值）：设备码是本步骤的核心操作对象，
              用户要照着抄到浏览器，视觉权重配得上这个字号。 */}
          <div
            className="mt-1 font-mono text-ui-xl font-semibold tracking-[0.2em] text-foreground select-all"
            data-testid="github-user-code"
          >
            {state.userCode ?? ""}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onReopenBrowser}
            disabled={!state.verificationUri}
            data-testid="github-reopen-browser"
          >
            <ExternalLink className="size-3.5" />
            {formatMessage("settings.syncConfig.githubReopenBrowser")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            data-testid="github-cancel-authorization"
          >
            {formatMessage("settings.syncConfig.githubCancel")}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-foreground-subtle">
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="size-3.5 animate-spin" />
            {formatMessage("settings.syncConfig.githubWaiting")}
          </span>
          {remainingSeconds !== null ? (
            <span>
              {formatMessage("settings.syncConfig.githubExpiresIn", { seconds: remainingSeconds })}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  if (state.phase === "connected") {
    const label = githubAuthAccountLabel(state.account);
    return (
      <div className="flex items-center gap-3">
        {state.account?.avatarUrl ? (
          <img
            src={state.account.avatarUrl}
            alt=""
            className="size-8 shrink-0 rounded-full bg-surface object-cover"
          />
        ) : (
          <CircleUserRound className="size-8 shrink-0 text-foreground-subtle" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-ui-base font-medium text-foreground">
            {label
              ? // 已连接且账号名可得：显示 name（无 name 时 login）。
                formatMessage("settings.syncConfig.githubConnectedAs", { login: label })
              : // token 在但 GitHub API 暂不可达：只说「已连接」，不伪造账号名。
                formatMessage("settings.syncConfig.githubConnected")}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={onSignOut}
          data-testid="github-sign-out"
        >
          <LogOut className="size-3.5" />
          {formatMessage("settings.syncConfig.githubSignOut")}
        </Button>
      </div>
    );
  }

  const terminalMessage = terminalPhaseMessage(state.phase, state.message, formatMessage);
  return (
    <div className="space-y-3">
      {terminalMessage ? (
        <p className="text-ui-base leading-6 text-foreground-subtle" data-testid="github-message">
          {terminalMessage}
        </p>
      ) : null}
      {accountError ? (
        <p className="text-ui-base leading-6 text-foreground-subtle" data-testid="github-account-error">
          {formatMessage("settings.syncConfig.githubNetworkError")}
        </p>
      ) : null}
      {shouldOfferRetry(state.phase) ? (
        <div className="space-y-3">
          <p className="text-ui-base leading-6 text-foreground-subtle">
            {formatMessage("settings.syncConfig.githubDescription")}
          </p>
          <Button
            variant="default"
            size="sm"
            onClick={onSignIn}
            data-testid="github-sign-in"
          >
            {formatMessage("settings.syncConfig.githubSignIn")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * 终止态的文案。
 * `device_flow_disabled` 必须指向「去 OAuth App 设置勾选 Enable Device Flow」，
 * 否则用户看到一句「不支持」完全无从下手。
 */
function terminalPhaseMessage(
  phase: GithubAuthPhase,
  message: string | undefined,
  formatMessage: PhaseBodyProps["formatMessage"],
): string | null {
  switch (phase) {
    case "not_configured":
      return formatMessage("settings.syncConfig.githubNotConfigured");
    case "device_flow_disabled":
      return formatMessage("settings.syncConfig.githubDeviceFlowDisabled");
    case "denied":
      return formatMessage("settings.syncConfig.githubDenied");
    case "expired":
      return formatMessage("settings.syncConfig.githubExpired");
    case "reauth_required":
      return formatMessage("settings.syncConfig.githubReauthRequired");
    case "error":
      return formatMessage("settings.syncConfig.githubSignInFailed", { error: message ?? "" });
    default:
      return null;
  }
}

/** 可重试的终止态才显示登录按钮；未配置与 Device Flow 未开启重试也没用。 */
function shouldOfferRetry(phase: GithubAuthPhase): boolean {
  return (
    phase === "idle" ||
    phase === "denied" ||
    phase === "expired" ||
    phase === "reauth_required" ||
    phase === "error"
  );
}
