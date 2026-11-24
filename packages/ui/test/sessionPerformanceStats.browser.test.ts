import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import {
  buildRemoteWorkspaceIdentity,
  TID_CHAT_SESSION_STATS_PANEL,
  TID_CHAT_SESSION_STATS_TRIGGER,
  type Locale,
  type SessionPerformanceSnapshot as Snapshot,
} from "@zcode/shared";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(ROOT, "package.json"));
const WORKSPACE_PATH = "/synthetic/session-performance";
const AT = 1_767_225_600_000;
const ADAPTERS = "apps/zcode-cli/packages/adapters/src/storage/session-store";
const PROTOCOL = "apps/zcode-cli/packages/bootstrap/src/zcode-protocol";
const SAMPLES = [
  { id: "fixture-performance-parent", output: 5_281, duration: 195_313, ttft: 173_257 },
  { id: "fixture-performance-child-a", output: 11_522, duration: 342_695, ttft: 319_742 },
  { id: "fixture-performance-child-b", output: 9_164, duration: 267_169, ttft: 255_757 },
] as const;
const PARENT = SAMPLES[0].id;
const CHILD_IDS: string[] = SAMPLES.slice(1).map(({ id }) => id);
type Sources = readonly ("main_turn" | "subagent")[];
type Mapper<T> = (context: unknown, params: unknown) => Promise<T>;
interface BrowserCase {
  locale: Locale;
  theme: "zai-light" | "zai-dark";
  viewport: { width: number; height: number };
  workspaceIdentity?: string;
}
const speedText = (snapshot: Snapshot) => `${Math.round(snapshot.summary.tokensPerSecond!)} tok/s`;

async function loadSource(path: string): Promise<Record<string, unknown>> {
  // Node 加载真实 CLI query/mapper；UI 类型项目不跨 rootDir 包含 backend 实现。
  return import(pathToFileURL(join(ROOT, path)).href);
}

async function assertStat(page: Page, label: string, expected: string): Promise<void> {
  await page.waitForFunction(
    ({ panelId, label, expected }) => {
      const labels = document.querySelectorAll(`[data-testid="${panelId}"] span`);
      return Array.from(labels).some(
        (span) => span.textContent === label && span.nextElementSibling?.textContent === expected,
      );
    },
    { panelId: TID_CHAT_SESSION_STATS_PANEL, label, expected },
  );
}

async function assertLayout(page: Page): Promise<string> {
  const layout = await page.evaluate(() => ({
    viewport: innerWidth,
    width: document.documentElement.scrollWidth,
    background: getComputedStyle(document.querySelector("main")!).backgroundColor,
    boxes: Array.from(
      document.querySelectorAll(
        'main, footer, [data-testid="chat-status-sections-panel"], [data-testid="chat-session-stats-panel"], [data-subagent-speed="true"]',
      ),
    ).map((element) => {
      const box = element.getBoundingClientRect();
      return {
        left: box.left,
        right: box.right,
        width: box.width,
        height: box.height,
        scroll: element.scrollWidth,
        client: element.clientWidth,
      };
    }),
  }));
  assert.ok(layout.width <= layout.viewport, JSON.stringify(layout));
  for (const box of layout.boxes) {
    assert.ok(
      box.width > 0 && box.height > 0 && box.left >= -1 && box.right <= layout.viewport + 1,
      JSON.stringify(box),
    );
    assert.ok(box.scroll <= box.client + 1, JSON.stringify(box));
  }
  assert.notEqual(layout.background, "rgba(0, 0, 0, 0)", "真实产品样式必须加载");
  return layout.background;
}

async function exerciseStats(page: Page, fixture: BrowserCase, snapshots: Snapshot[]) {
  const average = speedText(snapshots[0]!);
  const trigger = page.getByTestId(TID_CHAT_SESSION_STATS_TRIGGER);
  await trigger.waitFor({ state: "visible", timeout: 45_000 });
  assert.equal(await trigger.innerText(), average);
  const section = page.locator('[data-status-section="agent"]');
  const speeds = section.locator('[data-subagent-speed="true"]');
  await speeds.waitFor({ state: "visible" });
  assert.equal(await speeds.innerText(), speedText(snapshots[1]!));
  await section.locator('[data-status-section-trigger="agent"]').click();
  for (const [index, id] of CHILD_IDS.entries()) {
    const row = section.locator(`li[data-child-session-id="${id}"]`);
    await row.locator('[data-subagent-speed="true"]').waitFor({ state: "visible" });
    assert.equal(
      await row.locator('[data-subagent-speed="true"]').innerText(),
      speedText(snapshots[index + 1]!),
    );
    assert.equal(await row.getByRole("button").count(), 1, "真实卡片保留 Stop");
  }
  if (fixture.viewport.width === 390) await trigger.tap();
  else await trigger.hover();
  await page.clock.runFor(32);
  const messages = fixture.locale === "zh-CN" ? zhCN : enUS;
  const avgLabel = messages["chat.sessionStats.averageSpeed"]!;
  const liveLabel = messages["chat.sessionStats.currentSpeed"]!;
  const assertSpeeds = async (current: string) => {
    await assertStat(page, avgLabel, average);
    await assertStat(page, liveLabel, current);
    assert.equal(await trigger.innerText(), current === "--" ? average : current);
  };
  await assertSpeeds("--");
  await page
    .getByText(messages["chat.sessionStats.title"]!, { exact: true })
    .waitFor({ state: "visible" });
  const background = await assertLayout(page);
  const publish = async (tokens: number, turnId = "turn-1", firstRowId = 1) => {
    await page.evaluate((input) => window.__sessionPerformanceStatsTest!.publish(input), {
      tokens,
      turnId,
      firstRowId,
    });
  };
  const tick = async () => {
    await page.clock.runFor(1_000);
  };
  const latest = async () =>
    page.evaluate(() => window.__sessionPerformanceStatsTest!.readings.at(-1)!);
  await publish(100);
  await tick();
  await assertSpeeds("--");
  const first = await latest();
  await publish(200);
  await tick();
  const second = await latest();
  assert.equal(second.at - first.at, 1_000);
  assert.equal(first.tokens, 100);
  assert.equal(second.tokens, 200);
  await assertSpeeds("≈ 100 tok/s");
  for (const boundary of [
    { turnId: "turn-2", firstRowId: 1 },
    { turnId: "turn-1", firstRowId: 0 },
    { turnId: "turn-1", firstRowId: 2 },
  ]) {
    await publish(100);
    await tick();
    const before = await latest();
    await publish(900, boundary.turnId, boundary.firstRowId);
    await tick();
    await assertSpeeds("--");
    const after = await latest();
    assert.equal(before.tokens, 100);
    assert.equal(after.tokens, 900);
    assert.equal(after.at - before.at, 1_000);
    assert.notEqual(
      after.scopeKey,
      before.scopeKey,
      "900 首样本只建新 scope 基线，不显示 800 tok/s",
    );
    await publish(1_000, boundary.turnId, boundary.firstRowId);
    await tick();
    await assertSpeeds("≈ 100 tok/s");
  }
  await page.evaluate(() => window.__sessionPerformanceStatsTest!.stop());
  await assertSpeeds("--");
  await publish(100, "waiting-setup");
  await tick();
  await publish(100, "waiting-output");
  await tick();
  await publish(200, "waiting-output");
  await tick();
  await assertSpeeds("≈ 100 tok/s");
  await page.clock.runFor(4_000);
  await assertSpeeds("--");
  await assertLayout(page);
  assert.doesNotMatch(await page.locator("body").innerText(), /(?:239|502|803|800) tok\/s/u);
  assert.deepEqual(
    await page.evaluate(() => window.__sessionPerformanceStatsTest!.forbidden),
    [],
    "不提交输入、不停止真实任务、不写设置",
  );
  return background;
}

test("真实会话 TPS 浏览器回归", { timeout: 300_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "zcode-session-stats-browser-"));
  let db: DatabaseSync | undefined;
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  const clients = new Map<string, BrowserCase>();
  try {
    const [storage, migrations, singleModule, batchModule] = await Promise.all([
      loadSource(`${ADAPTERS}/repositories/usage.ts`),
      loadSource(`${ADAPTERS}/migration-runner.ts`),
      loadSource(`${PROTOCOL}/session-performance.ts`),
      loadSource(`${PROTOCOL}/session-performance-batch.ts`),
    ]);
    const query = storage.querySessionPerformance as (
      db: DatabaseSync,
      input: { sessionID: string; querySources: Sources },
    ) => Promise<unknown>;
    const migrate = migrations.runSqliteSessionMigrations as (
      db: DatabaseSync,
      path: string,
    ) => void;
    const single = singleModule.querySessionPerformance as Mapper<Snapshot>;
    const batch = batchModule.querySessionPerformanceBatch as Mapper<{ entries: Snapshot[] }>;
    db = new DatabaseSync(":memory:");
    migrate(db, ":memory:");
    const insertSession =
      db.prepare(`insert into session (id, project_id, slug, directory, title, version, time_created, time_updated)
      values (?, 'fixture-project', 'fixture', ?, 'Synthetic performance', 'fixture', 0, 0)`);
    const insertModel =
      db.prepare(`insert into model_usage (id, logical_request_id, session_id, query_source, provider_id,
      model_id, status, started_at, duration_ms, time_to_first_token_ms, output_tokens)
      values (?, ?, ?, ?, 'fixture-provider', 'fixture-model', 'completed', ?, ?, ?, ?)`);
    for (const sample of SAMPLES) {
      insertSession.run(sample.id, WORKSPACE_PATH);
      insertModel.run(
        sample.id,
        sample.id,
        sample.id,
        sample.id === PARENT ? "main_turn" : "subagent",
        AT,
        sample.duration,
        sample.ttft,
        sample.output,
      );
    }
    const sourceAudit: Array<{ id: string; sources: Sources }> = [];
    const context = {
      sessions: new Map([[PARENT, { app: { sessionId: PARENT } }]]),
      deps: {
        sessionStore: {
          async querySessionPerformance(input: { sessionID: string; querySources: Sources }) {
            sourceAudit.push({ id: input.sessionID, sources: input.querySources });
            return query(db!, input);
          },
          async getSession(id: string) {
            return CHILD_IDS.includes(id) ? { parentID: PARENT } : null;
          },
        },
      },
    };
    const snapshots = [
      await single(context, { sessionId: PARENT }),
      ...(await batch(context, { sessionIds: CHILD_IDS })).entries,
    ];
    assert.equal(snapshots.length, SAMPLES.length);
    for (const [index, sample] of SAMPLES.entries()) {
      const snapshot = snapshots[index]!;
      assert.equal(snapshot.sessionId, sample.id);
      assert.equal(snapshot.summary.tokensPerSecond, (sample.output * 1_000) / sample.duration);
      assert.equal(snapshot.summary.modelMs, sample.duration);
      assert.equal(snapshot.summary.averageTtftMs, sample.ttft);
      t.diagnostic(
        `${sample.id}: ${snapshot.summary.tokensPerSecond!.toFixed(5)} → ${speedText(snapshot)}`,
      );
    }
    assert.deepEqual(
      sourceAudit,
      SAMPLES.map((sample) => ({
        id: sample.id,
        sources: [sample.id === PARENT ? "main_turn" : "subagent"],
      })),
    );
    const fixturePath = join(
      ROOT,
      "packages/ui/test/fixtures/sessionPerformanceStatsFixture.tsx",
    ).replaceAll("\\", "/");
    await Promise.all([
      writeFile(
        join(temporary, "fixture.tsx"),
        `import { mountSessionPerformanceStatsFixture } from ${JSON.stringify("/@fs/" + fixturePath)};\nawait mountSessionPerformanceStatsFixture(document.getElementById("root"));`,
        "utf8",
      ),
      writeFile(
        join(temporary, "index.html"),
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>',
        "utf8",
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
      plugins: [
        react(),
        tailwindcss(),
        {
          name: "readonly-session-performance-fixture",
          configureServer(vite) {
            vite.middlewares.use((request, response, next) => {
              if (!request.url?.startsWith("/__fixture/read")) return next();
              void (async () => {
                const key = new URL(request.url!, "http://fixture.invalid").searchParams.get(
                  "case",
                );
                const client = clients.get(key ?? "");
                assert.ok(client, "只能读取本地虚构 fixture");
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const { operation, params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                let result: unknown;
                if (operation === "bootstrap") {
                  result = {
                    ...client,
                    parentId: PARENT,
                    workspacePath: WORKSPACE_PATH,
                    children: CHILD_IDS.map((id, index) => ({
                      childSessionId: id,
                      agentId: `fixture-agent-${index}`,
                      subagentType: index ? "reviewer" : "backend-developer",
                      title: index ? "Synthetic review" : "Synthetic backend",
                      status: "running",
                      startedAt: AT - 60_000 - (2 - index) * 1_000,
                      controlWorkId: `fixture-work-${index}`,
                      cancellable: true,
                    })),
                  };
                } else {
                  assert.equal(params.workspacePath, WORKSPACE_PATH);
                  assert.equal(params.workspaceIdentity, client.workspaceIdentity);
                  if (operation === "single") {
                    assert.equal(params.sessionId, PARENT);
                    result = await single(context, { sessionId: params.sessionId });
                  } else {
                    assert.equal(operation, "batch");
                    assert.deepEqual([...params.sessionIds].sort(), [...CHILD_IDS].sort());
                    result = await batch(context, { sessionIds: params.sessionIds });
                  }
                }
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify(result));
              })().catch((error) => {
                response.statusCode = 500;
                response.end(String(error));
              });
            });
          },
        },
      ],
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
    // Windows CJS/ESM 互操作不可靠，chromium 沿用正式测试的 require 入口。
    const { chromium } = require("playwright-core") as typeof import("playwright-core");
    browser = await chromium.launch({
      executablePath:
        process.env.CHROME_EXECUTABLE_PATH ??
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true,
      downloadsPath: join(temporary, "downloads"),
    });
    const backgrounds = new Map<BrowserCase["theme"], string>();
    const scenarios = (["zh-CN", "en-US"] as const).flatMap((locale) =>
      (["zai-light", "zai-dark"] as const).flatMap((theme) =>
        [
          { width: 1440, height: 900 },
          { width: 390, height: 844 },
        ].map((viewport) => ({ locale, theme, viewport })),
      ),
    );
    for (const scenario of scenarios) {
      const { locale, theme, viewport } = scenario;
      const mobile = viewport.width === 390;
      const key = `${locale}-${theme}-${viewport.width}x${viewport.height}`;
      const fixture: BrowserCase = {
        ...scenario,
        ...(mobile
          ? {
              workspaceIdentity: buildRemoteWorkspaceIdentity(WORKSPACE_PATH, {
                kind: "ssh",
                host: "fixture.invalid",
                username: "fixture",
              }),
            }
          : {}),
      };
      clients.set(key, fixture);
      await t.test(key, { timeout: 60_000 }, async (scenarioTest) => {
        const browserContext = await browser!.newContext({
          viewport,
          locale,
          isMobile: mobile,
          hasTouch: mobile,
          colorScheme: theme === "zai-dark" ? "dark" : "light",
          serviceWorkers: "block",
        });
        const errors: string[] = [];
        const external: string[] = [];
        let page: Page | undefined;
        try {
          await browserContext.route("**/*", (route) => {
            const url = route.request().url();
            if (/^https?:/u.test(url) && new URL(url).origin !== origin) {
              external.push(url);
              return route.abort();
            }
            return route.continue();
          });
          page = await browserContext.newPage();
          page.setDefaultTimeout(10_000);
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
          });
          page.on("websocket", (socket) => {
            if (new URL(socket.url()).host !== new URL(origin).host) external.push(socket.url());
          });
          // 推进真实 hook 的 1 秒时钟而不替换 sampler，严格区分输出增量与 scope 首样本。
          await page.clock.install({ time: new Date(AT) });
          await page.clock.pauseAt(new Date(AT + 1_000));
          await page.goto(`${origin}/?case=${encodeURIComponent(key)}`, {
            waitUntil: "domcontentloaded",
            timeout: 60_000,
          });
          backgrounds.set(theme, await exerciseStats(page, fixture, snapshots));
          assert.deepEqual(external, [], "网络仅访问本地 fixture");
          assert.deepEqual(errors, [], "没有白屏、未捕获异常或 Console Error");
        } catch (error) {
          scenarioTest.diagnostic(
            JSON.stringify({
              errors,
              external,
              dom: page ? (await page.locator("body").innerText()).slice(0, 4_000) : null,
            }),
          );
          throw error;
        } finally {
          await browserContext.close();
          clients.delete(key);
        }
      });
    }
    assert.notEqual(
      backgrounds.get("zai-light"),
      backgrounds.get("zai-dark"),
      "真实 light/dark 样式不同",
    );
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        try {
          db?.close();
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      }
    }
  }
});
