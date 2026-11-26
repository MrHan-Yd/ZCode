import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import {
  TID_MODEL_PROVIDER_API_FORMAT_ITEM,
  TID_MODEL_PROVIDER_API_FORMAT_TRIGGER,
  TID_MODEL_PROVIDER_API_KEY_INPUT,
  TID_MODEL_PROVIDER_BASE_URL_INPUT,
  testId,
} from "@zcode/shared";
import type {} from "./fixtures/modelProviderGeminiFormatFixture.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(ROOT, "package.json"));

const GEMINI_FORMAT = "gemini-generate-content";
const GEMINI_ITEM_TEST_ID = testId(TID_MODEL_PROVIDER_API_FORMAT_ITEM, GEMINI_FORMAT);

type FixtureCase = { locale: "zh-CN" | "en-US"; theme: "light" | "dark"; mobile: boolean };

const GEMINI_LABEL = "Gemini GenerateContent (/v1beta/models/{model}:generateContent)";

/**
 * 浏览器回归只在本机已有 Chrome/Chromium 时执行；CI 没有图形浏览器时跳过，
 * 不把平台路径写死成必失败。CHROME_EXECUTABLE_PATH 仍拥有最高优先级。
 */
function resolveChromeExecutable(): string | undefined {
  const candidates = [
    process.env.CHROME_EXECUTABLE_PATH,
    process.env.PROGRAMFILES
      ? join(process.env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe")
      : undefined,
    process.env["PROGRAMFILES(X86)"]
      ? join(process.env["PROGRAMFILES(X86)"], "Google/Chrome/Application/chrome.exe")
      : undefined,
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe")
      : undefined,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(candidate));
}

function localeCopy(locale: FixtureCase["locale"]) {
  return locale === "zh-CN"
    ? {
        apiFormatLabel: "API 格式",
        anthropicLabel: "Anthropic Messages (/v1/messages)",
        testModelTitle: "测试模型",
      }
    : {
        apiFormatLabel: "API format",
        anthropicLabel: "Anthropic messages (/v1/messages)",
        testModelTitle: "Test model",
      };
}

async function fixtureState(page: Page) {
  return page.evaluate(() => ({
    constants: window.__modelProviderGeminiFormatFixture.constants,
    saves: window.__modelProviderGeminiFormatFixture.saves,
    probes: window.__modelProviderGeminiFormatFixture.probes,
    events: window.__modelProviderGeminiFormatFixture.events,
  }));
}

async function waitForCard(page: Page) {
  await page.getByTestId("model-provider-header").waitFor({ state: "visible" });
  await page.getByTestId(TID_MODEL_PROVIDER_API_FORMAT_TRIGGER).waitFor({ state: "visible" });
}

async function readInputs(page: Page) {
  return {
    baseUrl: await page.getByTestId(TID_MODEL_PROVIDER_BASE_URL_INPUT).inputValue(),
    apiKey: await page.getByTestId(TID_MODEL_PROVIDER_API_KEY_INPUT).inputValue(),
  };
}

async function expectGeminiSelected(page: Page) {
  await page.waitForFunction(
    (target) =>
      document
        .querySelector(`[data-testid="${target}"]`)
        ?.textContent?.includes("Gemini GenerateContent"),
    TID_MODEL_PROVIDER_API_FORMAT_TRIGGER,
  );
  assert.equal(
    await page.getByTestId(TID_MODEL_PROVIDER_API_FORMAT_TRIGGER).innerText(),
    GEMINI_LABEL,
  );
}

async function exercise(page: Page, scenario: FixtureCase) {
  const copy = localeCopy(scenario.locale);
  await page.getByTestId("model-provider-header").waitFor({ state: "visible" });
  await page.getByText(copy.apiFormatLabel, { exact: true }).waitFor({ state: "visible" });

  // 初始仍是用户原有协议；URL/Key 是用户既有值。
  assert.equal(
    await page.getByTestId(TID_MODEL_PROVIDER_API_FORMAT_TRIGGER).innerText(),
    copy.anthropicLabel,
  );
  const initialInputs = await readInputs(page);
  const fixture = await fixtureState(page);
  assert.equal(initialInputs.baseUrl, fixture.constants.baseUrl);
  assert.equal(initialInputs.apiKey, fixture.constants.apiKey);
  assert.deepEqual(fixture.saves, []);

  // 选择 Gemini：菜单里应有原生 generateContent 路径的中英标签。
  await page.getByTestId(TID_MODEL_PROVIDER_API_FORMAT_TRIGGER).click();
  const geminiItem = page.getByTestId(GEMINI_ITEM_TEST_ID);
  await geminiItem.waitFor({ state: "visible" });
  assert.equal(await geminiItem.innerText(), GEMINI_LABEL);
  await geminiItem.click();

  await page.waitForFunction(() => window.__modelProviderGeminiFormatFixture.saves.length === 1);
  const afterSave = await fixtureState(page);
  assert.equal(afterSave.saves.length, 1);
  assert.equal(afterSave.saves[0]?.api?.type, GEMINI_FORMAT);
  // 切换到原生格式只新增稀疏 type，不改写用户 Base URL、Key 或 headers。
  assert.equal(afterSave.saves[0]?.api?.baseUrl, undefined);
  assert.equal(afterSave.saves[0]?.api?.headers, undefined);
  await expectGeminiSelected(page);
  assert.deepEqual(await readInputs(page), initialInputs);

  // 连接测试使用正式 providerId/modelId，并读取已保存的 Gemini 配置。
  await page.getByTitle(copy.testModelTitle, { exact: true }).click();
  await page.waitForFunction(() => window.__modelProviderGeminiFormatFixture.probes.length === 1);
  const afterProbe = await fixtureState(page);
  const probe = afterProbe.probes[0];
  assert.ok(probe);
  assert.equal(probe.providerId, afterProbe.constants.providerId);
  assert.equal(probe.modelId, afterProbe.constants.modelId);
  assert.equal(probe.apiFormat, GEMINI_FORMAT);
  assert.equal(probe.baseUrl, afterProbe.constants.baseUrl);
  assert.equal(probe.apiKey, afterProbe.constants.apiKey);
  assert.equal(probe.header, afterProbe.constants.headerValue);
  assert.deepEqual(afterProbe.events, [
    `save:${GEMINI_FORMAT}`,
    `probe:${afterProbe.constants.providerId}:${afterProbe.constants.modelId}`,
  ]);

  // 刷新后从持久化个人覆盖重读：格式仍是 Gemini，URL/Key 未变化，且没有幽灵保存。
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForCard(page);
  const afterReload = await fixtureState(page);
  // 页面重载会重建 fixture 内存记录；这里断言重读阶段没有触发新的保存。
  assert.equal(afterReload.saves.length, 0);
  await expectGeminiSelected(page);
  assert.deepEqual(await readInputs(page), initialInputs);

  await page.getByTitle(copy.testModelTitle, { exact: true }).click();
  await page.waitForFunction(() => window.__modelProviderGeminiFormatFixture.probes.length === 1);
  const afterReloadProbe = await fixtureState(page);
  assert.equal(afterReloadProbe.saves.length, 0);
  assert.deepEqual(afterReloadProbe.probes[0], probe);
  assert.deepEqual(afterReloadProbe.events, [
    `probe:${afterReloadProbe.constants.providerId}:${afterReloadProbe.constants.modelId}`,
  ]);
  assert.equal(afterReloadProbe.probes[0]?.apiFormat, GEMINI_FORMAT);

  const layout = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
}

test("供应商 Gemini 格式真实组件浏览器回归", { timeout: 300_000 }, async (t) => {
  const executablePath = resolveChromeExecutable();
  if (!executablePath) {
    t.skip("未找到 Chrome/Chromium；设置 CHROME_EXECUTABLE_PATH 或安装浏览器后运行真实组件回归");
    return;
  }
  const temporary = await mkdtemp(join(tmpdir(), "zcode-gemini-format-browser-"));
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  try {
    const fixturePath = join(
      ROOT,
      "packages/ui/test/fixtures/modelProviderGeminiFormatFixture.tsx",
    ).replaceAll("\\", "/");
    await Promise.all([
      writeFile(
        join(temporary, "fixture.tsx"),
        `import { mountModelProviderGeminiFormatFixture } from ${JSON.stringify("/@fs/" + fixturePath)}; mountModelProviderGeminiFormatFixture();`,
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
      executablePath,
      headless: true,
      downloadsPath: join(temporary, "downloads"),
    });
    const scenarios: FixtureCase[] = [
      { locale: "zh-CN", theme: "dark", mobile: false },
      { locale: "en-US", theme: "light", mobile: false },
      { locale: "zh-CN", theme: "light", mobile: true },
      { locale: "en-US", theme: "dark", mobile: true },
    ];
    for (const scenario of scenarios) {
      await t.test(
        `${scenario.locale}-${scenario.theme}-${scenario.mobile ? "mobile" : "desktop"}`,
        { timeout: 65_000 },
        async (caseTest) => {
          const context = await browser!.newContext({
            viewport: { width: scenario.mobile ? 390 : 1440, height: 900 },
            hasTouch: scenario.mobile,
            isMobile: scenario.mobile,
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
            await page.goto(`${origin}/?locale=${scenario.locale}&theme=${scenario.theme}`, {
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
