import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import { TID_CHAT_CONTEXT_USAGE_TRIGGER, type Locale } from "@zcode/shared";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(ROOT, "package.json"));
interface BrowserCase {
  locale: Locale;
  theme: "light" | "dark";
  width: number;
  mobile?: boolean;
  fontSize?: string;
}

async function assertLayout(page: Page) {
  const layout = await page.locator('[data-slot="hover-card-content"]').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
      scroll: document.documentElement.scrollWidth,
      viewport: innerWidth,
      height: innerHeight,
      rows: Array.from(element.querySelectorAll(".grid > div")).map((row) => ({
        width: row.clientWidth,
        scroll: row.scrollWidth,
        height: row.getBoundingClientRect().height,
      })),
    };
  });
  assert.ok(layout.left >= -1 && layout.right <= layout.viewport + 1, JSON.stringify(layout));
  assert.ok(layout.top >= -1 && layout.bottom <= layout.height + 1, JSON.stringify(layout));
  assert.ok(layout.scroll <= layout.viewport, JSON.stringify(layout));
  for (const row of layout.rows)
    assert.ok(row.height > 0 && row.scroll <= row.width + 1, JSON.stringify(row));
}

async function exercise(page: Page, scenario: BrowserCase) {
  const messages = scenario.locale === "zh-CN" ? zhCN : enUS;
  const trigger = page.getByTestId(TID_CHAT_CONTEXT_USAGE_TRIGGER);
  const panel = page.locator('[data-slot="hover-card-content"]');
  const label = messages["chat.contextUsage.breakdown.subagents"]!;
  const sourceLabel = messages["chat.contextUsage.breakdown"]!;
  const title = messages["chat.contextUsage.title"]!;
  const cacheLabel = messages["chat.contextUsage.cacheHitRate"]!;
  const percent = (value: number) =>
    new Intl.NumberFormat(scenario.locale, { style: "percent", maximumFractionDigits: 1 }).format(
      value,
    );
  await trigger.waitFor({ state: "visible", timeout: 45_000 });
  if (scenario.mobile) await trigger.tap();
  else await trigger.hover();
  await panel.waitFor({ state: "visible" });
  await panel.getByText(label, { exact: true }).waitFor({ state: "visible" });
  const sources = panel.getByLabel(sourceLabel);
  const rows = sources.locator(".grid > div");
  assert.equal(await rows.count(), 5);
  assert.equal(await rows.last().innerText(), `${label}\n${percent(0.02)}`);
  const cacheRow = panel.getByText(cacheLabel, { exact: true }).locator("..");
  assert.equal(await cacheRow.innerText(), `${cacheLabel}\n${percent(0.982)}`);
  const titleRow = panel.getByText(title, { exact: true }).locator("..");
  const summary = await titleRow.innerText();
  await assertLayout(page);

  await page.evaluate(() =>
    window.__contextUsageSubagentsTest!.setBreakdown([
      { source: "messages", chars: 100 },
      { source: "subagents", chars: 300 },
      { source: "subagents", chars: 600 },
      { source: "skills", chars: 0 },
      { source: "system_prompt", chars: -1 },
      { source: "system_tool_schemas", chars: Number.NaN },
    ]),
  );
  await page.waitForFunction(
    ({ sourceLabel, label, expected }) => {
      const source = document.querySelector(`[aria-label="${sourceLabel}"]`);
      const last = source?.querySelector(".grid > div:last-child");
      return last?.textContent?.includes(label) && last?.textContent?.includes(expected);
    },
    { sourceLabel, label, expected: percent(0.9) },
  );
  assert.equal(await rows.count(), 2);
  assert.equal(
    await rows.last().innerText(),
    `${label}\n${percent(0.9)}`,
    "子代理占比最大时仍置于末行，重复来源合并",
  );
  assert.equal(await titleRow.innerText(), summary, "分类更新不改写 provider 总用量");
  assert.equal(await cacheRow.innerText(), `${cacheLabel}\n${percent(0.982)}`);
  await assertLayout(page);

  await page.evaluate(() =>
    window.__contextUsageSubagentsTest!.setBreakdown([
      { source: "messages", chars: 100 },
      { source: "subagents", chars: 0 },
    ]),
  );
  await panel.getByText(label, { exact: true }).waitFor({ state: "hidden" });
  assert.equal(await rows.count(), 1);
  assert.equal(
    await rows.first().innerText(),
    `${messages["chat.contextUsage.breakdown.messages"]}\n${percent(1)}`,
  );
  assert.doesNotMatch(await panel.innerText(), /NaN|Infinity/u);
  if (!scenario.mobile) {
    await page.mouse.move(0, 0);
    await panel.waitFor({ state: "hidden" });
    await trigger.focus();
    await panel.waitFor({ state: "visible" });
    await assertLayout(page);
  }
}

test("上下文浮层显示子代理来源且兼容桌面与手机", { timeout: 240_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "zcode-context-subagents-browser-"));
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  try {
    const fixturePath = join(
      ROOT,
      "packages/ui/test/fixtures/contextUsageSubagentsFixture.tsx",
    ).replaceAll("\\", "/");
    await Promise.all([
      writeFile(
        join(temporary, "fixture.tsx"),
        `import { mountContextUsageSubagentsFixture } from ${JSON.stringify("/@fs/" + fixturePath)}; mountContextUsageSubagentsFixture();`,
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
      { locale: "zh-CN", theme: "dark", width: 900 },
      { locale: "en-US", theme: "light", width: 900, fontSize: "18px" },
      { locale: "zh-CN", theme: "light", width: 390, mobile: true },
      { locale: "en-US", theme: "dark", width: 390, mobile: true },
    ];
    for (const scenario of scenarios) {
      await t.test(`${scenario.locale}-${scenario.theme}-${scenario.width}`, async () => {
        const context = await browser!.newContext({
          viewport: { width: scenario.width, height: 844 },
          isMobile: scenario.mobile ?? false,
          hasTouch: scenario.mobile ?? false,
          serviceWorkers: "block",
        });
        const page = await context.newPage();
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
          page.on("pageerror", (error) => errors.push(error.message));
          page.setDefaultTimeout(12_000);
          const query = new URLSearchParams({
            locale: scenario.locale,
            theme: scenario.theme,
            fontSize: scenario.fontSize ?? "14px",
          });
          await page.goto(`${origin}/?${query}`, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          await exercise(page, scenario);
          assert.deepEqual(errors, []);
          assert.deepEqual(external, []);
        } finally {
          await context.close();
        }
      });
    }
  } finally {
    await browser?.close();
    await server?.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
