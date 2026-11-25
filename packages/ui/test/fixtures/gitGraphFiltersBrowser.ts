import assert from "node:assert/strict";
import type { Locator, Page } from "playwright-core";
import { TID_GIT_TOOLS_ENTRY, TID_GIT_TOOLS_PANEL, type GitCommitGraphResult } from "@zcode/shared";
import type { GraphRequestRecord } from "./gitGraphFiltersService.js";

export const GRAPH_IDS = {
  entry: "git-graph-entry",
  dialog: "git-graph-dialog",
  scroll: "git-graph-filters-scroll",
  bar: "git-graph-filters",
  text: "git-graph-filter-text",
  regex: "git-graph-filter-regex",
  caseSensitive: "git-graph-filter-caseSensitive",
  branch: "git-graph-filter-branch",
  author: "git-graph-filter-author",
  date: "git-graph-filter-date",
  refresh: "git-graph-refresh",
} as const;
export const graphDialog = (page: Page) => page.getByTestId(GRAPH_IDS.dialog);
export const graphText = (page: Page) => page.getByTestId(GRAPH_IDS.text);
export const graphControl = (
  page: Page,
  key: "regex" | "caseSensitive" | "branch" | "author" | "date",
) => page.getByTestId(GRAPH_IDS[key]);
export const graphRequests = (page: Page) =>
  page.evaluate(() => window.__gitGraphFiltersTest.requests);
export const lastGraphRequest = async (page: Page) => {
  const records = await graphRequests(page);
  assert.ok(records.length > 0, "真实 hook 应通过 gitService 发起请求");
  return records.at(-1)!;
};
export async function waitGraphRequest(page: Page, count: number): Promise<GraphRequestRecord> {
  await page.waitForFunction(
    (count) => window.__gitGraphFiltersTest.requests.length >= count,
    count,
    { polling: 25 },
  );
  return lastGraphRequest(page);
}
export async function waitGraphComplete(page: Page, id?: number) {
  await page.waitForFunction(
    (id) => {
      const record =
        id === undefined
          ? window.__gitGraphFiltersTest.requests.at(-1)
          : window.__gitGraphFiltersTest.requests.find((record) => record.id === id);
      return record?.status === "completed";
    },
    id,
    { polling: 25 },
  );
}
export async function openGraph(page: Page) {
  await page.getByTestId(TID_GIT_TOOLS_ENTRY).waitFor({ state: "visible", timeout: 45_000 });
  await page.getByTestId(TID_GIT_TOOLS_ENTRY).click();
  await page.getByTestId(TID_GIT_TOOLS_PANEL).waitFor({ state: "visible" });
  await page.getByTestId(GRAPH_IDS.entry).click();
  await graphDialog(page).waitFor({ state: "visible" });
  await page.clock.runFor(32);
  await page.getByTestId(TID_GIT_TOOLS_PANEL).waitFor({ state: "hidden" });
  await page.getByTestId(GRAPH_IDS.bar).waitFor({ state: "visible" });
}
export async function closeGraph(page: Page) {
  await page.keyboard.press("Escape");
  await page.clock.runFor(32);
  await graphDialog(page).waitFor({ state: "detached" });
  // Radix FocusScope 在卸载后用 setTimeout(0) 执行 closeAutoFocus；只推进该生命周期帧。
  await page.clock.runFor(1);
}
export async function submitGraphText(page: Page, value: string) {
  const count = (await graphRequests(page)).length;
  await graphText(page).fill(value);
  await graphText(page).press("Enter");
  const record = await waitGraphRequest(page, count + 1);
  await waitGraphComplete(page, record.id);
  return record;
}
export async function chooseGraphOption(
  page: Page,
  key: "branch" | "author" | "date",
  name: string | RegExp,
) {
  await graphControl(page, key).click();
  const option = page.getByRole("option", { name, exact: typeof name === "string" });
  await option.waitFor({ state: "visible" });
  await option.click();
}
export function graphRow(page: Page, subject: string) {
  return graphDialog(page)
    .getByRole("button")
    .filter({ has: page.getByText(subject, { exact: true }) });
}
export async function assertGraphSubject(page: Page, subject: string) {
  await graphRow(page, subject).waitFor({ state: "visible" });
}
export async function assertNoGraphSubject(page: Page, subject: string) {
  assert.equal(await graphDialog(page).getByText(subject, { exact: true }).count(), 0);
}
export async function loadMoreGraph(page: Page, previousCount?: number) {
  const count = previousCount ?? (await graphRequests(page)).length;
  // 点击离屏按钮会先自动滚动并触发 Pane.onScroll，再追着下一页按钮点，形成两个交互。
  // 这里只走真实滚动加载路径，保留 hook 的 admission 与 cursor/skip 判定。
  await graphDialog(page)
    .locator("section > div.overflow-auto")
    .evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
  return waitGraphRequest(page, count + 1);
}
export async function holdGraph(page: Page, kind: "graph" | "options" = "graph") {
  await page.evaluate((kind) => window.__gitGraphFiltersTest.holdNext(kind), kind);
}
export async function releaseGraph(page: Page, id: number, result?: GitCommitGraphResult) {
  await page.evaluate(({ id, result }) => window.__gitGraphFiltersTest.release(id, result), {
    id,
    result,
  });
  await waitGraphComplete(page, id);
  // 只推进 React 调度/动画帧；请求是否失效由真实 hook 的代次判定，不靠等待碰运气。
  await page.clock.runFor(32);
}
export async function locatorBox(locator: Locator) {
  const box = await locator.boundingBox();
  assert.ok(box, "真实渲染元素必须有布局尺寸");
  return box;
}
