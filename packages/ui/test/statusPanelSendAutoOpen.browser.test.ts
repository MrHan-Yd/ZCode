import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import { assertStatusClosed } from "./fixtures/statusPanelSendAutoOpenActions.js";
import { statusPanelContentScenarios } from "./fixtures/statusPanelSendAutoOpenScenarios.js";
import { statusPanelLifecycleScenarios } from "./fixtures/statusPanelSendAutoOpenLifecycleScenarios.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const rootRequire = createRequire(join(ROOT, "package.json"));
const desktopRequire = createRequire(join(ROOT, "packages/desktop/package.json"));
const uiRequire = createRequire(join(ROOT, "packages/ui/package.json"));
const resolveTool = (name: string) => {
  try {
    return rootRequire.resolve(name);
  } catch {
    return desktopRequire.resolve(name);
  }
};
const scenarios = [...statusPanelContentScenarios, ...statusPanelLifecycleScenarios];

test("真实 SessionPane 发送后状态面板正式浏览器回归", { timeout: 300_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "zcode-status-send-browser-"));
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  try {
    const fixture = join(
      ROOT,
      "packages/ui/test/fixtures/statusPanelSendAutoOpenFixture.tsx",
    ).replaceAll("\\", "/");
    await Promise.all([
      writeFile(
        join(temporary, "fixture.tsx"),
        `import { mountStatusPanelSendAutoOpenFixture } from ${JSON.stringify("/@fs/" + fixture)};\nmountStatusPanelSendAutoOpenFixture(document.getElementById("root"));`,
        "utf8",
      ),
      writeFile(
        join(temporary, "index.html"),
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><style>html,body,#root{height:100%;margin:0}</style></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>',
        "utf8",
      ),
    ]);
    const { createServer } = (await import(
      pathToFileURL(resolveTool("vite")).href
    )) as typeof import("vite");
    const { default: react } = (await import(
      pathToFileURL(resolveTool("@vitejs/plugin-react")).href
    )) as typeof import("@vitejs/plugin-react");
    const { default: tailwindcss } = (await import(
      pathToFileURL(resolveTool("@tailwindcss/vite")).href
    )) as typeof import("@tailwindcss/vite");
    server = await createServer({
      configFile: false,
      envFile: false,
      root: temporary,
      cacheDir: join(temporary, ".vite"),
      publicDir: false,
      plugins: [react(), tailwindcss()],
      resolve: {
        alias: [
          { find: "@", replacement: join(ROOT, "packages/ui/src") },
          ...[
            "react",
            "react-dom",
            "react-dom/client",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
            "@zcode/shared",
            "@zcode/shared/zcode-protocol-v4",
            "d3-path",
          ].map((name) => ({
            find: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"),
            replacement: uiRequire.resolve(name),
          })),
        ],
        dedupe: ["react", "react-dom"],
      },
      optimizeDeps: {
        include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
      },
      server: {
        host: "127.0.0.1",
        port: 0,
        hmr: false,
        watch: null,
        fs: { allow: [temporary, ROOT] },
      },
      define: {
        __ZCODE_VERSION__: '"fixture"',
        __ZCODE_ENV__: '"test"',
        __ZCODE_COMMIT__: '"fixture"',
      },
    });
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    const require = createRequire(resolveTool("playwright-core"));
    const { chromium } = require("playwright-core") as typeof import("playwright-core");
    browser = await chromium.launch({
      executablePath:
        process.env.CHROME_EXECUTABLE_PATH ??
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true,
      downloadsPath: join(temporary, "downloads"),
    });
    for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
      for (const [index, scenario] of scenarios.entries()) {
        await t.test(
          `${mode} ${scenario.name}`,
          {
            timeout: 45_000,
            skip:
              process.env.STATUS_PANEL_BROWSER_CASE !== undefined &&
              process.env.STATUS_PANEL_BROWSER_CASE !== `${mode}-${index}`,
          },
          async (caseTest) => {
            const mobile = mode === "web-remote-replayable";
            const context = await browser!.newContext({
              viewport: { width: mobile ? 390 : 1440, height: 900 },
              isMobile: mobile,
              hasTouch: mobile,
              serviceWorkers: "block",
            });
            let page: Page | undefined;
            const errors: string[] = [];
            const external: string[] = [];
            try {
              await context.route("**/*", (route) => {
                const url = route.request().url();
                if (/^https?:/u.test(url) && new URL(url).origin !== origin) {
                  external.push(url);
                  return route.abort();
                }
                return route.continue();
              });
              await context.addInitScript(() => {
                localStorage.clear();
                sessionStorage.clear();
              });
              page = await context.newPage();
              page.setDefaultTimeout(5_000);
              page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
              page.on("console", (message) => {
                if (message.type() === "error") errors.push(message.text());
              });
              page.on("websocket", (socket) => {
                if (new URL(socket.url()).host !== new URL(origin).host)
                  external.push(socket.url());
              });
              const query = new URLSearchParams({
                mode,
                content: scenario.content,
                draft: String(scenario.draft ?? false),
                fallback: String(scenario.fallback ?? false),
                strict: String(scenario.strict ?? false),
                locale: mobile ? "zh-CN" : "en-US",
              });
              await page.goto(`${origin}/?${query}`, {
                waitUntil: "domcontentloaded",
                timeout: 60_000,
              });
              await page.waitForFunction(() => window.__statusPanelSendTest?.audit.ready);
              await page.locator('[contenteditable="true"]').first().waitFor({ state: "visible" });
              if (!scenario.draft)
                await page.waitForFunction(
                  () =>
                    document
                      .querySelector('[data-session-id="fixture-status-send"]')
                      ?.getAttribute("data-projection-seq") === "1",
                );
              await assertStatusClosed(page);
              await scenario.run(page, mode);
              assert.deepEqual(
                await page.evaluate(() => window.__statusPanelSendTest.audit.forbidden),
                [],
                "不得执行真实副作用",
              );
              assert.deepEqual(external, [], "仅访问本地 Vite，不访问账号、模型、生产 Host 或外网");
              assert.deepEqual(errors, [], "真实组件无未捕获异常或 Console Error");
              assert.equal(
                await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
                false,
                "窄屏无横向溢出",
              );
            } catch (error) {
              caseTest.diagnostic(
                JSON.stringify({
                  errors,
                  external,
                  dom: page ? (await page.locator("body").innerText()).slice(0, 4000) : null,
                  audit: page
                    ? await page.evaluate(() => window.__statusPanelSendTest?.audit)
                    : null,
                }),
              );
              throw error;
            } finally {
              try {
                if (page) await page.evaluate(() => window.__statusPanelSendTest?.dispose());
              } finally {
                await context.close();
              }
            }
          },
        );
      }
    }
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }
});
