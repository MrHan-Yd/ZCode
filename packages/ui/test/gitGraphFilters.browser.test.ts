import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import { GRAPH_IDENTITIES, GRAPH_NOW, GRAPH_PATH } from "./fixtures/gitGraphFiltersData.js";
import {
  GRAPH_IDS,
  graphDialog,
  lastGraphRequest,
  openGraph,
  waitGraphComplete,
} from "./fixtures/gitGraphFiltersBrowser.js";
import { exerciseGraphEntry, exerciseGraphLayout } from "./fixtures/gitGraphFiltersLayout.js";
import {
  exerciseGraphCombinedFilters,
  exerciseGraphDates,
  exerciseGraphPagination,
  exerciseGraphPaginationBurst,
  exerciseGraphSearch,
} from "./fixtures/gitGraphFiltersQueries.js";
import {
  exerciseGraphError,
  exerciseGraphInitialRace,
  exerciseGraphLateOptions,
  exerciseGraphMoreRace,
  exerciseGraphMissingOptions,
  exerciseGraphReopenRace,
  exerciseGraphScopeRace,
} from "./fixtures/gitGraphFiltersRaces.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(ROOT, "package.json"));
interface BrowserCase {
  name: string;
  exercise: (page: Page) => Promise<unknown>;
  width?: number;
  locale?: "en-US" | "zh-CN";
  theme?: "light" | "dark";
  detached?: boolean;
  legacy?: boolean;
  local?: boolean;
  empty?: boolean;
}

async function localScope(page: Page) {
  await openGraph(page);
  await waitGraphComplete(page);
  assert.equal((await lastGraphRequest(page)).request.workspaceIdentity, undefined);
  assert.equal((await lastGraphRequest(page)).request.workspacePath, GRAPH_PATH);
}
async function emptyRepository(page: Page) {
  await openGraph(page);
  await waitGraphComplete(page);
  await graphDialog(page).getByText("No commits", { exact: true }).waitFor({ state: "visible" });
  await page.getByTestId(GRAPH_IDS.bar).waitFor({ state: "visible" });
}

function graphCases(): BrowserCase[] {
  return [
    {
      name: "独立入口顺序/分支创建保留/浮层卸载与 Escape 焦点",
      exercise: (page) => exerciseGraphEntry(page),
    },
    {
      name: "干净 detached HEAD 可打开无伪造徽标",
      detached: true,
      exercise: (page) => exerciseGraphEntry(page, true),
    },
    {
      name: "文本/哈希/正文 OR、200ms 合并、Enter、正则与大小写、输入错误/零结果",
      exercise: exerciseGraphSearch,
    },
    { name: "完整分支 ref/作者姓名邮箱/日期/文本 AND", exercise: exerciseGraphCombinedFilters },
    { name: "四日期预设 [from,to) 精确边界/分页冻结/刷新重取时间", exercise: exerciseGraphDates },
    { name: "首批之外命中与深层 cursor 续读", exercise: (page) => exerciseGraphPagination(page) },
    {
      name: "旧端无 cursor 按 skip 兼容",
      legacy: true,
      exercise: (page) => exerciseGraphPagination(page, true),
    },
    {
      name: "即时 cursor 响应/连续 scroll 不重复 admission",
      exercise: (page) => exerciseGraphPaginationBurst(page, false),
    },
    {
      name: "即时旧端 skip 响应/连续 scroll 不重复 admission",
      legacy: true,
      exercise: (page) => exerciseGraphPaginationBurst(page, true),
    },
    { name: "输入瞬间丢弃迟到 initial（debounce 尚未请求）", exercise: exerciseGraphInitialRace },
    { name: "分页途中改变条件丢旧响应/复位展开详情", exercise: exerciseGraphMoreRace },
    { name: "关闭再开丢旧 initial", exercise: (page) => exerciseGraphReopenRace(page, false) },
    { name: "关闭再开丢旧 loadMore", exercise: (page) => exerciseGraphReopenRace(page, true) },
    {
      name: "相同 path 不同 identity 清图谱意图与旧响应",
      exercise: (page) => exerciseGraphScopeRace(page, false),
    },
    {
      name: "相同 path/identity 不同 service 清图谱意图与旧响应",
      exercise: (page) => exerciseGraphScopeRace(page, true),
    },
    { name: "迟到 options 不随文本查询代次失效", exercise: exerciseGraphLateOptions },
    { name: "刷新后已选分支/用户候选消失不伪装All", exercise: exerciseGraphMissingOptions },
    { name: "backend 错误仍保留可操作筛选栏", exercise: exerciseGraphError },
    { name: "本地无 identity 保留 path fallback", local: true, exercise: localScope },
    { name: "空仓库区别于零匹配且保留筛选栏", empty: true, exercise: emptyRepository },
  ];
}

test("真实 Git 工具入口到图谱单行筛选浏览器回归", { timeout: 360_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "zcode-git-graph-filters-"));
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  try {
    const fixturePath = join(
      ROOT,
      "packages/ui/test/fixtures/gitGraphFiltersFixture.tsx",
    ).replaceAll("\\", "/");
    await Promise.all([
      writeFile(
        join(temporary, "fixture.tsx"),
        `import { mountGitGraphFiltersFixture } from ${JSON.stringify("/@fs/" + fixturePath)}; mountGitGraphFiltersFixture();`,
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
    const backgrounds = new Map<string, string>();
    const cases = graphCases();
    for (const locale of ["en-US", "zh-CN"] as const) {
      for (const theme of ["light", "dark"] as const) {
        for (const width of [1440, 390, 320]) {
          cases.push({
            name: `${locale}/${theme}/${width}px 真实样式单行/栏内横滚`,
            locale,
            theme,
            width,
            exercise: async (page) => {
              const background = await exerciseGraphLayout(page, width < 640, locale === "zh-CN");
              backgrounds.set(theme, background);
            },
          });
        }
      }
    }
    for (const scenario of cases) {
      await t.test(scenario.name, { timeout: 45_000 }, async (caseTest) => {
        const width = scenario.width ?? 1024;
        const context = await browser!.newContext({
          viewport: { width, height: 844 },
          locale: scenario.locale ?? "en-US",
          hasTouch: width < 640,
          isMobile: width < 640,
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
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
          });
          page.on("websocket", (socket) => {
            if (new URL(socket.url()).host !== new URL(origin).host) external.push(socket.url());
          });
          page.setDefaultTimeout(8_000);
          // Playwright 时钟驱动真实 hook 的 timer；不注入查询实现或改写 UI 内部状态。
          await page.clock.install({ time: new Date(GRAPH_NOW) });
          await page.clock.pauseAt(new Date(GRAPH_NOW + 1_000));
          const query = new URLSearchParams({
            locale: scenario.locale ?? "en-US",
            theme: scenario.theme ?? "light",
            detached: String(scenario.detached ?? false),
            legacy: String(scenario.legacy ?? false),
            local: String(scenario.local ?? false),
            empty: String(scenario.empty ?? false),
          });
          await page.goto(`${origin}/?${query}`, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          await scenario.exercise(page);
          assert.deepEqual(
            await page.evaluate(() => window.__gitGraphFiltersTest.forbidden),
            [],
            "不运行 Git 写入/真实 Agent/平台原生操作",
          );
          const options = await page.evaluate(() => window.__gitGraphFiltersTest.optionRequests);
          assert.ok(options.every(({ request }) => request.workspacePath === GRAPH_PATH));
          if (!scenario.local)
            assert.ok(
              options.every(({ request }) => GRAPH_IDENTITIES.includes(request.workspaceIdentity!)),
            );
          assert.deepEqual(external, [], "网络仅访问本机虚构 fixture");
          assert.deepEqual(errors, [], "没有白屏、Console Error 或未捕获异常");
        } catch (error) {
          caseTest.diagnostic(
            JSON.stringify({
              errors,
              external,
              requests: await page
                .evaluate(() => window.__gitGraphFiltersTest?.requests)
                .catch(() => null),
              dom: (await page.locator("body").innerText()).slice(0, 3_000),
            }),
          );
          throw error;
        } finally {
          await context.close();
        }
      });
    }
    assert.notEqual(backgrounds.get("light"), backgrounds.get("dark"), "真实浅/深主题不同");
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
