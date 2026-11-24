import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { PlatformChannels } from "@zcode/shared";
import { desktopAboutDialogPayloadSchema } from "../../shared/src/desktop-about.js";

mock.module("electron", {
  namedExports: {
    app: { getVersion: () => "4.0.1", isPackaged: false },
    BrowserWindow: class {
      constructor() {
        throw new Error("About must not create a native BrowserWindow");
      }
    },
  },
});
const { showAboutDialog } = await import("../src/main/about.js");
const { executeDesktopAboutCommand } = await import("../src/main/desktopAboutCommand.js");

test("About 向同一个 renderer 发布最小展示数据，不创建 native modal", async () => {
  const sends: Array<{ channel: string; payload: unknown }> = [];
  const target = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      send: (channel: string, payload: unknown) => sends.push({ channel, payload }),
    },
  } as unknown as Parameters<typeof showAboutDialog>[0];
  await showAboutDialog(target);
  assert.equal(sends.length, 1);
  assert.equal(sends[0]?.channel, PlatformChannels.OpenAboutDialog);
  const payload = desktopAboutDialogPayloadSchema.parse(sends[0]?.payload);
  assert.equal(payload.appVersion, "4.0.1");
  assert.equal(
    payload.optimizedForAppleSilicon,
    process.platform === "darwin" && process.arch === "arm64",
  );
  assert.deepEqual(Object.keys(payload).sort(), ["appVersion", "optimizedForAppleSilicon"]);
});

test("已销毁的目标不发布 About，不建立独立窗口兜底", async () => {
  const target = { isDestroyed: () => true } as unknown as Parameters<typeof showAboutDialog>[0];
  await showAboutDialog(target);
});

test("主窗口选择优先 sender，拒绝辅助窗口且无主窗时复用原 owner", async () => {
  const deliveries: number[] = [];
  const makeWindow = (id: number) =>
    ({
      isDestroyed: () => false,
      isMinimized: () => false,
      isVisible: () => true,
      isFocused: () => true,
      webContents: {
        id,
        isDestroyed: () => false,
        isLoadingMainFrame: () => false,
        send: () => deliveries.push(id),
      },
    }) as unknown as import("electron").BrowserWindow;
  const main = makeWindow(1);
  const another = makeWindow(2);
  const auxiliary = makeWindow(3);
  let windows = [main, another, auxiliary];
  const options = {
    senderWindow: another,
    getFocusedWindow: () => auxiliary,
    listWindows: () => windows,
    isMainApplicationWindow: (id: number) => id < 3,
  };
  await executeDesktopAboutCommand(options);
  assert.deepEqual(deliveries, [2]);
  await executeDesktopAboutCommand({ ...options, senderWindow: auxiliary });
  assert.deepEqual(deliveries, [2, 1]);
  windows = [auxiliary];
  let ensureCount = 0;
  await executeDesktopAboutCommand({
    ...options,
    senderWindow: auxiliary,
    ensurePrimaryWindow: async () => {
      ensureCount++;
      windows.push(main);
    },
  });
  assert.equal(ensureCount, 1);
  assert.deepEqual(deliveries, [2, 1, 1]);
});

test("隐藏最小化的 fallback 主窗在 About 发布前恢复可见", async () => {
  const events: string[] = [];
  const main = {
    isDestroyed: () => false,
    isMinimized: () => true,
    isVisible: () => false,
    isFocused: () => false,
    restore: () => events.push("restore"),
    show: () => events.push("show"),
    focus: () => events.push("focus"),
    webContents: {
      id: 1,
      isDestroyed: () => false,
      isLoadingMainFrame: () => false,
      send: () => events.push("send"),
    },
  } as unknown as import("electron").BrowserWindow;
  await executeDesktopAboutCommand({
    listWindows: () => [main],
    getFocusedWindow: () => null,
    isMainApplicationWindow: () => true,
  });
  assert.deepEqual(events, ["restore", "show", "focus", "send"]);
});

test("目标在异步读取 app 期间销毁时不再访问 webContents", async () => {
  let checks = 0;
  const target = {
    isDestroyed: () => ++checks > 1,
    webContents: {
      isDestroyed: () => false,
      isLoadingMainFrame: () => assert.fail("Destroyed target must not be queried"),
    },
  } as unknown as import("electron").BrowserWindow;
  await showAboutDialog(target);
});

test("尚在加载的主文档只在 dom-ready 后发布 About", async () => {
  let ready: (() => void) | undefined;
  let sends = 0;
  const target = {
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      isLoadingMainFrame: () => true,
      once: (_event: string, callback: () => void) => {
        ready = callback;
      },
      send: () => {
        sends++;
      },
    },
  } as unknown as import("electron").BrowserWindow;
  await showAboutDialog(target);
  assert.equal(sends, 0);
  assert.ok(ready);
  ready();
  assert.equal(sends, 1);
});

test("About 跨进程 payload 严格拒绝 diagnostics 和非法版本", () => {
  assert.equal(
    desktopAboutDialogPayloadSchema.safeParse({
      appVersion: "4.0.1",
      optimizedForAppleSilicon: false,
      hostname: "synthetic-host",
    }).success,
    false,
  );
  assert.equal(
    desktopAboutDialogPayloadSchema.safeParse({
      appVersion: " ",
      optimizedForAppleSilicon: false,
    }).success,
    false,
  );
});
