import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import type { GitGenerateCommitMessageRequest } from "@zcode/shared";
import { TID_GIT_COMMIT_MESSAGE_MODEL_TRIGGER, TID_GIT_TOOLS_ENTRY } from "@zcode/shared";
import type {} from "./fixtures/gitCommitMessageModelFixture.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(ROOT, "package.json"));
const a = { providerId: "fixture-channel-a", modelId: "session-model-a" };
const b = { providerId: "fixture-channel-b", modelId: "session-model-b" };
const pinned = { providerId: "fixture-channel-pinned", modelId: "fixed-model" };

type FixtureCase = { locale: "zh-CN" | "en-US"; theme: "light" | "dark"; mobile: boolean };

async function choose(page: Page, triggerId: string, model: string) {
  await page.getByTestId(triggerId).click();
  const channel = [a, b, pinned].find((selection) => selection.modelId === model)?.providerId;
  assert.ok(channel);
  await page.locator(`[data-model-provider-key="registry-provider:${channel}"]`).click();
  await page.getByText(model, { exact: true }).last().click();
}

async function openCommit(page: Page) {
  await page.getByTestId(TID_GIT_TOOLS_ENTRY).click();
  await page.getByTestId("git-action-trigger").click();
  await page.getByTestId("git-commit-dialog").waitFor({ state: "visible" });
  await page.getByTestId("git-commit-generate-button").waitFor({ state: "visible" });
}

async function closeCommit(page: Page) {
  await page.keyboard.press("Escape");
  await page.getByTestId("git-commit-dialog").waitFor({ state: "hidden" });
  const panel = page.getByTestId("git-tools-panel");
  if (await panel.isVisible()) await page.keyboard.press("Escape");
}

async function generate(page: Page, expected: typeof a): Promise<GitGenerateCommitMessageRequest> {
  const before = await page.evaluate(() => window.__gitModelFixture.requests.length);
  await page.getByTestId("git-commit-generate-button").click();
  await page.waitForFunction((count) => window.__gitModelFixture.requests.length > count, before);
  const request = await page.evaluate(() => window.__gitModelFixture.requests.at(-1)!);
  assert.equal(request.selection?.providerId, expected.providerId);
  assert.equal(request.selection?.modelId, expected.modelId);
  await page.waitForFunction((modelId) => {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="git-commit-message-input"]',
    );
    return input?.value === `chore: ${modelId}`;
  }, expected.modelId);
  assert.equal(
    await page.getByTestId("git-commit-message-input").inputValue(),
    `chore: ${expected.modelId}`,
  );
  return request;
}

async function waitForComposerModel(page: Page, modelId: string) {
  await page.waitForFunction(
    (model) =>
      document
        .querySelector('[data-testid="fixture-composer-model"]')
        ?.textContent?.includes(model),
    modelId,
  );
}

async function exerciseClosedGeneration(page: Page, rejected: boolean) {
  await openCommit(page);
  const count = await page.evaluate(() => {
    window.__gitModelFixture.holdGeneration();
    return window.__gitModelFixture.requests.length;
  });
  await page.getByTestId("git-commit-generate-button").click();
  await page.waitForFunction(
    (previous) => window.__gitModelFixture.requests.length > previous,
    count,
  );
  await closeCommit(page);
  await openCommit(page);
  await page.evaluate(async (failure) => {
    window.__gitModelFixture.setFailure(failure);
    await window.__gitModelFixture.releaseGeneration();
    window.__gitModelFixture.setFailure(false);
  }, rejected);
  assert.equal(
    await page.getByTestId("git-commit-message-input").inputValue(),
    "",
    "旧生成不回写重开的弹窗",
  );
  assert.equal(await page.getByTestId("git-commit-dialog").locator(".text-destructive").count(), 0);
  await generate(page, b);
  await closeCommit(page);
}

async function exercise(page: Page, fixture: FixtureCase) {
  await page.getByTestId("fixture-composer-model").waitFor({ state: "visible" });
  await waitForComposerModel(page, a.modelId);
  await openCommit(page);
  await generate(page, a);
  assert.deepEqual(await page.evaluate(() => window.__gitModelFixture.mutations), []);
  await page.evaluate(
    (selection) => window.__gitModelFixture.setModel(selection.providerId, selection.modelId),
    b,
  );
  await waitForComposerModel(page, b.modelId);
  await generate(page, b);
  await page.evaluate(
    (selection) => window.__gitModelFixture.setModel(selection.providerId, selection.modelId),
    a,
  );
  await waitForComposerModel(page, a.modelId);
  await generate(page, a);
  await closeCommit(page);
  await choose(page, "fixture-composer-model", b.modelId);
  await openCommit(page);
  await generate(page, b);
  await closeCommit(page);
  await choose(page, TID_GIT_COMMIT_MESSAGE_MODEL_TRIGGER, pinned.modelId);
  await page.waitForFunction(
    () =>
      window.__gitModelFixture.patches.at(-1)?.gitCommitMessageModelSelection?.modelId ===
      "fixed-model",
  );
  await openCommit(page);
  await generate(page, pinned);
  await page.evaluate(() => window.__gitModelFixture.setFailure(true));
  const beforeFailure = await page.evaluate(() => window.__gitModelFixture.requests.length);
  await page.getByTestId("git-commit-generate-button").click();
  await page.waitForFunction(
    (count) => window.__gitModelFixture.requests.length > count,
    beforeFailure,
  );
  await page
    .getByText(
      fixture.locale === "zh-CN"
        ? "生成提交消息失败，请重试或手动填写。"
        : "Commit message generation failed. Try again or enter one manually.",
      { exact: true },
    )
    .waitFor();
  const failed = await page.evaluate(() => window.__gitModelFixture.requests.at(-1)!);
  assert.equal(failed.selection?.providerId, pinned.providerId, "请求失败不换默认渠道");
  assert.equal(failed.selection?.modelId, pinned.modelId);
  assert.equal(
    await page.evaluate(() => window.__gitModelFixture.requests.length),
    beforeFailure + 1,
  );
  await page.evaluate(() => window.__gitModelFixture.setFailure(false));
  await generate(page, pinned);
  await closeCommit(page);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForComposerModel(page, b.modelId);
  await openCommit(page);
  await generate(page, pinned);
  await closeCommit(page);
  await page.getByTestId(TID_GIT_COMMIT_MESSAGE_MODEL_TRIGGER).click();
  await page
    .getByText(fixture.locale === "zh-CN" ? "跟随当前会话" : "Follow current session", {
      exact: true,
    })
    .last()
    .click();
  await page.waitForFunction(
    () => window.__gitModelFixture.patches.at(-1)?.gitCommitMessageModelSelection === null,
  );
  await openCommit(page);
  await generate(page, b);
  await closeCommit(page);
  await page.evaluate(() =>
    window.__gitModelFixture.setScope("fixture-session-b", "synthetic-remote-a"),
  );
  await waitForComposerModel(page, b.modelId);
  await openCommit(page);
  const remote = await generate(page, b);
  assert.equal(remote.workspaceIdentity, "synthetic-remote-a");
  await closeCommit(page);
  await page.evaluate(() => window.__gitModelFixture.setScope("fixture-session-a"));
  await waitForComposerModel(page, b.modelId);
  await openCommit(page);
  const beforeStale = await page.evaluate(() => {
    window.__gitModelFixture.holdGeneration();
    return window.__gitModelFixture.requests.length;
  });
  await page.getByTestId("git-commit-action-item-commitAndPush").click();
  await page.waitForFunction(
    (count) => window.__gitModelFixture.requests.length > count,
    beforeStale,
  );
  await page.evaluate(() =>
    window.__gitModelFixture.setScope("fixture-session-b", "synthetic-remote-b"),
  );
  await page.getByTestId("git-commit-dialog").waitFor({ state: "hidden" });
  await page.evaluate(() => window.__gitModelFixture.releaseGeneration());
  assert.deepEqual(
    await page.evaluate(() => window.__gitModelFixture.mutations),
    [],
    "切 scope 后旧生成不得继续暂存、提交或推送",
  );
  await page.evaluate(() => window.__gitModelFixture.setScope("fixture-session-a"));
  await exerciseClosedGeneration(page, false);
  await exerciseClosedGeneration(page, true);
  await openCommit(page);
  await page.getByTestId("git-commit-message-input").fill("");
  const beforeCommit = await page.evaluate(() => window.__gitModelFixture.requests.length);
  await page.getByTestId("git-commit-action-item-commit").click();
  await page.waitForFunction(() => window.__gitModelFixture.mutations.includes("commit"));
  assert.equal(
    await page.evaluate(() => window.__gitModelFixture.requests.length),
    beforeCommit + 1,
  );
  const last = await page.evaluate(() => window.__gitModelFixture.requests.at(-1)!);
  assert.equal(last.selection?.modelId, b.modelId, "留空提交与生成按钮使用同一模型");
  assert.deepEqual(await page.evaluate(() => window.__gitModelFixture.mutations), [
    "stage",
    "commit",
  ]);
  await page.getByTestId("git-commit-dialog").waitFor({ state: "hidden" });
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__gitModelFixture.clearModel());
  await waitForComposerModel(page, "No model");
  await openCommit(page);
  const beforeMissing = await page.evaluate(() => window.__gitModelFixture.requests.length);
  await page.getByTestId("git-commit-generate-button").click();
  await page
    .getByText(
      fixture.locale === "zh-CN"
        ? "生成提交消息失败，请重试或手动填写。"
        : "Commit message generation failed. Try again or enter one manually.",
      { exact: true },
    )
    .waitFor();
  assert.equal(
    await page.evaluate(() => window.__gitModelFixture.requests.length),
    beforeMissing,
    "明确无模型不偷用Host默认值",
  );
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  assert.ok(layout.scroll <= layout.width + 1, JSON.stringify(layout));
}

test("提交消息设置真实浏览器回归", { timeout: 300_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "zcode-git-model-browser-"));
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  try {
    const fixturePath = join(
      ROOT,
      "packages/ui/test/fixtures/gitCommitMessageModelFixture.tsx",
    ).replaceAll("\\", "/");
    await Promise.all([
      writeFile(
        join(temporary, "fixture.tsx"),
        `import { mountGitCommitMessageModelFixture } from ${JSON.stringify("/@fs/" + fixturePath)}; mountGitCommitMessageModelFixture();`,
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
