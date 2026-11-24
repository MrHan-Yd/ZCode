import { app, BrowserWindow, ipcMain, screen } from "electron";
import { PlatformChannels } from "@zcode/shared";
import { executeDesktopCommand } from "../../src/main/desktopCommandHandlers.js";
import { registerMainApplicationWindow } from "../../src/main/resourceManagerWindow.js";

app.setName("ZCode About Regression Fixture");
app.setPath("userData", process.env.ABOUT_FIXTURE_PROFILE!);
app.setPath("sessionData", process.env.ABOUT_FIXTURE_PROFILE!);

const logger = { info: () => {}, warn: () => {}, error: () => {} };
let navigationCount = 0;
let window: BrowserWindow;

const invokeCommand = (command: Parameters<typeof executeDesktopCommand>[0]["command"]) =>
  executeDesktopCommand({
    command,
    senderWindow: window,
    logger,
    updateZCodeStdioTapDevMenuState: () => {},
    onZCodeEndpointChanged: () => {},
    onRelaunchApp: async () => {},
    beforeClearAllData: async () => {},
    onClearAllDataFailed: () => {},
    stopFileLogging: () => {},
    settingService: { get: async () => ({}), update: async () => {} },
    credentialsDir: process.env.ABOUT_FIXTURE_PROFILE!,
    currentApplicationLocale: "zh-CN",
  });

ipcMain.handle(PlatformChannels.ExecuteDesktopCommand, async (_event, command) =>
  invokeCommand(command),
);
ipcMain.handle(PlatformChannels.GetUpdateState, () => ({ kind: "idle", enabled: false }));
ipcMain.handle(PlatformChannels.GetSystemLocale, () => "zh-CN");

app.whenReady().then(async () => {
  const workArea = screen.getPrimaryDisplay().workArea;
  window = new BrowserWindow({
    title: "ZCode About Isolated Fixture",
    x: workArea.x + 30,
    y: workArea.y + 30,
    width: Math.min(1000, workArea.width - 60),
    height: Math.min(720, workArea.height - 60),
    frame: false,
    backgroundColor: "#00000000",
    ...(process.platform === "win32" ? { backgroundMaterial: "acrylic" as const } : {}),
    webPreferences: {
      preload: process.env.ABOUT_FIXTURE_PRELOAD!,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  registerMainApplicationWindow(window.webContents.id);
  window.webContents.on("did-navigate", () => navigationCount++);
  const fixture = {
    window,
    read() {
      const content = window.getContentBounds();
      const physical =
        process.platform === "win32" ? screen.dipToScreenRect(window, content) : content;
      const insetX = Math.max(12, Math.ceil(physical.width * 0.05));
      const insetY = Math.max(12, Math.ceil(physical.height * 0.05));
      return {
        id: window.id,
        webContentsId: window.webContents.id,
        count: BrowserWindow.getAllWindows().length,
        enabled: window.isEnabled(),
        bounds: window.getBounds(),
        navigationCount,
        nativeWindowHandle: Array.from(window.getNativeWindowHandle()),
        rect: {
          x: physical.x + insetX,
          y: physical.y + insetY,
          width: physical.width - insetX * 2,
          height: physical.height - insetY * 2,
        },
      };
    },
    invokeCommand,
  };
  Object.assign(globalThis, { __aboutElectronFixture: fixture });
  await window.loadURL(process.env.ABOUT_FIXTURE_URL!);
});
app.on("window-all-closed", () => app.quit());
