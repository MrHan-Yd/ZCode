export interface ClearDataSession {
  clearStorageData(): Promise<void>;
}
export interface ClearDataWindow {
  isDestroyed(): boolean;
  destroy(): void;
  webContents: {
    session: ClearDataSession;
    executeJavaScript(script: string): Promise<unknown>;
  };
}
export function waitForClearDataPreparation(
  operation: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("clear data preparation timed out")),
      timeoutMs,
    );
    timer.unref?.();
    void operation.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export function shouldBlockQuitForClearData(
  admissionClosed: boolean,
  recoveryRequested: boolean,
): boolean {
  return admissionClosed && !recoveryRequested;
}

export interface ClearDataDependencies {
  confirm(): Promise<boolean>;
  beforeClearAllData(): Promise<void>;
  listWindows(): ClearDataWindow[];
  clearAdditionalStorage(): Promise<void>;
  removeDirectory(path: string): Promise<void>;
  stopFileLogging(): void;
  reportFailure(error: unknown): Promise<void>;
  onFailure?(): void;
  relaunch(): void;
  exit(): void;
}

/** Main 清数据单飞入口；这里只编排现有 owner 的生命周期，不持有业务会话状态。 */
export function createClearDataOperation(deps: ClearDataDependencies) {
  let inFlight: Promise<void> | undefined;
  return (credentialsDir: string): Promise<void> => {
    if (inFlight) return inFlight;
    const run = (async () => {
      if (!(await deps.confirm())) return;
      // 官方 beforeClearAllData 修复：删除前先等待所有写入者；失败不进入清理或退出。
      try {
        // beforeClearAllData 在首次 await 前同步关 admission；这以后新窗口/Host 不会遗漏在快照之外。
        const preparing = deps.beforeClearAllData();
        const windows = deps.listWindows();
        const sessions = [...new Set(windows.map((win) => win.webContents.session))];
        await preparing;
        // Renderer 自动持久化在现有 Host admission 已关闭后终止；不在准备失败时销毁窗口。
        for (const win of windows) {
          if (!win.isDestroyed()) win.destroy();
        }
        // Main logger 每次写都会 mkdir(v2/logs)；commit 前关闭落盘，避免删完又由日志复活目录。
        deps.stopFileLogging();
        await deps.clearAdditionalStorage();
        for (const session of sessions) await session.clearStorageData();
        await deps.removeDirectory(credentialsDir);
        deps.relaunch();
        deps.exit();
      } catch (error) {
        deps.onFailure?.();
        await deps.reportFailure(error);
        throw error;
      }
    })();
    inFlight = run;
    void run.then(
      () => {
        if (inFlight === run) inFlight = undefined;
      },
      () => {
        if (inFlight === run) inFlight = undefined;
      },
    );
    return run;
  };
}
