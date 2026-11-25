import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import {
  GRAPH_DAY,
  GRAPH_HISTORY,
  GRAPH_IDENTITIES,
  GRAPH_NOW,
  GRAPH_OPTIONS,
  GRAPH_PATH,
} from "./gitGraphFiltersData.js";
import {
  GRAPH_IDS,
  assertGraphSubject,
  assertNoGraphSubject,
  chooseGraphOption,
  graphControl,
  graphDialog,
  graphRequests,
  graphText,
  lastGraphRequest,
  loadMoreGraph,
  openGraph,
  submitGraphText,
  waitGraphComplete,
  waitGraphRequest,
} from "./gitGraphFiltersBrowser.js";

export async function exerciseGraphSearch(page: Page) {
  await openGraph(page);
  await waitGraphComplete(page);
  const initial = await lastGraphRequest(page);
  assert.equal(initial.request.maxCount, 50);
  assert.equal(initial.request.skip, 0);
  assert.equal(initial.request.workspacePath, GRAPH_PATH);
  assert.equal(initial.request.workspaceIdentity, GRAPH_IDENTITIES[0]);
  const count = (await graphRequests(page)).length;
  await graphText(page).fill("a");
  await page.clock.runFor(100);
  await graphText(page).fill("a.b");
  await page.clock.runFor(199);
  assert.equal((await graphRequests(page)).length, count, "连续输入在 200ms 内不请求 backend");
  await page.clock.runFor(1);
  const literal = await waitGraphRequest(page, count + 1);
  await waitGraphComplete(page, literal.id);
  assert.deepEqual(literal.request.filters?.search, {
    value: "a.b",
    mode: "literal",
    caseSensitive: false,
  });
  await assertGraphSubject(page, "Literal a.b [keep]");
  await assertNoGraphSubject(page, "literal axb [KEEP]");
  const enterAt = await page.evaluate(() => Date.now());
  const hash = await submitGraphText(page, "abcdef1");
  assert.equal(hash.at, enterAt, "Enter 立即应用，不推进 debounce clock");
  assert.equal(hash.request.filters?.search?.value, "abcdef1");
  await assertGraphSubject(page, "History commit 2");
  await submitGraphText(page, "body-only-token");
  await assertGraphSubject(page, "History commit 3");
  await submitGraphText(page, "[keep]");
  await assertGraphSubject(page, "Literal a.b [keep]");
  await assertGraphSubject(page, "literal axb [KEEP]");
  const beforeToggle = (await graphRequests(page)).length;
  await graphControl(page, "caseSensitive").click();
  const sensitive = await waitGraphRequest(page, beforeToggle + 1);
  await waitGraphComplete(page, sensitive.id);
  assert.equal(sensitive.request.filters?.search?.caseSensitive, true);
  assert.equal(await graphControl(page, "caseSensitive").getAttribute("aria-pressed"), "true");
  await assertGraphSubject(page, "Literal a.b [keep]");
  await assertNoGraphSubject(page, "literal axb [KEEP]");
  await submitGraphText(page, "a.b");
  await graphControl(page, "regex").click();
  await waitGraphComplete(page);
  assert.deepEqual((await lastGraphRequest(page)).request.filters?.search, {
    value: "a.b",
    mode: "regex",
    caseSensitive: true,
  });
  assert.equal(await graphControl(page, "regex").getAttribute("aria-pressed"), "true");
  await assertGraphSubject(page, "literal axb [KEEP]");
  await graphControl(page, "caseSensitive").click();
  await waitGraphComplete(page);
  assert.equal((await lastGraphRequest(page)).request.filters?.search?.caseSensitive, false);
  const beforeInvalid = (await graphRequests(page)).length;
  await graphText(page).fill("[");
  await graphText(page).press("Enter");
  await page.clock.runFor(250);
  assert.equal(
    (await graphRequests(page)).length,
    beforeInvalid,
    "无效正则不请求 backend、不降级字面模式",
  );
  assert.equal(await graphText(page).getAttribute("aria-invalid"), "true");
  const errorId = await graphText(page).getAttribute("aria-describedby");
  assert.ok(errorId);
  await page.locator(`[id="${errorId}"]`).waitFor({ state: "visible" });
  assert.match(await graphDialog(page).getByRole("alert").innerText(), /regular expression|正则/iu);
  await page.getByTestId(GRAPH_IDS.bar).waitFor({ state: "visible" });
  for (const key of ["branch", "author", "date"] as const)
    assert.equal(await graphControl(page, key).isEnabled(), true);
  await graphControl(page, "regex").click();
  await waitGraphComplete(page);
  assert.equal((await lastGraphRequest(page)).request.filters?.search?.mode, "literal");
  assert.equal(await graphText(page).getAttribute("aria-invalid"), "false");
  await submitGraphText(page, "no-synthetic-match-987");
  await graphDialog(page)
    .getByText(/^(?:No matching commits|没有匹配的提交|未找到匹配提交)$/u)
    .waitFor({ state: "visible" });
  await page.getByTestId(GRAPH_IDS.bar).waitFor({ state: "visible" });
  await submitGraphText(page, "");
  assert.equal(
    (await lastGraphRequest(page)).request.filters?.search,
    undefined,
    "清空文本只取消文本条件",
  );
  await assertGraphSubject(page, "Literal a.b [keep]");
  const records = await graphRequests(page);
  assert.ok(
    records.every(
      ({ request }) =>
        request.workspaceIdentity === GRAPH_IDENTITIES[0] && request.workspacePath === GRAPH_PATH,
    ),
  );
}

export async function exerciseGraphCombinedFilters(page: Page) {
  await openGraph(page);
  await waitGraphComplete(page);
  await page.clock.setFixedTime(new Date(GRAPH_NOW));
  let count = (await graphRequests(page)).length;
  await chooseGraphOption(page, "branch", "feature/one");
  let record = await waitGraphRequest(page, ++count);
  assert.equal(record.request.filters?.branchRef, "refs/heads/feature/one");
  await waitGraphComplete(page, record.id);
  await assertGraphSubject(page, "Deep Needle commit 60");
  await chooseGraphOption(page, "branch", "origin/main");
  record = await waitGraphRequest(page, ++count);
  assert.equal(record.request.filters?.branchRef, "refs/remotes/origin/main");
  await chooseGraphOption(page, "branch", "feature/one");
  await waitGraphRequest(page, ++count);
  await chooseGraphOption(page, "author", /Alex.*alex\.two@example\.test/u);
  record = await waitGraphRequest(page, ++count);
  assert.deepEqual(record.request.filters?.author, GRAPH_OPTIONS.authors[1]);
  const needle = await submitGraphText(page, "Needle");
  count += 1;
  assert.equal(needle.request.filters?.branchRef, "refs/heads/feature/one");
  assert.deepEqual(needle.request.filters?.author, GRAPH_OPTIONS.authors[1]);
  const beforeDate = await page.evaluate(() => Date.now());
  await chooseGraphOption(page, "date", "Past 30 days");
  record = await waitGraphRequest(page, ++count);
  await waitGraphComplete(page, record.id);
  assert.equal(record.at, beforeDate, "下拉改变立即应用");
  assert.deepEqual(record.request.filters, {
    search: { value: "Needle", mode: "literal", caseSensitive: false },
    branchRef: "refs/heads/feature/one",
    author: GRAPH_OPTIONS.authors[1],
    date: { fromMs: GRAPH_NOW - 30 * GRAPH_DAY, toMs: GRAPH_NOW },
  });
  await assertGraphSubject(page, "Deep Needle commit 61");
  await assertNoGraphSubject(page, "Deep Needle commit 60");
  await assertNoGraphSubject(page, "Deep Needle commit 79");
  await graphControl(page, "author").click();
  const authors = await page.getByRole("option").allTextContents();
  assert.ok(
    authors.some((text) => text.includes("alex.one@example.test")) &&
      authors.some((text) => text.includes("alex.two@example.test")),
    "同名作者按邮箱区别，候选不是首批提交推导",
  );
  await page.getByRole("option", { name: "All", exact: true }).click();
  await waitGraphComplete(page);
  assert.equal((await lastGraphRequest(page)).request.filters?.author, undefined);
  assert.equal((await lastGraphRequest(page)).request.filters?.branchRef, "refs/heads/feature/one");
}

export async function exerciseGraphDates(page: Page) {
  await openGraph(page);
  await waitGraphComplete(page);
  await page.clock.setFixedTime(new Date(GRAPH_NOW));
  await graphControl(page, "date").click();
  assert.deepEqual(await page.getByRole("option").allTextContents(), [
    "All time",
    "Past 24 hours",
    "Past 7 days",
    "Past 30 days",
  ]);
  await page.keyboard.press("Escape");
  for (const [days, label, included, excluded] of [
    [1, "Past 24 hours", 1, 2],
    [7, "Past 7 days", 3, 4],
    [30, "Past 30 days", 5, 6],
  ] as const) {
    await chooseGraphOption(page, "date", label);
    await waitGraphComplete(page);
    const first = await lastGraphRequest(page);
    const frozen = { fromMs: GRAPH_NOW - days * GRAPH_DAY, toMs: GRAPH_NOW };
    assert.deepEqual(first.request.filters?.date, frozen);
    await assertGraphSubject(page, GRAPH_HISTORY[included]!.subject);
    await assertNoGraphSubject(page, GRAPH_HISTORY[excluded]!.subject);
    await assertNoGraphSubject(page, GRAPH_HISTORY[0]!.subject);
    if (days === 30) {
      await page.clock.setFixedTime(new Date(GRAPH_NOW + GRAPH_DAY));
      const more = await loadMoreGraph(page);
      await waitGraphComplete(page, more.id);
      assert.deepEqual(more.request.filters?.date, frozen, "同次分页固定作者日期的 [from,to) 边界");
      assert.ok(more.request.cursor);
      const count = (await graphRequests(page)).length;
      await page.getByTestId(GRAPH_IDS.refresh).click();
      const refresh = await waitGraphRequest(page, count + 1);
      assert.equal(refresh.request.skip, 0);
      assert.equal(refresh.request.cursor, undefined);
      assert.deepEqual(
        refresh.request.filters?.date,
        { fromMs: GRAPH_NOW - 29 * GRAPH_DAY, toMs: GRAPH_NOW + GRAPH_DAY },
        "刷新重新冻结当前时刻",
      );
    }
  }
  await chooseGraphOption(page, "date", "All time");
  await waitGraphComplete(page);
  assert.equal((await lastGraphRequest(page)).request.filters?.date, undefined);
}

export async function exerciseGraphPagination(page: Page, legacy = false) {
  await openGraph(page);
  await waitGraphComplete(page);
  const first = await submitGraphText(page, "Needle");
  await assertGraphSubject(page, "Deep Needle commit 60");
  assert.equal(first.request.skip, 0);
  for (const [index, subject] of ["Deep Needle commit 110", "Deep Needle commit 160"].entries()) {
    const more = await loadMoreGraph(page);
    await waitGraphComplete(page, more.id);
    assert.equal(more.request.maxCount, 50);
    assert.deepEqual(more.request.filters, first.request.filters);
    if (legacy) {
      assert.equal(more.request.cursor, undefined);
      assert.equal(more.request.skip, (index + 1) * 50, "旧端不返回 cursor 时按已加载数量兼容分页");
    } else {
      assert.ok(
        more.request.cursor?.startsWith("fixture-cursor-"),
        "从 service 返回的不透明 cursor 继续历史",
      );
      assert.ok(
        more.request.skip === undefined || more.request.skip === 0,
        "有 cursor 不按已加载行数重算扫描位置",
      );
    }
    await assertGraphSubject(page, subject);
  }
  await assertGraphSubject(page, "Deep Needle commit 60");
  await assertNoGraphSubject(page, "History commit 10");
  const pages = (await graphRequests(page)).filter(
    ({ request }) => request.filters?.search?.value === "Needle",
  );
  const boundaries = pages.map(({ request }) => request.cursor ?? `skip:${request.skip ?? 0}`);
  assert.equal(
    new Set(boundaries).size,
    boundaries.length,
    "同查询页边界只能接受一次，不能重复 append",
  );
}

export async function exerciseGraphPaginationBurst(page: Page, legacy: boolean) {
  await openGraph(page);
  await waitGraphComplete(page);
  await submitGraphText(page, "Needle");
  const count = (await graphRequests(page)).length;
  // 同一 DOM 的连续 scroll 可能跨过已完成 Promise、但 React 尚未 commit；不替换 hook，只投递真实 DOM 事件。
  await graphDialog(page)
    .locator("section > div.overflow-auto")
    .evaluate(async (element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
  await waitGraphRequest(page, count + 1);
  await waitGraphComplete(page);
  await page.clock.runFor(32);
  await assertGraphSubject(page, "Deep Needle commit 110");
  const pages = (await graphRequests(page)).filter(
    ({ request }) => request.filters?.search?.value === "Needle",
  );
  const boundaries = pages.map(({ request }) => request.cursor ?? `skip:${request.skip ?? 0}`);
  assert.equal(
    new Set(boundaries).size,
    boundaries.length,
    `${legacy ? "skip" : "cursor"} 在 React commit 前也不能重复 admission`,
  );
  const subjects = await graphDialog(page).locator("section button").allTextContents();
  const commits = subjects.filter((subject) => subject.startsWith("Deep Needle commit"));
  assert.equal(new Set(commits).size, commits.length, "图谱不能重复 append 相同提交");
}
