import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { TID_GIT_TOOLS_ENTRY } from "@zcode/shared";
import { GRAPH_IDENTITIES, GRAPH_PATH, graphCommit } from "./gitGraphFiltersData.js";
import {
  GRAPH_IDS,
  assertGraphSubject,
  assertNoGraphSubject,
  chooseGraphOption,
  closeGraph,
  graphControl,
  graphDialog,
  graphRequests,
  graphRow,
  graphText,
  holdGraph,
  lastGraphRequest,
  loadMoreGraph,
  openGraph,
  releaseGraph,
  submitGraphText,
  waitGraphComplete,
  waitGraphRequest,
} from "./gitGraphFiltersBrowser.js";

const staleResult = (subject: string) => ({ commits: [graphCommit(subject)], hasMore: false });

export async function exerciseGraphInitialRace(page: Page) {
  await holdGraph(page);
  await openGraph(page);
  const initial = await waitGraphRequest(page, 1);
  assert.equal(initial.status, "pending");
  await page.getByTestId(GRAPH_IDS.bar).waitFor({ state: "visible" });
  await graphText(page).fill("Needle");
  await releaseGraph(page, initial.id, staleResult("STALE initial before debounce"));
  assert.equal((await graphRequests(page)).length, 1);
  await assertNoGraphSubject(page, "STALE initial before debounce");
  await page.clock.runFor(168);
  const current = await waitGraphRequest(page, 2);
  await waitGraphComplete(page, current.id);
  await assertGraphSubject(page, "Deep Needle commit 60");
  await assertNoGraphSubject(page, "STALE initial before debounce");
  assert.equal(await graphText(page).inputValue(), "Needle");
  assert.equal(current.request.skip, 0);
}

export async function exerciseGraphMoreRace(page: Page) {
  await openGraph(page);
  await waitGraphComplete(page);
  await graphRow(page, "Literal a.b [keep]").click();
  await graphDialog(page).getByText("Subject", { exact: true }).waitFor({ state: "visible" });
  await holdGraph(page);
  const more = await loadMoreGraph(page);
  assert.equal(more.status, "pending");
  await graphText(page).fill("Needle");
  await releaseGraph(page, more.id, staleResult("STALE more before debounce"));
  await assertNoGraphSubject(page, "STALE more before debounce");
  await graphText(page).press("Enter");
  const current = await waitGraphRequest(page, 3);
  await waitGraphComplete(page, current.id);
  await assertGraphSubject(page, "Deep Needle commit 60");
  await assertNoGraphSubject(page, "Literal a.b [keep]");
  assert.equal(
    await graphDialog(page).getByText("Subject", { exact: true }).count(),
    0,
    "条件变化关闭旧展开详情",
  );
  await holdGraph(page);
  const oldMore = await loadMoreGraph(page);
  const filtered = await submitGraphText(page, "abcdef1");
  assert.equal(filtered.request.cursor, undefined);
  assert.equal(filtered.request.skip, 0);
  await assertGraphSubject(page, "History commit 2");
  await releaseGraph(page, oldMore.id, staleResult("STALE more after new results"));
  await assertGraphSubject(page, "History commit 2");
  await assertNoGraphSubject(page, "STALE more after new results");
}

export async function exerciseGraphReopenRace(page: Page, more: boolean) {
  await holdGraph(page);
  await openGraph(page);
  let old = await waitGraphRequest(page, 1);
  if (more) {
    await releaseGraph(page, old.id);
    await holdGraph(page);
    old = await loadMoreGraph(page);
  }
  const count = (await graphRequests(page)).length;
  await closeGraph(page);
  await openGraph(page);
  const current = await waitGraphRequest(page, count + 1);
  await waitGraphComplete(page, current.id);
  await assertGraphSubject(page, "Literal a.b [keep]");
  await releaseGraph(page, old.id, staleResult(`STALE ${more ? "more" : "initial"} after reopen`));
  await assertGraphSubject(page, "Literal a.b [keep]");
  await assertNoGraphSubject(page, `STALE ${more ? "more" : "initial"} after reopen`);
  assert.equal(await graphText(page).inputValue(), "");
  assert.equal(current.request.skip, 0);
  assert.equal(current.request.cursor, undefined);
}

export async function exerciseGraphScopeRace(page: Page, replaceService: boolean) {
  await openGraph(page);
  await waitGraphComplete(page);
  await submitGraphText(page, "Needle");
  await chooseGraphOption(page, "branch", "feature/one");
  await waitGraphComplete(page);
  await holdGraph(page);
  const old = await loadMoreGraph(page);
  const count = (await graphRequests(page)).length;
  const identity = replaceService ? GRAPH_IDENTITIES[0] : GRAPH_IDENTITIES[1];
  // 不给组件换 key，也不由夹具关闭弹窗；真实入口必须察觉相同 cwd 下身份/服务 owner 的变化。
  await page.evaluate(
    ({ identity, replaceService }) =>
      window.__gitGraphFiltersTest.setScope(identity, replaceService),
    { identity, replaceService },
  );
  await page.clock.runFor(32);
  await graphDialog(page).waitFor({ state: "hidden" });
  assert.equal(
    (await graphRequests(page)).length,
    count,
    "切 scope 清除图谱打开意图，不能自动打开新 scope",
  );
  await openGraph(page);
  const current = await waitGraphRequest(page, count + 1);
  await waitGraphComplete(page, current.id);
  assert.equal(current.request.workspacePath, GRAPH_PATH);
  assert.equal(current.request.workspaceIdentity, identity);
  assert.equal(current.request.filters?.search, undefined);
  assert.equal(current.request.filters?.branchRef, undefined);
  assert.equal(current.request.cursor, undefined);
  assert.equal(await graphText(page).inputValue(), "");
  await assertGraphSubject(page, "Literal a.b [keep]");
  await releaseGraph(page, old.id, staleResult("STALE cross owner"));
  await assertGraphSubject(page, "Literal a.b [keep]");
  await assertNoGraphSubject(page, "STALE cross owner");
  const options = await page.evaluate(() => window.__gitGraphFiltersTest.optionRequests.at(-1));
  assert.equal(options?.request.workspaceIdentity, identity);
  assert.equal(options?.request.workspacePath, GRAPH_PATH);
  await closeGraph(page);
  assert.equal(
    await page
      .getByTestId(TID_GIT_TOOLS_ENTRY)
      .evaluate((element) => document.activeElement === element),
    true,
  );
}

export async function exerciseGraphLateOptions(page: Page) {
  await holdGraph(page, "options");
  await openGraph(page);
  await waitGraphComplete(page);
  const options = await page.evaluate(() => window.__gitGraphFiltersTest.optionRequests.at(-1)!);
  assert.equal(options.status, "pending");
  await submitGraphText(page, "Needle");
  await page.evaluate((id) => window.__gitGraphFiltersTest.releaseOptions(id), options.id);
  await graphControl(page, "branch").click();
  await page
    .getByRole("option", { name: "feature/one", exact: true })
    .waitFor({ state: "visible" });
  await page.getByRole("option", { name: "feature/one", exact: true }).click();
  await waitGraphComplete(page);
  assert.equal(
    (await lastGraphRequest(page)).request.filters?.branchRef,
    "refs/heads/feature/one",
    "候选独立于结果代次，迟到不因文本变化被丢",
  );
  await chooseGraphOption(page, "author", /Alex.*alex\.two@example\.test/u);
  await waitGraphComplete(page);
  await assertGraphSubject(page, "Deep Needle commit 61");
}

export async function exerciseGraphMissingOptions(page: Page) {
  await openGraph(page);
  await waitGraphComplete(page);
  await chooseGraphOption(page, "branch", "feature/one");
  await waitGraphComplete(page);
  await chooseGraphOption(page, "author", /Alex.*alex\.two@example\.test/u);
  await waitGraphComplete(page);
  await submitGraphText(page, "Needle");
  const before = await lastGraphRequest(page);
  await page.evaluate(() => window.__gitGraphFiltersTest.setOptions({ branches: [], authors: [] }));
  const count = (await graphRequests(page)).length;
  await page.getByTestId(GRAPH_IDS.refresh).click();
  const refresh = await waitGraphRequest(page, count + 1);
  await waitGraphComplete(page, refresh.id);
  await page.waitForFunction(
    () => window.__gitGraphFiltersTest.optionRequests.at(-1)?.status === "completed",
    undefined,
    { polling: 25 },
  );
  assert.deepEqual(
    refresh.request.filters,
    before.request.filters,
    "刷新候选不改变已接受的筛选意图",
  );
  assert.match(
    await graphControl(page, "branch").innerText(),
    /feature\/one/u,
    "候选消失仍显示已选ref，不伪装All",
  );
  assert.match(await graphControl(page, "author").innerText(), /Alex/u, "候选消失仍显示已选作者");
  assert.doesNotMatch(await graphControl(page, "branch").innerText(), /All/u);
  assert.doesNotMatch(await graphControl(page, "author").innerText(), /All/u);
  const next = await submitGraphText(page, "Deep Needle");
  assert.equal(next.request.filters?.branchRef, "refs/heads/feature/one");
  assert.deepEqual(next.request.filters?.author, { name: "Alex", email: "alex.two@example.test" });
  await assertGraphSubject(page, "Deep Needle commit 61");
}

export async function exerciseGraphError(page: Page) {
  await holdGraph(page);
  await openGraph(page);
  const old = await waitGraphRequest(page, 1);
  await page.evaluate(
    (id) => window.__gitGraphFiltersTest.reject(id, "Synthetic graph failure"),
    old.id,
  );
  await graphDialog(page)
    .getByRole("alert")
    .getByText(/Synthetic graph failure/u)
    .waitFor({ state: "visible" });
  await page.getByTestId(GRAPH_IDS.bar).waitFor({ state: "visible" });
  assert.equal(await graphText(page).isEnabled(), true);
  assert.equal(
    await graphDialog(page).getByText("No commits", { exact: true }).count(),
    0,
    "查询失败不能伪装为空仓库",
  );
  assert.equal(
    await graphDialog(page)
      .getByText("This repository does not have commit history yet.", { exact: true })
      .count(),
    0,
  );
  await submitGraphText(page, "abcdef1");
  await assertGraphSubject(page, "History commit 2");
  assert.equal(await graphDialog(page).getByRole("alert").count(), 0);
}
