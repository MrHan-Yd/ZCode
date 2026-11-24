import { HostMessageTypes } from "@zcode/shared";

/** Main 只拥有 utility process 生命周期；Host 仍拥有 Agent 与业务服务收尾。 */
export interface ShutdownUtilityProcess {
  pid?: number;
  postMessage(message: { type: string }): void;
  kill(): boolean;
  once(event: "exit", listener: (code: number) => void): unknown;
  off(event: "exit", listener: (code: number) => void): unknown;
}
interface ShutdownLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}
const exitedHostProcesses = new WeakMap<ShutdownUtilityProcess, number>();
const forcedProcesses = new WeakSet<ShutdownUtilityProcess>();
const disposingHostProcesses = new Set<ShutdownUtilityProcess>();
const forceListeners = new WeakMap<ShutdownUtilityProcess, Set<() => void>>();

export function recordUtilityProcessExit(child: ShutdownUtilityProcess, code: number): void {
  exitedHostProcesses.set(child, code);
}
export function listDisposingHostProcesses(): ShutdownUtilityProcess[] {
  return Array.from(disposingHostProcesses);
}
function forceProcess(child: ShutdownUtilityProcess): void {
  forcedProcesses.add(child);
  for (const listener of forceListeners.get(child) ?? []) listener();
  child.kill();
}
function verifyExit(child: ShutdownUtilityProcess): Error | undefined {
  if (forcedProcesses.has(child))
    return new Error("utility process cleanup was forced; clean exit unverified");
  const code = exitedHostProcesses.get(child);
  return code === 0
    ? undefined
    : new Error(`utility process cleanup failed, exit=${code ?? "unobserved"}`);
}

/** 截止时间只能拒绝清数据，不能替代物理退出；普通退出仍允许 fail-open。 */
function waitForExit(
  child: ShutdownUtilityProcess,
  timeoutMs: number,
  strict: boolean,
  begin: () => void,
  onTimeout: () => void = () => undefined,
): Promise<void> {
  if (exitedHostProcesses.has(child)) {
    const error = strict ? verifyExit(child) : undefined;
    return error ? Promise.reject(error) : Promise.resolve();
  }
  if (strict && forcedProcesses.has(child)) return Promise.reject(verifyExit(child));
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      child.off("exit", exited);
      forceListeners.get(child)?.delete(forced);
      if (error) reject(error);
      else resolve();
    };
    const exited = (code: number) => {
      recordUtilityProcessExit(child, code);
      finish(strict ? verifyExit(child) : undefined);
    };
    const forced = () =>
      finish(new Error("utility process cleanup was forced; clean exit unverified"));
    child.once("exit", exited);
    if (strict) {
      const listeners = forceListeners.get(child) ?? new Set<() => void>();
      listeners.add(forced);
      forceListeners.set(child, listeners);
    }
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        onTimeout();
        finish(strict ? new Error("utility process exit wait timed out") : undefined);
      }, timeoutMs);
      timeout.unref?.();
    }
    try {
      begin();
    } catch (error) {
      finish(error);
    }
  });
}

export function disposeHostProcess(
  child: ShutdownUtilityProcess,
  label: string,
  disposingHostProcessTimers: WeakMap<ShutdownUtilityProcess, ReturnType<typeof setTimeout>>,
  logger: ShutdownLogger,
  forceKillDelayMs = 300,
) {
  if (disposingHostProcesses.has(child) || exitedHostProcesses.has(child)) return;
  disposingHostProcesses.add(child);
  logger.info(
    `[disposeHostProcess] disposing host process (${label}), pid=${child.pid ?? "unknown"}`,
  );
  try {
    child.postMessage({ type: HostMessageTypes.Dispose });
  } catch (error) {
    logger.warn(`[disposeHostProcess] failed to post dispose to (${label}):`, error);
  }
  // Host 需要完成自己的 Agent 进程树收尾；保留原来的最小强杀预算。
  const killTimer = setTimeout(
    () => {
      disposingHostProcessTimers.delete(child);
      try {
        forceProcess(child);
      } catch (error) {
        logger.warn(`[disposeHostProcess] failed to kill host process (${label}):`, error);
      }
    },
    Math.max(forceKillDelayMs, 3_500),
  );
  disposingHostProcessTimers.set(child, killTimer);
  child.once("exit", (code) => {
    recordUtilityProcessExit(child, code);
    disposingHostProcesses.delete(child);
    clearTimeout(killTimer);
    disposingHostProcessTimers.delete(child);
  });
}

export function disposeHostProcessAndWait(
  child: ShutdownUtilityProcess,
  label: string,
  disposingHostProcessTimers: WeakMap<ShutdownUtilityProcess, ReturnType<typeof setTimeout>>,
  logger: ShutdownLogger,
  options: { forceKillDelayMs?: number; waitTimeoutMs?: number; requireCleanExit?: boolean } = {},
): Promise<void> {
  return waitForExit(
    child,
    Math.max(options.waitTimeoutMs ?? 0, 0),
    options.requireCleanExit === true,
    () =>
      disposeHostProcess(
        child,
        label,
        disposingHostProcessTimers,
        logger,
        options.forceKillDelayMs,
      ),
    () =>
      logger.warn(
        `[disposeHostProcessAndWait] host process exit wait timed out (${label}), pid=${child.pid ?? "unknown"}`,
      ),
  );
}

/** 从既有 Cron disposer 抽出的生命周期逻辑，任务派发仍归原 owner。 */
export function createSchedulerShutdown(child: ShutdownUtilityProcess) {
  let disposePromise: Promise<void> | undefined;
  let requested = false;
  child.once("exit", (code) => recordUtilityProcessExit(child, code));
  return {
    dispose(options: { requireCleanExit?: boolean } = {}): Promise<void> {
      const strict = options.requireCleanExit === true;
      if (!strict && disposePromise) return disposePromise;
      const result = waitForExit(child, strict ? 2_000 : 0, strict, () => {
        if (requested) return;
        requested = true;
        const timer = setTimeout(() => {
          try {
            forceProcess(child);
          } catch {
            // 既有普通退出保持 best-effort；严格 waiter 已明确拒绝。
          }
        }, 1_500);
        child.once("exit", () => clearTimeout(timer));
        try {
          child.postMessage({ type: "scheduler-dispose" });
        } catch (error) {
          // 原 Cron postToScheduler 失败时仍等物理退出/强杀；只在 clear 严格模式把异常作为拒绝。
          if (strict) throw error;
        }
      });
      if (strict) return result;
      // 普通退出沿用强杀 timer 后继续；严格调用不复用这个 fail-open Promise。
      disposePromise = Promise.race([
        result,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_500);
          child.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        }),
      ]);
      return disposePromise;
    },
  };
}
