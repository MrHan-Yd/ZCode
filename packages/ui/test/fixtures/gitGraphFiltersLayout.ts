import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { TID_GIT_TOOLS_ENTRY, TID_GIT_TOOLS_PANEL } from "@zcode/shared";
import {
  GRAPH_IDS,
  assertGraphSubject,
  chooseGraphOption,
  closeGraph,
  graphControl,
  graphDialog,
  graphRequests,
  graphText,
  locatorBox,
  openGraph,
  waitGraphComplete,
} from "./gitGraphFiltersBrowser.js";

export async function exerciseGraphEntry(page: Page, detached = false) {
  const trigger = page.getByTestId(TID_GIT_TOOLS_ENTRY);
  await trigger.waitFor({ state: "visible", timeout: 45_000 });
  if (detached) {
    assert.equal(await trigger.getAttribute("data-git-badge-count"), null);
    assert.equal(await trigger.getAttribute("data-git-badge-kind"), null);
  }
  await trigger.click();
  const panel = page.getByTestId(TID_GIT_TOOLS_PANEL);
  await panel.waitFor({ state: "visible" });
  const branch = panel.getByRole("button", { name: /^(?:Switch Git branch|切换 Git 分支)$/u });
  const graph = panel.getByTestId(GRAPH_IDS.entry);
  assert.equal(await graph.count(), 1, "Git 工具中图谱只有独立入口");
  const branchBox = await locatorBox(branch);
  const graphBox = await locatorBox(graph);
  const commitBox = await locatorBox(panel.getByTestId("git-action-trigger"));
  assert.ok(branchBox.y + branchBox.height <= graphBox.y + 1, "图谱行在分支行之后");
  assert.ok(graphBox.y + graphBox.height <= commitBox.y + 1, "图谱行在提交行之前");
  await branch.click();
  const create = page.getByRole("button", {
    name: /^(?:Create and switch to new branch\.\.\.|创建并检出新分支\.\.\.)$/u,
  });
  await create.waitFor({ state: "visible" });
  const branchMenu = create.locator('xpath=ancestor::*[@data-slot="popover-content"]');
  assert.equal(
    await branchMenu.getByText(/^(?:Git Graph|Git 图谱)$/u).count(),
    0,
    "分支菜单移除图谱但保留创建分支",
  );
  await page.keyboard.press("Escape");
  await page.clock.runFor(32);
  if (!(await panel.isVisible())) await trigger.click();
  await panel.waitFor({ state: "visible" });
  await graph.click();
  await graphDialog(page).waitFor({ state: "visible" });
  await page.clock.runFor(32);
  await panel.waitFor({ state: "hidden" });
  await waitGraphComplete(page);
  await assertGraphSubject(page, "Literal a.b [keep]");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  await page.evaluate(() => window.__gitGraphFiltersTest.closeTools());
  await page.clock.runFor(32);
  await assertGraphSubject(page, "Literal a.b [keep]");
  assert.equal(
    await graphRequests(page).then((requests) => requests.length),
    1,
    "浮层收起不能重挂图谱/query",
  );
  await closeGraph(page);
  assert.equal(
    await trigger.evaluate((element) => document.activeElement === element),
    true,
    "Escape 关闭后焦点回真实 Git 按钮",
  );
}

export async function assertGraphFilterLayout(page: Page, mobile: boolean) {
  await page.waitForFunction(
    () => document.getAnimations().every((animation) => animation.playState === "finished"),
    undefined,
    { polling: 25 },
  );
  const layout = await page.evaluate((ids) => {
    const scroll = document.querySelector(`[data-testid="${ids.scroll}"]`)!;
    const bar = document.querySelector(`[data-testid="${ids.bar}"]`)!;
    const input = document.querySelector(`[data-testid="${ids.text}"]`)!;
    const regex = document.querySelector(`[data-testid="${ids.regex}"]`)!;
    const caseToggle = document.querySelector(`[data-testid="${ids.caseSensitive}"]`)!;
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      dialog: document
        .querySelector(`[data-testid="${ids.dialog}"]`)!
        .getBoundingClientRect()
        .toJSON(),
      controls: [ids.text, ids.regex, ids.caseSensitive, ids.branch, ids.author, ids.date].map(
        (id) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().toJSON(),
      ),
      scroll: {
        box: scroll.getBoundingClientRect().toJSON(),
        width: scroll.scrollWidth,
        client: scroll.clientWidth,
        overflow: getComputedStyle(scroll).overflowX,
      },
      wraps: getComputedStyle(bar).flexWrap,
      sameTextGroup:
        input.closest('[data-slot="input-group"]') === regex.closest('[data-slot="input-group"]') &&
        input.closest('[data-slot="input-group"]') ===
          caseToggle.closest('[data-slot="input-group"]'),
      background: getComputedStyle(document.querySelector("main")!).backgroundColor,
    };
  }, GRAPH_IDS);
  assert.ok(
    layout.documentWidth <= layout.viewport && layout.bodyWidth <= layout.viewport,
    JSON.stringify(layout),
  );
  assert.ok(
    layout.dialog.left >= -1 && layout.dialog.right <= layout.viewport + 1,
    JSON.stringify(layout),
  );
  const centres = layout.controls.map((box) => box.y + box.height / 2);
  assert.ok(Math.max(...centres) - Math.min(...centres) <= 2, "文本/开关/三下拉始终同一行");
  const [text, regex, caseToggle, branch, author, date] = layout.controls;
  assert.ok(
    text.right <= regex.left + 1 && regex.right <= caseToggle.left + 1,
    "两开关在文本框右侧",
  );
  assert.ok(
    caseToggle.right <= branch.left + 1 &&
      branch.right <= author.left + 1 &&
      author.right <= date.left + 1,
    "四组顺序固定",
  );
  assert.equal(layout.sameTextGroup, true);
  assert.equal(layout.wraps, "nowrap");
  assert.notEqual(layout.background, "rgba(0, 0, 0, 0)", "加载真实产品主题样式");
  assert.equal(
    await graphDialog(page)
      .getByRole("button", { name: /reset|重置|清除筛选/iu })
      .count(),
    0,
  );
  assert.equal(
    await graphDialog(page).locator('input[type="date"], input[type="datetime-local"]').count(),
    0,
  );
  if (mobile) {
    assert.ok(layout.scroll.width > layout.scroll.client, "320/390px 仅筛选条内部横滚");
    assert.ok(["auto", "scroll"].includes(layout.scroll.overflow));
    await page.getByTestId(GRAPH_IDS.scroll).evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    assert.ok(
      await page.getByTestId(GRAPH_IDS.scroll).evaluate((element) => element.scrollLeft > 0),
    );
    const dateBox = await locatorBox(graphControl(page, "date"));
    assert.ok(
      dateBox.x >= 0 && dateBox.x + dateBox.width <= layout.viewport + 1,
      "横滚后日期控件可见",
    );
    await page.getByTestId(GRAPH_IDS.scroll).evaluate((element) => {
      element.scrollLeft = 0;
    });
  }
  return layout.background;
}

export async function exerciseGraphLayout(page: Page, mobile: boolean, chinese: boolean) {
  await openGraph(page);
  await waitGraphComplete(page);
  await assertGraphSubject(page, "Literal a.b [keep]");
  assert.equal(
    await graphText(page).getAttribute("placeholder"),
    chinese ? "文本或哈希" : "Text or hash",
  );
  for (const key of ["regex", "caseSensitive"] as const) {
    assert.equal(await graphControl(page, key).getAttribute("aria-pressed"), "false");
    assert.ok(await graphControl(page, key).getAttribute("aria-label"));
  }
  const background = await assertGraphFilterLayout(page, mobile);
  await chooseGraphOption(page, "date", chinese ? "过去 24 小时" : "Past 24 hours");
  await waitGraphComplete(page);
  await assertGraphFilterLayout(page, mobile);
  await closeGraph(page);
  assert.equal(
    await page
      .getByTestId(TID_GIT_TOOLS_ENTRY)
      .evaluate((element) => document.activeElement === element),
    true,
  );
  return background;
}
