import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ElectronApplication, Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import { DesktopCommandIds, TID_WORKSPACE_HELP_MENU_TRIGGER } from "@zcode/shared";
import { startDesktopFrameSampler } from "./helpers/desktopFrameSampler.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(root, "package.json"));
const CACHE_ZIP = join(
  process.env.LOCALAPPDATA ?? "",
  "electron/Cache/fef4e930717eea902a8ae3e4a245018a80bfc75e41963b3b41c41eb6c098c83f/electron-v41.0.3-win32-x64.zip",
);
const CHECKSUM = "93346b31dfcd779c4c4cdfdfb2e3f9642e7a9888e388a8971ff3e95dbf948887";

interface WindowMetrics {
  id: number;
  webContentsId: number;
  count: number;
  enabled: boolean;
  navigationCount: number;
  bounds: { x: number; y: number; width: number; height: number };
  nativeWindowHandle: number[];
  rect: { x: number; y: number; width: number; height: number };
}

async function electronExecutable(temporary: string): Promise<string> {
  if (process.env.ELECTRON_EXECUTABLE_PATH) return process.env.ELECTRON_EXECUTABLE_PATH;
  try {
    return require("electron") as string;
  } catch {
    assert.equal(process.platform, "win32", "Set ELECTRON_EXECUTABLE_PATH for this platform");
    const archive = await readFile(CACHE_ZIP);
    assert.equal(createHash("sha256").update(archive).digest("hex"), CHECKSUM);
    const destination = join(temporary, "electron");
    await mkdir(destination);
    await require("extract-zip")(CACHE_ZIP, { dir: destination });
    return join(destination, "electron.exe");
  }
}

async function readWindow(app: ElectronApplication): Promise<WindowMetrics> {
  return app.evaluate(() => {
    const fixture = (globalThis as unknown as { __aboutElectronFixture: { read(): WindowMetrics } })
      .__aboutElectronFixture;
    return fixture.read();
  });
}

async function openFromHelp(page: Page, locale: "zh-CN" | "en-US") {
  await page.getByTestId(TID_WORKSPACE_HELP_MENU_TRIGGER).click();
  await page
    .getByRole("menuitem", { name: locale === "zh-CN" ? "关于 ZCode" : "About ZCode" })
    .click();
  await page.getByTestId("desktop-about-dialog").waitFor({ state: "visible" });
  assert.equal(await page.getByRole("dialog").count(), 1);
  assert.equal(
    await page.getByTestId("desktop-about-ok").evaluate((node) => node === document.activeElement),
    true,
  );
}

async function assertClosed(page: Page) {
  await page.getByTestId("desktop-about-dialog").waitFor({ state: "hidden" });
  await page.waitForFunction(() => document.body.style.pointerEvents !== "none");
  assert.equal(
    await page
      .getByTestId(TID_WORKSPACE_HELP_MENU_TRIGGER)
      .evaluate((node) => node === document.activeElement),
    true,
  );
}

test("About 同窗口实际菜单、关闭焦点与 Acrylic 白帧隔离回归", { timeout: 300_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "zcode-about-electron-"));
  let server: ViteDevServer | undefined;
  let app: ElectronApplication | undefined;
  try {
    const { build } = require("esbuild") as typeof import("esbuild");
    const sourceAlias = {
      "@zcode/shared": join(root, "packages/shared/src/index.ts").replaceAll("\\", "/"),
      "@zcode/ui": join(root, "packages/ui/src/index.ts").replaceAll("\\", "/"),
    };
    await build({
      entryPoints: [join(root, "packages/desktop/test/helpers/aboutElectronFixture.ts")],
      outfile: join(temporary, "main.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      banner: {
        js: "import {createRequire as _fixtureRequire} from 'node:module'; const require = _fixtureRequire(import.meta.url);",
      },
      external: ["electron"],
      plugins: [
        {
          name: "shared-public-entry",
          setup(builder) {
            builder.onResolve({ filter: /^@zcode\/shared$/ }, () => ({
              path: join(root, "packages/shared/src/index.ts"),
            }));
          },
        },
      ],
      tsconfig: join(root, "packages/desktop/tsconfig.main.json"),
      logLevel: "silent",
    });
    await build({
      stdin: {
        contents: `const {contextBridge,ipcRenderer}=require('electron'); const {PlatformChannels}=require('@zcode/shared'); const {createAboutDialogBridge}=require(${JSON.stringify(join(root, "packages/desktop/src/preload/aboutDialogBridge.ts"))}); const bridge=createAboutDialogBridge(); ipcRenderer.on(PlatformChannels.OpenAboutDialog,(_e,p)=>bridge.receive(p)); contextBridge.exposeInMainWorld('zcode',{onOpenAboutDialog:bridge.subscribe,executeDesktopCommand:c=>ipcRenderer.invoke(PlatformChannels.ExecuteDesktopCommand,c),getUpdateState:()=>ipcRenderer.invoke(PlatformChannels.GetUpdateState),getSystemLocale:()=>ipcRenderer.invoke(PlatformChannels.GetSystemLocale),onUpdateStateChanged:()=>()=>{},getDeviceId:()=>''});`,
        resolveDir: root,
      },
      outfile: join(temporary, "preload.cjs"),
      bundle: true,
      platform: "node",
      format: "cjs",
      external: ["electron"],
      alias: sourceAlias,
      logLevel: "silent",
    });
    await writeFile(
      join(temporary, "entry.tsx"),
      `import {mountAboutFixture} from ${JSON.stringify(join(root, "packages/ui/test/fixtures/aboutDialogFixture.tsx"))}; mountAboutFixture(window.zcode);`,
    );
    await writeFile(
      join(temporary, "index.html"),
      '<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>',
    );
    const { createServer } = (await import(
      pathToFileURL(require.resolve("vite")).href
    )) as typeof import("vite");
    const { default: react } = (await import(
      pathToFileURL(require.resolve("@vitejs/plugin-react")).href
    )) as typeof import("@vitejs/plugin-react");
    const { default: tailwind } = (await import(
      pathToFileURL(require.resolve("@tailwindcss/vite")).href
    )) as typeof import("@tailwindcss/vite");
    server = await createServer({
      configFile: false,
      root: temporary,
      cacheDir: join(temporary, ".vite"),
      plugins: [react(), tailwind()],
      resolve: {
        alias: [
          { find: "@", replacement: join(root, "packages/ui/src") },
          { find: /^@zcode\/shared$/, replacement: sourceAlias["@zcode/shared"]! },
          { find: /^@zcode\/ui$/, replacement: sourceAlias["@zcode/ui"]! },
          { find: /^react$/, replacement: require.resolve("react") },
          { find: /^react-dom\/client$/, replacement: require.resolve("react-dom/client") },
          { find: /^react-dom$/, replacement: require.resolve("react-dom") },
          { find: /^react\/jsx-runtime$/, replacement: require.resolve("react/jsx-runtime") },
          {
            find: /^react\/jsx-dev-runtime$/,
            replacement: require.resolve("react/jsx-dev-runtime"),
          },
        ],
        dedupe: ["react", "react-dom"],
      },
      server: {
        host: "127.0.0.1",
        port: 0,
        watch: { ignored: ["**/electron/**", "**/profile/**"] },
        fs: { allow: [root, temporary] },
      },
    });
    await server.listen();
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const executablePath = await electronExecutable(temporary);
    const profile = join(temporary, "profile");
    await mkdir(profile);
    const { _electron } = require("playwright-core") as typeof import("playwright-core");
    const isolatedEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([name, value]) =>
          value !== undefined && name !== "ELECTRON_RUN_AS_NODE" && name !== "NODE_OPTIONS",
      ),
    ) as Record<string, string>;
    app = await _electron.launch({
      executablePath,
      args: [join(temporary, "main.mjs")],
      cwd: temporary,
      artifactsDir: join(temporary, "artifacts"),
      colorScheme: null,
      env: {
        ...isolatedEnv,
        HOME: profile,
        USERPROFILE: profile,
        ABOUT_FIXTURE_PROFILE: profile,
        ABOUT_FIXTURE_PRELOAD: join(temporary, "preload.cjs"),
        ABOUT_FIXTURE_URL: `${origin}/?locale=zh-CN&theme=dark`,
        ZCODE_DISABLE_FIXED_REMOTE_DEBUGGING_PORT: "1",
        ZCODE_ENV: "test",
        ZCODE_DATA_BASE_DIR: profile,
        ZCODE_HOME: profile,
        ZCODE_E2E_RUNTIME_LOG_DIR: join(profile, "logs"),
      },
    });
    const page = await app.firstWindow();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
      t.diagnostic(`pageerror: ${error.stack}`);
    });
    page.on("console", (message) => {
      if (message.type() === "error") t.diagnostic(`console: ${message.text()}`);
    });
    page.on("requestfailed", (request) =>
      t.diagnostic(`failed request: ${request.url()} ${request.failure()?.errorText}`),
    );
    try {
      await page.getByTestId(TID_WORKSPACE_HELP_MENU_TRIGGER).waitFor();
    } catch (error) {
      t.diagnostic(
        `url: ${page.url()}; visible text: ${await page.locator("body").innerText()}; html: ${await page.locator("body").innerHTML()}; title: ${await page.title()}`,
      );
      t.diagnostic(
        JSON.stringify(
          await page.getByTestId(TID_WORKSPACE_HELP_MENU_TRIGGER).evaluate((node) => ({
            rect: node.getBoundingClientRect().toJSON(),
            style: getComputedStyle(node).cssText,
            display: getComputedStyle(node).display,
            visibility: getComputedStyle(node).visibility,
            bodyRect: document.body.getBoundingClientRect().toJSON(),
            rootDisplay: getComputedStyle(document.getElementById("root")!).display,
            window: { w: innerWidth, h: innerHeight },
          })),
        ),
      );
      t.diagnostic(
        `entry status: ${(await fetch(`${origin}/entry.tsx`)).status}; scripts: ${await page.locator("script").evaluateAll((nodes) => nodes.map((n) => n.getAttribute("src")))}`,
      );
      throw error;
    }
    for (const locale of ["zh-CN", "en-US"] as const) {
      for (const theme of ["dark", "light"] as const) {
        await page.goto(`${origin}/?locale=${locale}&theme=${theme}`);
        await page.getByTestId(TID_WORKSPACE_HELP_MENU_TRIGGER).waitFor();
        await app.evaluate(({ nativeTheme }, selectedTheme) => {
          nativeTheme.themeSource = selectedTheme;
        }, theme);
        const before = await readWindow(app);
        await openFromHelp(page, locale);
        await page.evaluate(() =>
          (
            window as unknown as { __aboutFixture: { setStage(stage: string): void } }
          ).__aboutFixture.setStage("workspace"),
        );
        assert.equal(await page.getByRole("dialog").count(), 1);
        await page.getByTestId("desktop-about-ok").click();
        await assertClosed(page);
        for (const close of ["OK", "Enter", "Escape"] as const) {
          for (let iteration = 0; iteration < 10; iteration++) {
            await openFromHelp(page, locale);
            await app.evaluate(async (_electron, command) => {
              const fixture = (
                globalThis as unknown as {
                  __aboutElectronFixture: { invokeCommand(command: string): Promise<void> };
                }
              ).__aboutElectronFixture;
              await fixture.invokeCommand(command);
            }, DesktopCommandIds.ShowAbout);
            assert.equal(await page.getByRole("dialog").count(), 1);
            if (close === "OK") await page.getByTestId("desktop-about-ok").click();
            else await page.keyboard.press(close);
            await assertClosed(page);
            const after = await readWindow(app);
            assert.equal(after.count, 1);
            assert.equal(after.id, before.id);
            assert.equal(after.webContentsId, before.webContentsId);
            assert.equal(after.enabled, true);
            assert.equal(after.navigationCount, before.navigationCount);
            assert.deepEqual(after.bounds, before.bounds);
          }
        }
        await page
          .getByTestId("about-fixture-input")
          .fill("Input remains usable after About close.");
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        t.diagnostic(
          `${locale}/${theme}: 31 closes, one BrowserWindow, no navigation, focus restored`,
        );
      }
    }
    if (process.platform === "win32") {
      await page.goto(`${origin}/?locale=zh-CN&theme=dark`);
      await page.getByTestId(TID_WORKSPACE_HELP_MENU_TRIGGER).waitFor();
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = "dark";
        const fixture = (
          globalThis as unknown as {
            __aboutElectronFixture: { window: import("electron").BrowserWindow };
          }
        ).__aboutElectronFixture;
        fixture.window.setAlwaysOnTop(true, "screen-saver");
        fixture.window.show();
        fixture.window.focus();
        fixture.window.moveTop();
      });
      const startSampling = async () => {
        await app!.evaluate(() => {
          const window = (
            globalThis as unknown as {
              __aboutElectronFixture: { window: import("electron").BrowserWindow };
            }
          ).__aboutElectronFixture.window;
          window.moveTop();
        });
        const metrics = await readWindow(app!);
        t.diagnostic(`OS sample target: ${JSON.stringify(metrics)}`);
        t.diagnostic(
          `Renderer baseline: ${JSON.stringify(await page.evaluate(() => ({ calibration: document.querySelector('[data-testid="screen-calibration"]') !== null, theme: document.documentElement.className, background: getComputedStyle(document.querySelector('[data-testid="about-fixture-root"]')!).backgroundColor })))}`,
        );
        return startDesktopFrameSampler({
          nativeWindowHandle: Buffer.from(metrics.nativeWindowHandle),
          rect: metrics.rect,
        });
      };
      const calibration = await startSampling();
      try {
        await page.evaluate(() =>
          (
            window as unknown as { __aboutFixture: { setWhiteCalibration(white: boolean): void } }
          ).__aboutFixture.setWhiteCalibration(true),
        );
        await page.getByTestId("screen-calibration").waitFor();
        await page.waitForTimeout(250);
        await page.evaluate(() =>
          (
            window as unknown as { __aboutFixture: { setWhiteCalibration(white: boolean): void } }
          ).__aboutFixture.setWhiteCalibration(false),
        );
        await page.getByTestId("screen-calibration").waitFor({ state: "hidden" });
      } finally {
        const result = await calibration.stop();
        assert.ok(
          result.whiteFrames > 0,
          "OS sampler must detect the controlled white calibration",
        );
        assert.ok(result.maxWhiteFraction > 0.95);
        t.diagnostic(`OS white calibration: ${JSON.stringify(result)}`);
      }
      for (const maximized of [false, true]) {
        await app.evaluate((_electron, maximize) => {
          const window = (
            globalThis as unknown as {
              __aboutElectronFixture: { window: import("electron").BrowserWindow };
            }
          ).__aboutElectronFixture.window;
          if (maximize) window.maximize();
          else window.unmaximize();
        }, maximized);
        await page.waitForTimeout(300);
        const sampler = await startSampling();
        try {
          for (let iteration = 0; iteration < 30; iteration++) {
            await openFromHelp(page, "zh-CN");
            if (iteration % 3 === 0) await page.getByTestId("desktop-about-ok").click();
            else await page.keyboard.press(iteration % 3 === 1 ? "Enter" : "Escape");
            await assertClosed(page);
          }
        } finally {
          const result = await sampler.stop();
          t.diagnostic(`OS observed result: ${JSON.stringify(result)}`);
          assert.ok(result.frames > 30, "OS sampler must collect actual desktop frames");
          assert.equal(
            result.whiteFrames,
            0,
            "Dark About close must not expose a white desktop frame",
          );
          t.diagnostic(`OS dark/${maximized ? "maximized" : "normal"}: ${JSON.stringify(result)}`);
        }
      }
    }
    assert.deepEqual(pageErrors, []);
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    }
  }
});
