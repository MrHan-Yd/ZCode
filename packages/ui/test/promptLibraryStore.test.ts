import assert from "node:assert/strict";
import test from "node:test";
import type {
  IPromptLibraryService,
  PromptLibraryListResult,
  PromptLibraryMutationResult,
} from "@zcode/services";
import type { PromptTemplate, PromptTemplateSummary } from "@zcode/shared";
import { toPromptTemplateSummary } from "@zcode/shared";
import { PROMPT_LIBRARY_STALE_MS, usePromptLibraryStore } from "../src/store/promptLibraryStore.js";

// 这些测试只关心状态机，不需要把 logger 输出打到测试报告里。
(
  globalThis as typeof globalThis & { __ZCODE_RENDERER_DISABLE_LOGGING__?: boolean }
).__ZCODE_RENDERER_DISABLE_LOGGING__ = true;

function makeTemplate(id: string, overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id,
    title: `Title ${id}`,
    content: `Content ${id}`,
    tags: [],
    pinned: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function makeSummary(id: string, overrides: Partial<PromptTemplate> = {}): PromptTemplateSummary {
  return toPromptTemplateSummary(makeTemplate(id, overrides));
}

function makeService(overrides: Partial<IPromptLibraryService> = {}): IPromptLibraryService {
  return {
    async list() {
      return { items: [], warning: null, readOnly: false };
    },
    async get() {
      return { ok: false, reason: "not-found" };
    },
    async create() {
      return { ok: false, reason: "io-error" };
    },
    async update() {
      return { ok: false, reason: "io-error" };
    },
    async remove() {
      return { ok: true };
    },
    async setPinned() {
      return { ok: false, reason: "io-error" };
    },
    async recordUsage() {},
    async reset() {
      return { ok: true };
    },
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function store() {
  return usePromptLibraryStore.getState();
}

function itemIds(): string[] {
  return store().items.map((item) => item.id);
}

test.beforeEach(() => {
  store().reset();
});

test("load：30 秒内重复调用只打一次 Host", async () => {
  let listCalls = 0;
  const service = makeService({
    async list() {
      listCalls += 1;
      return { items: [makeSummary("a")], warning: null, readOnly: false };
    },
  });

  assert.equal(await store().load(service), true);
  assert.equal(await store().load(service), true);
  assert.equal(listCalls, 1);
  assert.deepEqual(itemIds(), ["a"]);
  assert.equal(store().loaded, true);
  assert.equal(store().loading, false);
});

test("load：force 刷新绕过缓存，过期后自动刷新", async () => {
  let listCalls = 0;
  const service = makeService({
    async list() {
      listCalls += 1;
      return { items: [makeSummary("a")], warning: null, readOnly: false };
    },
  });

  await store().load(service);
  await store().load(service, { force: true });
  assert.equal(listCalls, 2);

  usePromptLibraryStore.setState({ loadedAt: Date.now() - PROMPT_LIBRARY_STALE_MS - 1 });
  await store().load(service);
  assert.equal(listCalls, 3);
});

test("load：旧请求结果不回写", async () => {
  const first = deferred<PromptLibraryListResult>();
  const second = deferred<PromptLibraryListResult>();
  let listCalls = 0;
  const service = makeService({
    list() {
      listCalls += 1;
      return listCalls === 1 ? first.promise : second.promise;
    },
  });

  const firstLoad = store().load(service, { force: true });
  const secondLoad = store().load(service, { force: true });

  // 后发请求先完成，应成为最终快照。
  second.resolve({ items: [makeSummary("new")], warning: null, readOnly: false });
  assert.equal(await secondLoad, true);
  assert.deepEqual(itemIds(), ["new"]);

  // 先发请求后完成，必须被 requestSeq 丢弃。
  first.resolve({ items: [makeSummary("stale")], warning: null, readOnly: false });
  assert.equal(await firstLoad, false);
  assert.deepEqual(itemIds(), ["new"]);
});

test("create / update / setPinned 合并同 id 并按 pinned 优先排序", async () => {
  const initial = [
    makeSummary("a", { title: "Alpha", updatedAt: 1 }),
    makeSummary("b", { title: "Beta", updatedAt: 2 }),
  ];
  const service = makeService({
    async list() {
      return { items: initial, warning: null, readOnly: false };
    },
    async create() {
      return { ok: true, item: makeTemplate("c", { title: "Created", content: "line1\nline2" }) };
    },
    async update() {
      return { ok: true, item: makeTemplate("a", { title: "Alpha updated", content: "new body" }) };
    },
    async setPinned() {
      return {
        ok: true,
        item: makeTemplate("b", { title: "Beta", pinned: true }),
      };
    },
  });

  await store().load(service);
  assert.deepEqual(itemIds(), ["a", "b"]);

  const created = await store().createPrompt(service, {
    title: "Created",
    content: "line1\nline2",
  });
  assert.equal(created.ok, true);
  assert.deepEqual(itemIds(), ["a", "b", "c"]);
  assert.equal(store().items.find((item) => item.id === "c")?.contentPreview, "line1 line2");

  const updated = await store().updatePrompt(service, {
    id: "a",
    title: "Alpha updated",
    content: "new body",
  });
  assert.equal(updated.ok, true);
  // 同 id 只保留一条，不能追加重复记录。
  assert.equal(store().items.filter((item) => item.id === "a").length, 1);
  const updatedItem = store().items.find((item) => item.id === "a");
  assert.equal(updatedItem?.title, "Alpha updated");
  assert.equal(updatedItem?.contentPreview, "new body");

  const pinned = await store().setPinned(service, "b", true);
  assert.equal(pinned.ok, true);
  assert.equal(store().items[0]?.id, "b");
  assert.equal(store().items[0]?.pinned, true);
});

test("remove 后本地剔除；未知 id 也视为成功（幂等）", async () => {
  const service = makeService({
    async list() {
      return {
        items: [makeSummary("a"), makeSummary("b")],
        warning: null,
        readOnly: false,
      };
    },
    async remove() {
      return { ok: true };
    },
  });

  await store().load(service);
  assert.equal((await store().removePrompt(service, "a")).ok, true);
  assert.deepEqual(itemIds(), ["b"]);

  // 删除未知 id 不应报错，也不应改变现有列表。
  assert.equal((await store().removePrompt(service, "missing")).ok, true);
  assert.deepEqual(itemIds(), ["b"]);
});

test("变更失败时保持原列表不变", async () => {
  const service = makeService({
    async list() {
      return { items: [makeSummary("a")], warning: null, readOnly: false };
    },
    async create(): Promise<PromptLibraryMutationResult> {
      return { ok: false, reason: "invalid-title" };
    },
    async update(): Promise<PromptLibraryMutationResult> {
      return { ok: false, reason: "conflict" };
    },
    async setPinned(): Promise<PromptLibraryMutationResult> {
      return { ok: false, reason: "not-found" };
    },
    async remove() {
      return { ok: false, reason: "io-error" as const };
    },
  });

  await store().load(service);
  const before = itemIds();

  await store().createPrompt(service, { title: "", content: "" });
  await store().updatePrompt(service, { id: "a", title: "x", content: "y" });
  await store().setPinned(service, "a", true);
  await store().removePrompt(service, "a");

  assert.deepEqual(itemIds(), before);
});

test("recordUsage：服务失败只记 warn，本地乐观更新保留", async () => {
  const service = makeService({
    async list() {
      return {
        items: [makeSummary("a"), makeSummary("b", { lastUsedAt: 500 })],
        warning: null,
        readOnly: false,
      };
    },
    async recordUsage() {
      throw new Error("disk full");
    },
  });

  await store().load(service);
  assert.deepEqual(itemIds(), ["b", "a"]);

  // 不应 reject：recordUsage 是 best-effort。
  await store().recordUsage(service, "a");

  const used = store().items.find((item) => item.id === "a");
  assert.equal(typeof used?.lastUsedAt, "number");
  // recentUsed 排序把刚使用的条目放到最前。
  assert.deepEqual(itemIds(), ["a", "b"]);
  assert.equal(store().error, null);
});

test("readOnly / warning 透传", async () => {
  const warning = {
    code: "corrupt-recovered" as const,
    message: "recovered from corrupted file",
    quarantinePath: "/tmp/prompt-library.json.corrupt.bak",
  };
  const service = makeService({
    async list() {
      return {
        items: [makeSummary("a")],
        warning,
        readOnly: true,
      };
    },
  });

  assert.equal(await store().load(service), true);
  assert.equal(store().readOnly, true);
  assert.deepEqual(store().warning, warning);
});

test("load 失败透传 error，clearError 可清除", async () => {
  const service = makeService({
    async list() {
      throw new Error("boom");
    },
  });

  assert.equal(await store().load(service), false);
  assert.equal(store().error, "boom");
  assert.equal(store().loading, false);
  assert.equal(store().loaded, false);

  store().clearError();
  assert.equal(store().error, null);
});

test("reset 清空投影并让在途请求失效", async () => {
  const pending = deferred<PromptLibraryListResult>();
  const service = makeService({
    list() {
      return pending.promise;
    },
  });

  const loadPromise = store().load(service, { force: true });
  store().reset();

  pending.resolve({ items: [makeSummary("late")], warning: null, readOnly: false });
  assert.equal(await loadPromise, false);
  assert.deepEqual(itemIds(), []);
  assert.equal(store().loaded, false);
  assert.equal(store().loadedAt, null);
});

test("可选同步能力：fake service 未实现时不会被误判为支持", () => {
  const syncMethods = [
    "getSyncStatus",
    "uploadToGithub",
    "previewDownload",
    "applyDownload",
    "listSyncBackups",
    "restoreSyncBackup",
  ] as const;

  // 与 PromptLibrarySection 的 syncSupported 谓词同构的纯能力视图。
  const isSyncSupported = (candidate: IPromptLibraryService): boolean =>
    syncMethods.every(
      (method) => typeof (candidate as unknown as Record<string, unknown>)[method] === "function",
    );

  const legacyService = makeService();
  for (const method of syncMethods) {
    assert.equal(typeof legacyService[method], "undefined", `${method} 不应被凭空实现`);
  }
  assert.equal(isSyncSupported(legacyService), false);

  // 只实现一部分同步方法也必须视为不支持，避免半套能力进入同步菜单。
  const partialService = makeService({
    async getSyncStatus() {
      throw new Error("not used");
    },
  });
  assert.equal(isSyncSupported(partialService), false);

  // 全部实现时才视为支持。
  const fullService = makeService({
    async getSyncStatus() {
      throw new Error("not used");
    },
    async uploadToGithub() {
      throw new Error("not used");
    },
    async previewDownload() {
      throw new Error("not used");
    },
    async applyDownload() {
      throw new Error("not used");
    },
    async listSyncBackups() {
      throw new Error("not used");
    },
    async restoreSyncBackup() {
      throw new Error("not used");
    },
  });
  assert.equal(isSyncSupported(fullService), true);
});
