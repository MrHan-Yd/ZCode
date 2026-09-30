import { ZCODE_VERSION, type ForceUpdateRequirement, type Locale } from "@zcode/shared";
import { requestForceAutoUpdate, type ForceAutoUpdateState } from "./autoUpdater.js";
import {
  resolveForceUpdateManualUpdateUrl,
  resolveForceUpdateMarkerUrl,
  resolveForceUpdateRequirementFromMarker,
} from "./forceUpdateMarker.js";
import { showForceUpdatePrompt } from "./forceUpdatePrompt.js";

// 强更标记请求落在主窗口创建之前，最坏会让启动路径多等一个完整超时；而且它要过
// github.com 与 objects.githubusercontent.com 两跳（releases/latest/download 会 302），
// 坏网络下必然打满。门禁自身 fail-open，超时与「没检查」结果相同，所以把预算收紧到 3s：
// 足以覆盖冷 DNS + 两次 TLS 的「慢但可用」连接，同时把最坏情况从 10s 压到 3s。
const FORCE_UPDATE_MARKER_REQUEST_TIMEOUT_MS = 3_000;
const FORCE_UPDATE_MARKER_MAX_RESPONSE_BYTES = 64 * 1024;

export interface ForceUpdateDialogText {
  title: string;
  message: string;
  detail: string;
  autoUpdateButton: string;
  manualUpdateButton: string;
  quitButton: string;
}

export interface ForceUpdateGuardLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

interface ForceUpdateGuardResult {
  blocked: boolean;
  requirement?: ForceUpdateRequirement;
}

interface ForceUpdateGuardOptions {
  locale: Locale;
  logger: ForceUpdateGuardLogger;
  fetchForceUpdateMarker?: () => Promise<unknown>;
  requestAutoUpdate?: (
    onStateChange?: (state: ForceAutoUpdateState) => void,
  ) => (() => void) | void;
  onBlocked?: (requirement: ForceUpdateRequirement) => void;
}

async function requestForceUpdateMarker(fetchMarker?: () => Promise<unknown>): Promise<unknown> {
  if (fetchMarker) {
    return fetchMarker();
  }

  const { net } = await import("electron");
  return new Promise<unknown>((resolve, reject) => {
    let request: ReturnType<typeof net.request>;
    let timer: ReturnType<typeof setTimeout>;
    let data = "";
    let receivedBytes = 0;
    let settled = false;

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      request?.abort();
      reject(error);
    };

    const finish = (value: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    timer = setTimeout(() => {
      fail(new Error("force update marker request timeout"));
    }, FORCE_UPDATE_MARKER_REQUEST_TIMEOUT_MS);
    timer.unref?.();

    request = net.request(resolveForceUpdateMarkerUrl());
    request.on("response", (response) => {
      const statusCode = response.statusCode ?? 0;
      if (statusCode < 200 || statusCode >= 300) {
        // 「最新 Release 没有标记资产」就是 404，和网络故障一样走放行路径，不能把 4xx/5xx 当配置解析。
        fail(new Error(`force update marker request failed with status ${statusCode}`));
        return;
      }

      response.on("data", (chunk) => {
        receivedBytes += Buffer.byteLength(chunk);
        if (receivedBytes > FORCE_UPDATE_MARKER_MAX_RESPONSE_BYTES) {
          // 标记在主窗口创建前读取，必须限制响应体，避免异常响应撑爆 main 进程内存。
          fail(new Error("force update marker response too large"));
          return;
        }
        data += chunk.toString();
      });
      response.on("end", () => {
        try {
          finish(JSON.parse(data));
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      response.on("error", (error) => {
        fail(error instanceof Error ? error : new Error(String(error)));
      });
    });
    request.on("error", (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
    request.end();
  });
}

export type ForceUpdateMarkerRequestOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: unknown };

/**
 * 提前发起标记请求，并把失败固化成结果值。
 *
 * 启动路径上这个请求最坏要等一个网络超时，所以希望它在 App ready 后立刻发出去，
 * 与原生菜单安装、Chromium 策略、release notes、ARMS 初始化重叠。但「提前发起」意味着
 * 在门禁 await 之前它就可能有结论：main 进程里没有 handler 的 rejection 会终止进程，
 * 因此这里在发起处就把失败接住（settled 值），再交给 `forceUpdateMarkerOutcomeToPromise`
 * 还原成「成功返回值 / 失败抛出」，让门禁原有的 try/catch 语义完全不变。
 */
export function startForceUpdateMarkerRequest(): Promise<ForceUpdateMarkerRequestOutcome> {
  return requestForceUpdateMarker().then(
    (value): ForceUpdateMarkerRequestOutcome => ({ ok: true, value }),
    (error: unknown): ForceUpdateMarkerRequestOutcome => ({ ok: false, error }),
  );
}

export function forceUpdateMarkerOutcomeToPromise(
  outcome: Promise<ForceUpdateMarkerRequestOutcome>,
): Promise<unknown> {
  return outcome.then((settled) => {
    if (settled.ok) {
      return settled.value;
    }
    throw settled.error;
  });
}

async function resolveDesktopForceUpdateRequirement(options: {
  logger: ForceUpdateGuardLogger;
  fetchForceUpdateMarker?: () => Promise<unknown>;
}): Promise<ForceUpdateRequirement | null> {
  try {
    const marker = await requestForceUpdateMarker(options.fetchForceUpdateMarker);
    return resolveForceUpdateRequirementFromMarker(marker, ZCODE_VERSION);
  } catch (error) {
    // 预留离线跳过接口：完全离线时先不拉闸，后续可在这里接入显式 offline bypass 策略。
    options.logger.warn("[force-update] 读取强制升级标记失败，跳过强制升级校验", { error });
    return null;
  }
}

function formatForceUpdateDialogText(
  requirement: ForceUpdateRequirement,
  locale: Locale,
): ForceUpdateDialogText {
  if (locale === "zh-CN") {
    return {
      title: "需要升级 ZCode",
      message: "当前版本无法继续使用",
      detail: `当前版本：v${requirement.currentVersion}\n最低可用版本：v${requirement.minimalVersion}`,
      autoUpdateButton: "自动升级",
      manualUpdateButton: "手动升级",
      quitButton: "退出",
    };
  }

  return {
    title: "Update ZCode",
    message: "The current version can no longer be used",
    detail: `Current version: v${requirement.currentVersion}\nMinimum supported version: v${requirement.minimalVersion}`,
    autoUpdateButton: "Auto update",
    manualUpdateButton: "Manual update",
    quitButton: "Quit",
  };
}

export async function maybeBlockStartupForForceUpdate(
  options: ForceUpdateGuardOptions,
): Promise<ForceUpdateGuardResult> {
  const requirement = await resolveDesktopForceUpdateRequirement(options);
  if (!requirement) {
    return { blocked: false };
  }

  options.logger.warn("[force-update] 远端强更标记要求强制升级，阻止创建主窗口", requirement);
  options.onBlocked?.(requirement);
  const { app, shell } = await import("electron");
  const action = await showForceUpdatePrompt(
    formatForceUpdateDialogText(requirement, options.locale),
    options.locale,
    options.logger,
    {
      startAutoUpdate: (onStateChange) =>
        options.requestAutoUpdate?.(onStateChange) ??
        requestForceAutoUpdate(onStateChange, "force-update", requirement.minimalVersion),
    },
  );
  if (action === "auto") {
    return { blocked: true, requirement };
  }

  if (action === "manual") {
    const url = resolveForceUpdateManualUpdateUrl();
    options.logger.info(`[force-update] 用户选择手动升级：${url}`);
    await shell.openExternal(url);
  }

  // 强制升级命中后不能进入主界面；非自动升级路径处理完弹窗后退出，避免露出旧客户端功能。
  app.quit();
  return { blocked: true, requirement };
}
