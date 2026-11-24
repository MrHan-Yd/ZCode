import type { BrowserWindow } from "electron";
import { showAboutDialog } from "./about.js";

export async function executeDesktopAboutCommand(options: {
  senderWindow?: BrowserWindow | null;
  listWindows: () => BrowserWindow[];
  getFocusedWindow: () => BrowserWindow | null;
  isMainApplicationWindow: (webContentsId: number) => boolean;
  ensurePrimaryWindow?: (reason: string) => Promise<void>;
}): Promise<void> {
  const findTarget = () =>
    [options.senderWindow, options.getFocusedWindow(), ...options.listWindows()].find(
      (win): win is BrowserWindow =>
        Boolean(
          win &&
          !win.isDestroyed() &&
          !win.webContents.isDestroyed() &&
          options.isMainApplicationWindow(win.webContents.id),
        ),
    );
  let target = findTarget();
  if (!target) {
    await options.ensurePrimaryWindow?.("show-about");
    target = findTarget();
  }
  if (target && !target.isDestroyed()) {
    // 辅助窗发出的 About 也必须可见；复用既有主窗口，不创建第二个窗口 owner。
    if (target.isMinimized()) target.restore();
    if (!target.isVisible()) target.show();
    if (!target.isFocused()) target.focus();
  }
  await showAboutDialog(target);
}
