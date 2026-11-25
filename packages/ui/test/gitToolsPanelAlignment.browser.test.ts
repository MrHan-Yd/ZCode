import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import {
  TID_CHAT_STATUS_ENTRY,
  TID_CHAT_STATUS_SECTIONS_PANEL,
  TID_GIT_TOOLS_ENTRY,
  TID_GIT_TOOLS_PANEL,
  TID_WORKSPACE_HEADER,
} from "@zcode/shared";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(ROOT, "package.json"));
interface BrowserCase {
  platform: "win32" | "darwin" | "linux" | "web" | "mobile";
  width: number;
  locale: "zh-CN" | "en-US";
  theme: "light" | "dark";
  sidePane?: "open";
  fontSize?: string;
  sidebar?: "hidden";
}

async function measure(page: Page, panelId: string) {
  return page.evaluate(
    ({ panelId, headerId }) => {
      const boxes = [
        `[data-testid="${panelId}"]`,
        `[data-testid="${headerId}"]`,
        '[data-testid="fixture-conversation-body"]',
        '[data-testid="fixture-conversation-message"]',
      ].map((selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, width: rect.width };
      });
      return {
        panel: boxes[0]!,
        header: boxes[1]!,
        body: boxes[2]!,
        message: boxes[3]!,
        viewport: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    },
    { panelId, headerId: TID_WORKSPACE_HEADER },
  );
}

async function assertGitAlignment(page: Page) {
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="git-tools-panel"]')!;
    return (
      parseFloat(getComputedStyle(panel).getPropertyValue("--radix-popover-trigger-width")) > 0 &&
      panel.getAnimations().every((animation) => animation.playState === "finished")
    );
  });
  const layout = await measure(page, TID_GIT_TOOLS_PANEL);
  assert.ok(
    Math.abs(layout.body.right - layout.panel.right - 16) <= 1,
    `Git 浮层必须与会话状态使用同一个 16px 右边距：${JSON.stringify(layout)}`,
  );
  assert.ok(layout.panel.width > 0 && layout.panel.width <= 320, JSON.stringify(layout));
  assert.ok(
    layout.panel.left >= 16 && layout.panel.right <= layout.viewport - 16 + 1,
    JSON.stringify(layout),
  );
  assert.ok(layout.panel.top >= layout.header.top + 38, "Git 浮层保持在标题栏按钮下方");
  assert.ok(layout.scrollWidth <= layout.viewport, JSON.stringify(layout));
  return layout;
}

async function exercise(page: Page, fixture: BrowserCase) {
  const entry = page.getByTestId(TID_GIT_TOOLS_ENTRY);
  const gitPanel = page.getByTestId(TID_GIT_TOOLS_PANEL);
  const statusPanel = page.getByTestId(TID_CHAT_STATUS_SECTIONS_PANEL);
  await entry.waitFor({ state: "visible" });
  const before = await page.getByTestId("fixture-conversation-message").boundingBox();
  await entry.click();
  await gitPanel.waitFor({ state: "visible" });
  const gitLayout = await assertGitAlignment(page);
  assert.deepEqual(
    await page.getByTestId("fixture-conversation-message").boundingBox(),
    before,
    "打开浮层不挤动正文",
  );
  assert.equal(await entry.getAttribute("aria-expanded"), "true");
  if (fixture.platform === "win32" && fixture.width === 530) {
    for (const width of [390, 1024, 530]) {
      await page.setViewportSize({ width, height: 844 });
      await page.waitForFunction(() => {
        const body = document
          .querySelector('[data-testid="fixture-conversation-body"]')!
          .getBoundingClientRect();
        const panel = document
          .querySelector('[data-testid="git-tools-panel"]')!
          .getBoundingClientRect();
        return Math.abs(body.right - panel.right - 16) <= 1;
      });
      await assertGitAlignment(page);
    }
  }
  await page.keyboard.press("Escape");
  await gitPanel.waitFor({ state: "hidden" });
  assert.equal(
    await entry.evaluate((element) => document.activeElement === element),
    true,
    "关闭后焦点回到真实 Git 按钮",
  );
  await page.getByTestId(TID_CHAT_STATUS_ENTRY).click();
  await statusPanel.waitFor({ state: "visible" });
  const statusLayout = await measure(page, TID_CHAT_STATUS_SECTIONS_PANEL);
  assert.ok(
    Math.abs(statusLayout.body.right - statusLayout.panel.right - 16) <= 1,
    "会话状态保留既有 16px 右边距",
  );
  assert.ok(
    Math.abs(gitLayout.panel.right - statusLayout.panel.right) <= 1,
    "Git 与会话状态右边缘一致",
  );
  await entry.click();
  await gitPanel.waitFor({ state: "visible" });
  await statusPanel.waitFor({ state: "hidden" });
  await assertGitAlignment(page);
  await entry.click();
  await gitPanel.waitFor({ state: "hidden" });
  assert.equal(await entry.getAttribute("aria-expanded"), "false");
  await entry.focus();
  await page.keyboard.press("Enter");
  await gitPanel.waitFor({ state: "visible" });
  await assertGitAlignment(page);
  await page.getByTestId("fixture-conversation-body").click({ position: { x: 8, y: 400 } });
  await gitPanel.waitFor({ state: "hidden" });
  assert.equal(await page.getByTestId("fixture-forbidden").textContent(), "");
}

test("Git 工具浮层与会话状态右边距一致", { timeout: 240_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "zcode-git-panel-alignment-"));
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  try {
    const fixturePath = join(
      ROOT,
      "packages/ui/test/fixtures/gitToolsPanelAlignmentFixture.tsx",
    ).replaceAll("\\", "/");
    await Promise.all([
      writeFile(
        join(temporary, "fixture.tsx"),
        `import { mountGitToolsPanelAlignmentFixture } from ${JSON.stringify("/@fs/" + fixturePath)}; mountGitToolsPanelAlignmentFixture();`,
      ),
      writeFile(
        join(temporary, "index.html"),
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>',
      ),
    ]);
    const { createServer } = (await import(
      pathToFileURL(require.resolve("vite")).href
    )) as typeof import("vite");
    const { default: react } = (await import(
      pathToFileURL(require.resolve("@vitejs/plugin-react")).href
    )) as typeof import("@vitejs/plugin-react");
    const { default: tailwindcss } = (await import(
      pathToFileURL(require.resolve("@tailwindcss/vite")).href
    )) as typeof import("@tailwindcss/vite");
    const uiRequire = createRequire(join(ROOT, "packages/ui/package.json"));
    const aliases = [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "react/jsx-dev-runtime",
      "@zcode/shared",
      "@zcode/shared/zcode-protocol-v4",
      "@zcode/provider",
      "@zcode/rpc",
      "d3-path",
    ].map((name) => ({
      find: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"),
      replacement: uiRequire.resolve(name),
    }));
    server = await createServer({
      configFile: false,
      envFile: false,
      root: temporary,
      cacheDir: join(temporary, ".vite"),
      publicDir: false,
      plugins: [react(), tailwindcss()],
      resolve: {
        alias: [{ find: "@", replacement: join(ROOT, "packages/ui/src") }, ...aliases],
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
    const { chromium } = require("playwright-core") as typeof import("playwright-core");
    browser = await chromium.launch({
      executablePath:
        process.env.CHROME_EXECUTABLE_PATH ??
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true,
      downloadsPath: join(temporary, "downloads"),
    });
    const scenarios: BrowserCase[] = [
      { platform: "win32", width: 530, locale: "zh-CN", theme: "dark" },
      { platform: "win32", width: 1440, locale: "en-US", theme: "light", fontSize: "18px" },
      {
        platform: "win32",
        width: 900,
        locale: "zh-CN",
        theme: "light",
        sidePane: "open",
        sidebar: "hidden",
      },
      { platform: "darwin", width: 900, locale: "zh-CN", theme: "dark" },
      { platform: "linux", width: 900, locale: "en-US", theme: "light" },
      { platform: "web", width: 1440, locale: "en-US", theme: "dark" },
      { platform: "mobile", width: 390, locale: "zh-CN", theme: "light" },
      { platform: "mobile", width: 320, locale: "en-US", theme: "dark" },
    ];
    for (const scenario of scenarios) {
      await t.test(
        `${scenario.platform}-${scenario.width}-${scenario.locale}-${scenario.theme}`,
        async (caseTest) => {
          const mobile = scenario.platform === "mobile";
          const context = await browser!.newContext({
            viewport: { width: scenario.width, height: 844 },
            hasTouch: mobile,
            isMobile: mobile,
            serviceWorkers: "block",
          });
          const errors: string[] = [];
          const external: string[] = [];
          const page = await context.newPage();
          try {
            await context.route("**/*", (route) => {
              const url = route.request().url();
              if (/^https?:/u.test(url) && new URL(url).origin !== origin) {
                external.push(url);
                return route.abort();
              }
              return route.continue();
            });
            page.on("pageerror", (error) => errors.push(error.message));
            page.setDefaultTimeout(12_000);
            const query = new URLSearchParams({
              platform: scenario.platform,
              locale: scenario.locale,
              theme: scenario.theme,
              sidePane: scenario.sidePane ?? "closed",
              fontSize: scenario.fontSize ?? "14px",
              sidebar: scenario.sidebar ?? "visible",
            });
            await page.goto(`${origin}/?${query}`, {
              waitUntil: "domcontentloaded",
              timeout: 60_000,
            });
            await exercise(page, scenario);
            assert.deepEqual(errors, []);
            assert.deepEqual(external, []);
          } catch (error) {
            caseTest.diagnostic(
              JSON.stringify({
                errors,
                external,
                anchors: await page
                  .locator('[data-slot="popover-anchor"]')
                  .evaluateAll((elements) =>
                    elements.map((element) => {
                      const style = getComputedStyle(element);
                      return {
                        html: element.outerHTML,
                        box: element.getBoundingClientRect().toJSON(),
                        display: style.display,
                        position: style.position,
                        width: style.width,
                        offsetParent: (element as HTMLElement).offsetParent?.outerHTML.slice(
                          0,
                          400,
                        ),
                      };
                    }),
                  ),
                dom: (await page.locator("body").innerText()).slice(0, 2500),
              }),
            );
            throw error;
          } finally {
            await context.close();
          }
        },
      );
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
