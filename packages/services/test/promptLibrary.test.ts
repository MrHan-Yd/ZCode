import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  PROMPT_LIBRARY_LIMITS,
  comparePromptTemplates,
  toPromptTemplateSummary,
  type PromptTemplate,
} from "@zcode/shared";
import { createPromptLibraryService } from "../src/prompt-library/promptLibraryService.js";

/**
 * 提示词库服务契约测试（specs/prompt-library.md §4 / §5 / §11.1 / §12）。
 *
 * 全部测试使用 mkdtemp 注入独立文件路径，不触碰真实 ~/.zcode。
 * 时间与 id 都通过工厂注入，保证断言可重复。
 */

const FILE_NAME = "prompt-library.json";

interface Clock {
  now: () => number;
  advance: (ms?: number) => void;
}

interface LibraryFileJson {
  version: number;
  updatedAt: number;
  items: PromptTemplate[];
}

function createClock(start = 1_700_000_000_000): Clock {
  let current = start;
  return {
    now: () => current,
    advance: (ms = 1) => {
      current += ms;
    },
  };
}

function createIdFactory(prefix = "pl_fixed"): () => string {
  let counter = 0;
  return () => `${prefix}_${++counter}`;
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-prompt-library-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createService(
  filePath: string,
  clock: Clock = createClock(),
  idFactory: () => string = createIdFactory(),
) {
  return createPromptLibraryService({ filePath, now: clock.now, idFactory });
}

function createSeedItem(index: number, overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: `pl_seed_${String(index).padStart(4, "0")}`,
    title: `seed-${index}`,
    content: `content-${index}`,
    tags: [],
    pinned: false,
    createdAt: index,
    updatedAt: index,
    ...overrides,
  };
}

function createTemplate(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: "pl_fixture",
    title: "Alpha",
    content: "hello",
    tags: [],
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function writeRawJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeLibrary(filePath: string, items: PromptTemplate[]): Promise<void> {
  await writeRawJson(filePath, { version: 1, updatedAt: 1, items });
}

async function readLibraryFile(filePath: string): Promise<LibraryFileJson> {
  return JSON.parse(await readFile(filePath, "utf-8")) as LibraryFileJson;
}

// ---------------------------------------------------------------------------
// 1. create / list / get 正常路径
// ---------------------------------------------------------------------------

test("create/list/get：摘要含 contentPreview、全文按 id 获取、pinned 优先", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, FILE_NAME);
    const clock = createClock();
    const service = createService(filePath, clock);

    const createdA = await service.create({
      title: " 甲 ",
      content: "第一行\n第二行\r\n第三行",
      tags: [" 工作 ", "review"],
      alias: "alpha",
    });
    assert.equal(createdA.ok, true);
    if (!createdA.ok) return;
    assert.equal(createdA.item.title, "甲");
    // CRLF 归一为 LF，且返回对象带 Host 生成的 id 与时间戳。
    assert.equal(createdA.item.content, "第一行\n第二行\n第三行");
    assert.deepEqual(createdA.item.tags, ["工作", "review"]);
    assert.equal(createdA.item.id, "pl_fixed_1");
    assert.equal(createdA.item.pinned, false);
    assert.equal(createdA.item.createdAt, clock.now());
    assert.equal(createdA.item.updatedAt, clock.now());

    const createdB = await service.create({
      title: "乙",
      content: "x".repeat(250),
    });
    assert.equal(createdB.ok, true);
    if (!createdB.ok) return;

    const list = await service.list();
    assert.equal(list.warning, null);
    assert.equal(list.readOnly, false);
    assert.equal(list.items.length, 2);

    const summaryA = list.items.find((item) => item.id === createdA.item.id);
    assert.ok(summaryA);
    // 摘要不携带全文，只带预览。
    assert.equal(Object.hasOwn(summaryA, "content"), false);
    assert.equal(summaryA.contentPreview, "第一行 第二行 第三行");
    assert.equal(summaryA.alias, "alpha");

    const summaryB = list.items.find((item) => item.id === createdB.item.id);
    assert.ok(summaryB);
    assert.equal(summaryB.contentPreview.length, 200);
    assert.equal(summaryB.contentPreview, "x".repeat(200));

    const fetched = await service.get({ id: createdA.item.id });
    assert.equal(fetched.ok, true);
    if (!fetched.ok) return;
    assert.equal(fetched.item.content, "第一行\n第二行\n第三行");
    assert.equal(fetched.item.id, createdA.item.id);

    const missing = await service.get({ id: "pl_missing" });
    assert.deepEqual(missing, { ok: false, reason: "not-found" });

    clock.advance(1_000);
    const pinned = await service.setPinned({ id: createdB.item.id, pinned: true });
    assert.equal(pinned.ok, true);
    if (!pinned.ok) return;
    assert.equal(pinned.item.pinned, true);

    const sorted = await service.list();
    assert.equal(sorted.items[0]?.id, createdB.item.id);
    assert.equal(sorted.items[1]?.id, createdA.item.id);
  });
});

test("create：客户端提交的 id 一律忽略，由 Host 生成", async () => {
  await withTempDir(async (dir) => {
    const service = createService(join(dir, FILE_NAME));
    const inputWithId = { title: "带客户端 id", content: "x", id: "pl_client_supplied" };

    const created = await service.create(inputWithId);
    assert.equal(created.ok, true);
    if (!created.ok) return;
    assert.notEqual(created.item.id, "pl_client_supplied");
    assert.equal(created.item.id, "pl_fixed_1");
  });
});

// ---------------------------------------------------------------------------
// 2. 校验边界
// ---------------------------------------------------------------------------

test("校验边界：title 空/仅空白/超 60/C0 控制字符", async () => {
  await withTempDir(async (dir) => {
    const service = createService(join(dir, FILE_NAME));

    const empty = await service.create({ title: "", content: "x" });
    assert.deepEqual(
      { ok: empty.ok, reason: empty.ok ? undefined : empty.reason },
      { ok: false, reason: "invalid-title" },
    );

    const blank = await service.create({ title: "   ", content: "x" });
    assert.equal(blank.ok, false);
    if (blank.ok) return;
    assert.equal(blank.reason, "invalid-title");

    const tooLong = await service.create({ title: "a".repeat(61), content: "x" });
    assert.equal(tooLong.ok, false);
    if (tooLong.ok) return;
    assert.equal(tooLong.reason, "invalid-title");

    const control = await service.create({ title: "bad\u0001title", content: "x" });
    assert.equal(control.ok, false);
    if (control.ok) return;
    assert.equal(control.reason, "invalid-title");

    const boundary = await service.create({ title: "a".repeat(60), content: "x" });
    assert.equal(boundary.ok, true);

    const trimmed = await service.create({ title: "  保留  ", content: "x" });
    assert.equal(trimmed.ok, true);
    if (!trimmed.ok) return;
    assert.equal(trimmed.item.title, "保留");
  });
});

test("校验边界：content 空/仅空白/超 8000/C0；CRLF 归一且保留首尾空白", async () => {
  await withTempDir(async (dir) => {
    const service = createService(join(dir, FILE_NAME));

    const empty = await service.create({ title: "t", content: "" });
    assert.equal(empty.ok, false);
    if (empty.ok) return;
    assert.equal(empty.reason, "invalid-content");

    const blank = await service.create({ title: "t", content: " \n\t " });
    assert.equal(blank.ok, false);
    if (blank.ok) return;
    assert.equal(blank.reason, "invalid-content");

    const tooLong = await service.create({ title: "t", content: "a".repeat(8001) });
    assert.equal(tooLong.ok, false);
    if (tooLong.ok) return;
    assert.equal(tooLong.reason, "invalid-content");

    const control = await service.create({ title: "t", content: "a\u0007b" });
    assert.equal(control.ok, false);
    if (control.ok) return;
    assert.equal(control.reason, "invalid-content");

    // 8,000 恰好允许。
    const boundary = await service.create({ title: "t-8000", content: "a".repeat(8000) });
    assert.equal(boundary.ok, true);
    if (!boundary.ok) return;
    assert.equal(boundary.item.content.length, 8000);

    // CRLF、裸 CR 都归一为 LF；制表符与换行本身是允许的。
    const crlf = await service.create({ title: "t-crlf", content: "a\r\nb\rc\n\td" });
    assert.equal(crlf.ok, true);
    if (!crlf.ok) return;
    assert.equal(crlf.item.content, "a\nb\nc\n\td");

    // content 只做换行归一，不 trim。
    const whitespace = await service.create({ title: "t-ws", content: "  x  " });
    assert.equal(whitespace.ok, true);
    if (!whitespace.ok) return;
    assert.equal(whitespace.item.content, "  x  ");
  });
});

test("校验边界：tags 最多 5 项、单项 1..20、去首尾空白", async () => {
  await withTempDir(async (dir) => {
    const service = createService(join(dir, FILE_NAME));

    const tooMany = await service.create({
      title: "t",
      content: "x",
      tags: Array.from({ length: 6 }, (_, index) => `tag-${index}`),
    });
    assert.equal(tooMany.ok, false);
    if (tooMany.ok) return;
    assert.equal(tooMany.reason, "invalid-tags");

    const tagTooLong = await service.create({
      title: "t",
      content: "x",
      tags: ["t".repeat(21)],
    });
    assert.equal(tagTooLong.ok, false);
    if (tagTooLong.ok) return;
    assert.equal(tagTooLong.reason, "invalid-tags");

    const emptyTag = await service.create({ title: "t", content: "x", tags: ["   "] });
    assert.equal(emptyTag.ok, false);
    if (emptyTag.ok) return;
    assert.equal(emptyTag.reason, "invalid-tags");

    const controlTag = await service.create({ title: "t", content: "x", tags: ["a\u0001b"] });
    assert.equal(controlTag.ok, false);
    if (controlTag.ok) return;
    assert.equal(controlTag.reason, "invalid-tags");

    const boundary = await service.create({
      title: "t",
      content: "x",
      tags: ["  spaced  ", ...Array.from({ length: 3 }, () => "t".repeat(20)), "tail"],
    });
    assert.equal(boundary.ok, true);
    if (!boundary.ok) return;
    assert.deepEqual(boundary.item.tags, [
      "spaced",
      "t".repeat(20),
      "t".repeat(20),
      "t".repeat(20),
      "tail",
    ]);
  });
});

test("校验边界：alias 字符集/长度/C0，空串等价清除", async () => {
  await withTempDir(async (dir) => {
    const service = createService(join(dir, FILE_NAME));

    const badCharacter = await service.create({ title: "t", content: "x", alias: "a.b" });
    assert.equal(badCharacter.ok, false);
    if (badCharacter.ok) return;
    assert.equal(badCharacter.reason, "invalid-alias");

    const spaceInside = await service.create({ title: "t", content: "x", alias: "a b" });
    assert.equal(spaceInside.ok, false);
    if (spaceInside.ok) return;
    assert.equal(spaceInside.reason, "invalid-alias");

    const tooLong = await service.create({ title: "t", content: "x", alias: "a".repeat(25) });
    assert.equal(tooLong.ok, false);
    if (tooLong.ok) return;
    assert.equal(tooLong.reason, "invalid-alias");

    const boundary = await service.create({ title: "t", content: "x", alias: "a".repeat(24) });
    assert.equal(boundary.ok, true);

    const emptyAlias = await service.create({ title: "t", content: "x", alias: "   " });
    assert.equal(emptyAlias.ok, true);
    if (!emptyAlias.ok) return;
    assert.equal(Object.hasOwn(emptyAlias.item, "alias"), false);
  });
});

// ---------------------------------------------------------------------------
// 3. alias 唯一性与同名 title
// ---------------------------------------------------------------------------

test("alias 重复被拒绝；大小写变体无法写入；同名 title 允许", async () => {
  await withTempDir(async (dir) => {
    const service = createService(join(dir, FILE_NAME));

    const first = await service.create({ title: "别名一", content: "x", alias: "review" });
    assert.equal(first.ok, true);

    const duplicate = await service.create({ title: "别名二", content: "y", alias: "review" });
    assert.equal(duplicate.ok, false);
    if (duplicate.ok) return;
    assert.equal(duplicate.reason, "alias-conflict");

    // 契约 §4 的 alias 只允许小写 [a-z0-9_-]；大小写变体在格式校验阶段就被拒绝，
    // 因此库里不可能同时存在仅大小写不同的两个 alias（唯一性天然成立）。
    const upperVariant = await service.create({ title: "别名三", content: "z", alias: " REVIEW " });
    assert.equal(upperVariant.ok, false);
    if (upperVariant.ok) return;
    assert.equal(upperVariant.reason, "invalid-alias");

    const mixedVariant = await service.create({ title: "别名四", content: "z", alias: "Review" });
    assert.equal(mixedVariant.ok, false);
    if (mixedVariant.ok) return;
    assert.equal(mixedVariant.reason, "invalid-alias");

    const sameTitleA = await service.create({ title: "重复标题", content: "a" });
    const sameTitleB = await service.create({ title: "重复标题", content: "b" });
    assert.equal(sameTitleA.ok, true);
    assert.equal(sameTitleB.ok, true);

    const list = await service.list();
    assert.equal(list.items.filter((item) => item.title === "重复标题").length, 2);
  });
});

// ---------------------------------------------------------------------------
// 4. update
// ---------------------------------------------------------------------------

test("update：正常更新、expectedUpdatedAt 冲突、别名冲突、未知 id", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, FILE_NAME);
    const clock = createClock();
    const service = createService(filePath, clock);

    const created = await service.create({
      title: "原始标题",
      content: "原始内容",
      tags: ["old"],
      alias: "one",
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const original = created.item;

    const pinned = await service.setPinned({ id: original.id, pinned: true });
    assert.equal(pinned.ok, true);
    if (!pinned.ok) return;
    // setPinned 本身也推进 updatedAt，后续乐观锁应基于最新版本号。
    const beforeUpdate = pinned.item;

    clock.advance(1_000);
    const updated = await service.update({
      id: original.id,
      title: "新标题",
      content: "新内容",
      tags: ["new"],
      alias: "one",
      expectedUpdatedAt: beforeUpdate.updatedAt,
    });
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    assert.equal(updated.item.id, original.id);
    assert.equal(updated.item.createdAt, original.createdAt);
    assert.equal(updated.item.title, "新标题");
    assert.equal(updated.item.content, "新内容");
    assert.deepEqual(updated.item.tags, ["new"]);
    assert.equal(updated.item.alias, "one");
    // update 保留 pinned，且 updatedAt 前进。
    assert.equal(updated.item.pinned, true);
    assert.ok(updated.item.updatedAt > original.updatedAt);

    // 陈旧 expectedUpdatedAt：返回 conflict，并带上当前摘要供 UI 合并。
    const conflict = await service.update({
      id: original.id,
      title: "另一个标题",
      content: "另一个内容",
      expectedUpdatedAt: beforeUpdate.updatedAt,
    });
    assert.equal(conflict.ok, false);
    if (conflict.ok) return;
    assert.equal(conflict.reason, "conflict");
    assert.ok(conflict.current);
    assert.equal(conflict.current.title, "新标题");
    assert.equal(conflict.current.contentPreview, "新内容");
    assert.equal(Object.hasOwn(conflict.current, "content"), false);

    // 另一个记录占用 "two" 时，把当前记录改成 "two" 会冲突。
    const other = await service.create({ title: "另一条", content: "x", alias: "two" });
    assert.equal(other.ok, true);
    const aliasConflict = await service.update({
      id: original.id,
      title: "新标题",
      content: "新内容",
      alias: "two",
    });
    assert.equal(aliasConflict.ok, false);
    if (aliasConflict.ok) return;
    assert.equal(aliasConflict.reason, "alias-conflict");

    // 空 alias 表示清除。
    const cleared = await service.update({
      id: original.id,
      title: "新标题",
      content: "新内容",
      alias: "",
    });
    assert.equal(cleared.ok, true);
    if (!cleared.ok) return;
    assert.equal(Object.hasOwn(cleared.item, "alias"), false);

    const unknown = await service.update({ id: "pl_unknown", title: "t", content: "x" });
    assert.deepEqual(unknown, { ok: false, reason: "not-found" });

    const emptyId = await service.update({ id: "   ", title: "t", content: "x" });
    assert.equal(emptyId.ok, false);
    if (emptyId.ok) return;
    assert.equal(emptyId.reason, "not-found");
  });
});

// ---------------------------------------------------------------------------
// 5. remove
// ---------------------------------------------------------------------------

test("remove：删除成功且未知 id 幂等成功", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, FILE_NAME);
    const service = createService(filePath);

    const first = await service.create({ title: "A", content: "a" });
    const second = await service.create({ title: "B", content: "b" });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;

    assert.deepEqual(await service.remove({ id: first.item.id }), { ok: true });
    assert.deepEqual(await service.get({ id: first.item.id }), {
      ok: false,
      reason: "not-found",
    });

    const list = await service.list();
    assert.deepEqual(
      list.items.map((item) => item.id),
      [second.item.id],
    );

    // 重复删除与未知 id 都视为成功（多窗口幂等）。
    assert.deepEqual(await service.remove({ id: first.item.id }), { ok: true });
    assert.deepEqual(await service.remove({ id: "pl_never" }), { ok: true });

    const disk = await readLibraryFile(filePath);
    assert.equal(disk.items.length, 1);
    assert.equal(disk.items[0]?.id, second.item.id);
  });
});

// ---------------------------------------------------------------------------
// 6. setPinned / recordUsage
// ---------------------------------------------------------------------------

test("setPinned：更新置顶并单调推进 updatedAt；未知 id 返回 not-found", async () => {
  await withTempDir(async (dir) => {
    const service = createService(join(dir, FILE_NAME));
    const created = await service.create({ title: "A", content: "a" });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    // 不推进时钟也应得到严格更大的 updatedAt。
    const pushed = await service.setPinned({ id: created.item.id, pinned: true });
    assert.equal(pushed.ok, true);
    if (!pushed.ok) return;
    assert.equal(pushed.item.pinned, true);
    assert.ok(pushed.item.updatedAt > created.item.updatedAt);

    const unpinned = await service.setPinned({ id: created.item.id, pinned: false });
    assert.equal(unpinned.ok, true);
    if (!unpinned.ok) return;
    assert.equal(unpinned.item.pinned, false);
    assert.ok(unpinned.item.updatedAt > pushed.item.updatedAt);

    const unknown = await service.setPinned({ id: "pl_unknown", pinned: true });
    assert.deepEqual(unknown, { ok: false, reason: "not-found" });

    const invalid = await service.setPinned({
      id: created.item.id,
      pinned: "yes" as unknown as boolean,
    });
    assert.equal(invalid.ok, false);
    if (invalid.ok) return;
    assert.equal(invalid.reason, "invalid-content");
  });
});

test("recordUsage：写入 lastUsedAt；未知 id 与损坏文件都不抛异常", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, FILE_NAME);
    const clock = createClock();
    const service = createService(filePath, clock);

    const created = await service.create({ title: "A", content: "a" });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    clock.advance(5_000);
    const usageAt = clock.now();
    await service.recordUsage({ id: created.item.id });

    const got = await service.get({ id: created.item.id });
    assert.equal(got.ok, true);
    if (!got.ok) return;
    assert.equal(got.item.lastUsedAt, usageAt);

    // update 不应清掉 lastUsedAt。
    const updated = await service.update({
      id: created.item.id,
      title: "A-更新",
      content: "a-updated",
    });
    assert.equal(updated.ok, true);
    if (!updated.ok) return;
    assert.equal(updated.item.lastUsedAt, usageAt);

    // recentUsed 排序：使用过的排在未使用之前。
    const second = await service.create({ title: "B", content: "b" });
    assert.equal(second.ok, true);
    const list = await service.list();
    assert.equal(list.items[0]?.id, created.item.id);

    await assert.doesNotReject(() => service.recordUsage({ id: "pl_unknown" }));

    // 损坏文件：best-effort，不抛、不覆盖。
    const corruptPath = join(dir, "corrupt.json");
    await writeFile(corruptPath, "{ broken", "utf-8");
    const corruptService = createService(corruptPath);
    await assert.doesNotReject(() => corruptService.recordUsage({ id: created.item.id }));
    assert.equal(await readFile(corruptPath, "utf-8"), "{ broken");
  });
});

// ---------------------------------------------------------------------------
// 7. 最多 500 条
// ---------------------------------------------------------------------------

test("最多 500 条：第 500 条成功，第 501 条返回 too-many-items", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, FILE_NAME);
    await writeLibrary(
      filePath,
      Array.from({ length: 499 }, (_, index) => createSeedItem(index + 1)),
    );

    const service = createService(filePath);

    const fiveHundredth = await service.create({ title: "第五百条", content: "x" });
    assert.equal(fiveHundredth.ok, true);
    const diskAfter500 = await readLibraryFile(filePath);
    assert.equal(diskAfter500.items.length, 500);

    const fiveHundredFirst = await service.create({ title: "第五百零一条", content: "y" });
    assert.equal(fiveHundredFirst.ok, false);
    if (fiveHundredFirst.ok) return;
    assert.equal(fiveHundredFirst.reason, "too-many-items");

    // 被拒绝时不得写入。
    const diskAfter501 = await readLibraryFile(filePath);
    assert.equal(diskAfter501.items.length, 500);
    assert.equal(
      diskAfter501.items.some((item) => item.title === "第五百零一条"),
      false,
    );
    assert.ok(fiveHundredth.ok);
    if (fiveHundredth.ok) {
      assert.equal(
        diskAfter501.items.some((item) => item.id === fiveHundredth.item.id),
        true,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 8. 并发 create
// ---------------------------------------------------------------------------

test("并发：两个 service 实例同时 create，两条都保留", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, FILE_NAME);
    const serviceA = createService(filePath, createClock(), createIdFactory("pl_a"));
    const serviceB = createService(filePath, createClock(), createIdFactory("pl_b"));

    const [resultA, resultB] = await Promise.all([
      serviceA.create({ title: "并发 A", content: "a" }),
      serviceB.create({ title: "并发 B", content: "b" }),
    ]);
    assert.equal(resultA.ok, true);
    assert.equal(resultB.ok, true);
    if (!resultA.ok || !resultB.ok) return;

    const disk = await readLibraryFile(filePath);
    assert.equal(disk.items.length, 2);
    assert.deepEqual(
      disk.items.map((item) => item.id).sort(),
      [resultA.item.id, resultB.item.id].sort(),
    );

    const list = await serviceA.list();
    assert.equal(list.items.length, 2);
    assert.deepEqual(list.items.map((item) => item.title).sort(), ["并发 A", "并发 B"]);
  });
});

// ---------------------------------------------------------------------------
// 9. 损坏恢复
// ---------------------------------------------------------------------------

test("损坏恢复：主文件损坏 + 有效 .bak → corrupt-recovered 并恢复数据", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, FILE_NAME);
    const backupItem = createSeedItem(1, { title: "备份恢复", alias: "recovered" });
    await writeFile(filePath, "{ this is not json", "utf-8");
    await writeRawJson(`${filePath}.bak`, {
      version: 1,
      updatedAt: backupItem.updatedAt,
      items: [backupItem],
    });

    const service = createService(filePath);
    const list = await service.list();
    assert.equal(list.warning?.code, "corrupt-recovered");
    assert.equal(list.readOnly, false);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0]?.id, backupItem.id);
    assert.ok(list.warning?.quarantinePath);

    // 主文件被还原为有效 v1，且隔离文件已生成。
    const restored = await readLibraryFile(filePath);
    assert.equal(restored.version, 1);
    assert.deepEqual(restored.items, [backupItem]);
    const files = await readdir(dir);
    assert.ok(files.some((name) => name.startsWith(`${FILE_NAME}.corrupt-`)));

    // 恢复后重新可写。
    const fetched = await service.get({ id: backupItem.id });
    assert.equal(fetched.ok, true);
    const created = await service.create({ title: "恢复后新增", content: "x" });
    assert.equal(created.ok, true);

    const afterWrite = await service.list();
    assert.equal(afterWrite.warning, null);
    assert.equal(afterWrite.items.length, 2);
  });
});

test("损坏恢复：主文件损坏且无有效 .bak → corrupt-quarantined + 只读，reset 可重建", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, FILE_NAME);
    await writeFile(filePath, "{ broken json", "utf-8");

    const service = createService(filePath);
    const list = await service.list();
    assert.equal(list.warning?.code, "corrupt-quarantined");
    assert.equal(list.readOnly, true);
    assert.deepEqual(list.items, []);
    assert.ok(list.warning?.quarantinePath);

    // 所有写操作都被拒绝，且原因统一为 corrupt。
    const createResult = await service.create({ title: "t", content: "x" });
    assert.equal(createResult.ok, false);
    if (createResult.ok) return;
    assert.equal(createResult.reason, "corrupt");

    const updateResult = await service.update({ id: "pl_x", title: "t", content: "x" });
    assert.equal(updateResult.ok, false);
    if (!updateResult.ok) assert.equal(updateResult.reason, "corrupt");

    const removeResult = await service.remove({ id: "pl_x" });
    assert.equal(removeResult.ok, false);
    if (!removeResult.ok) assert.equal(removeResult.reason, "corrupt");

    const pinnedResult = await service.setPinned({ id: "pl_x", pinned: true });
    assert.equal(pinnedResult.ok, false);
    if (!pinnedResult.ok) assert.equal(pinnedResult.reason, "corrupt");

    const getResult = await service.get({ id: "pl_x" });
    assert.equal(getResult.ok, false);
    if (!getResult.ok) assert.equal(getResult.reason, "corrupt");

    await assert.doesNotReject(() => service.recordUsage({ id: "pl_x" }));

    // 重建空库。
    const reset = await service.reset();
    assert.deepEqual(reset, { ok: true });

    const afterReset = await service.list();
    assert.equal(afterReset.warning, null);
    assert.equal(afterReset.readOnly, false);
    assert.deepEqual(afterReset.items, []);

    const disk = await readLibraryFile(filePath);
    assert.deepEqual(disk, { version: 1, updatedAt: disk.updatedAt, items: [] });
    const backup = await readLibraryFile(`${filePath}.bak`);
    assert.deepEqual(backup.items, []);
  });
});

// ---------------------------------------------------------------------------
// 10. 未来版本只读
// ---------------------------------------------------------------------------

test("version: 2 → unsupported-version + readOnly，所有写操作（含 reset）拒绝", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, FILE_NAME);
    await writeRawJson(filePath, {
      version: 2,
      updatedAt: 1,
      items: [createSeedItem(1)],
    });

    const service = createService(filePath);
    const list = await service.list();
    assert.equal(list.warning?.code, "unsupported-version");
    assert.equal(list.warning?.version, 2);
    assert.equal(list.readOnly, true);

    const getResult = await service.get({ id: "pl_seed_0001" });
    assert.equal(getResult.ok, false);
    if (!getResult.ok) assert.equal(getResult.reason, "unsupported-version");

    const createResult = await service.create({ title: "t", content: "x" });
    assert.equal(createResult.ok, false);
    if (!createResult.ok) assert.equal(createResult.reason, "unsupported-version");

    const updateResult = await service.update({ id: "pl_seed_0001", title: "t", content: "x" });
    assert.equal(updateResult.ok, false);
    if (!updateResult.ok) assert.equal(updateResult.reason, "unsupported-version");

    const removeResult = await service.remove({ id: "pl_seed_0001" });
    assert.equal(removeResult.ok, false);
    if (!removeResult.ok) assert.equal(removeResult.reason, "unsupported-version");

    const pinnedResult = await service.setPinned({ id: "pl_seed_0001", pinned: true });
    assert.equal(pinnedResult.ok, false);
    if (!pinnedResult.ok) assert.equal(pinnedResult.reason, "unsupported-version");

    await assert.doesNotReject(() => service.recordUsage({ id: "pl_seed_0001" }));

    const reset = await service.reset();
    assert.equal(reset.ok, false);
    if (!reset.ok) assert.equal(reset.reason, "unsupported-version");

    // 原文件完全未被覆盖。
    const disk = await readLibraryFile(filePath);
    assert.equal(disk.version, 2);
    assert.equal(disk.items.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 11. 超大文件
// ---------------------------------------------------------------------------

test("文件超过 8MB → corrupt-quarantined + readOnly，reset 可重建", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, FILE_NAME);
    await writeFile(filePath, Buffer.alloc(PROMPT_LIBRARY_LIMITS.maxFileBytes + 1, 0x20));

    const service = createService(filePath);
    const list = await service.list();
    assert.equal(list.warning?.code, "corrupt-quarantined");
    assert.equal(list.readOnly, true);
    assert.equal(list.items.length, 0);
    // 超大文件不做整份备份，避免备份动作本身阻塞 Host。
    assert.equal(list.warning?.quarantinePath, undefined);

    const createResult = await service.create({ title: "t", content: "x" });
    assert.equal(createResult.ok, false);
    if (!createResult.ok) assert.equal(createResult.reason, "corrupt");

    const files = await readdir(dir);
    assert.equal(
      files.some((name) => name.includes(".corrupt-")),
      false,
    );

    const reset = await service.reset();
    assert.deepEqual(reset, { ok: true });

    const afterReset = await service.list();
    assert.equal(afterReset.warning, null);
    assert.equal(afterReset.readOnly, false);
    const disk = await readLibraryFile(filePath);
    assert.deepEqual(disk.items, []);
  });
});

// ---------------------------------------------------------------------------
// 12. 原子写
// ---------------------------------------------------------------------------

test("原子写：落盘 JSON 可解析且与返回值一致，无残留临时文件", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, FILE_NAME);
    const service = createService(filePath);

    const created = await service.create({ title: "原子写", content: "第一行\n第二行" });
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const diskAfterCreate = await readLibraryFile(filePath);
    assert.equal(diskAfterCreate.version, 1);
    assert.equal(diskAfterCreate.items.length, 1);
    assert.deepEqual(diskAfterCreate.items[0], created.item);

    const updated = await service.update({
      id: created.item.id,
      title: "原子写-更新",
      content: "新内容",
    });
    assert.equal(updated.ok, true);
    if (!updated.ok) return;

    const diskAfterUpdate = await readLibraryFile(filePath);
    assert.equal(diskAfterUpdate.items.length, 1);
    assert.deepEqual(diskAfterUpdate.items[0], updated.item);

    const entries = await readdir(dir);
    assert.equal(
      entries.some((name) => name.endsWith(".tmp")),
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 13. 摘要与排序纯函数
// ---------------------------------------------------------------------------

test("toPromptTemplateSummary：去掉全文，预览截断 200 字并折叠换行", () => {
  const template = createTemplate({
    id: "pl_summary",
    title: "标题",
    content: "line1\nline2\r\nline3\rline4",
    tags: ["t"],
    alias: "alias",
    pinned: true,
    lastUsedAt: 12,
    createdAt: 3,
    updatedAt: 4,
  });

  const summary = toPromptTemplateSummary(template);
  assert.equal(Object.hasOwn(summary, "content"), false);
  assert.equal(summary.contentPreview, "line1 line2 line3 line4");
  assert.equal(summary.id, template.id);
  assert.equal(summary.title, template.title);
  assert.deepEqual(summary.tags, template.tags);
  assert.equal(summary.alias, template.alias);
  assert.equal(summary.pinned, template.pinned);
  assert.equal(summary.lastUsedAt, template.lastUsedAt);
  assert.equal(summary.createdAt, template.createdAt);
  assert.equal(summary.updatedAt, template.updatedAt);

  assert.equal(
    toPromptTemplateSummary(createTemplate({ content: "x".repeat(250) })).contentPreview,
    "x".repeat(200),
  );
  // 第 200 个字符正好是换行时被压成空格，预览长度仍为 200。
  assert.equal(
    toPromptTemplateSummary(createTemplate({ content: `${"a".repeat(199)}\nrest` })).contentPreview,
    `${"a".repeat(199)} `,
  );
});

test("comparePromptTemplates：pinned 优先、三种模式与 id 兜底", () => {
  const pinnedOld = createTemplate({ id: "pl_a", pinned: true, updatedAt: 1 });
  const unpinnedNew = createTemplate({ id: "pl_b", pinned: false, updatedAt: 99 });
  // 任意模式下 pinned 都优先。
  assert.ok(comparePromptTemplates(pinnedOld, unpinnedNew, "recentUpdated") < 0);
  assert.ok(comparePromptTemplates(pinnedOld, unpinnedNew, "recentUsed") < 0);
  assert.ok(comparePromptTemplates(pinnedOld, unpinnedNew, "name") < 0);

  // recentUsed：lastUsedAt DESC，未使用排后。
  const used100 = createTemplate({ id: "pl_a", lastUsedAt: 100 });
  const used200 = createTemplate({ id: "pl_b", lastUsedAt: 200 });
  const never = createTemplate({ id: "pl_c" });
  assert.ok(comparePromptTemplates(used100, used200, "recentUsed") > 0);
  assert.ok(comparePromptTemplates(used200, used100, "recentUsed") < 0);
  assert.ok(comparePromptTemplates(never, used100, "recentUsed") > 0);
  assert.ok(comparePromptTemplates(used100, never, "recentUsed") < 0);
  // 两者都未使用 lastUsedAt 时按 id 升序兜底，不再返回 0。
  assert.ok(comparePromptTemplates(never, createTemplate({ id: "pl_d" }), "recentUsed") < 0);

  // recentUpdated：updatedAt DESC。
  assert.ok(
    comparePromptTemplates(
      createTemplate({ id: "pl_a", updatedAt: 10 }),
      createTemplate({ id: "pl_b", updatedAt: 20 }),
      "recentUpdated",
    ) > 0,
  );
  assert.ok(
    comparePromptTemplates(
      createTemplate({ id: "pl_a", updatedAt: 20 }),
      createTemplate({ id: "pl_b", updatedAt: 10 }),
      "recentUpdated",
    ) < 0,
  );

  // name：localeCompare。
  assert.ok(
    comparePromptTemplates(
      createTemplate({ id: "pl_a", title: "apple" }),
      createTemplate({ id: "pl_b", title: "banana" }),
      "name",
    ) < 0,
  );
  assert.ok(
    comparePromptTemplates(
      createTemplate({ id: "pl_a", title: "banana" }),
      createTemplate({ id: "pl_b", title: "apple" }),
      "name",
    ) > 0,
  );

  // 所有字段相同则按 id 升序兜底；同一 id 返回 0。
  assert.ok(
    comparePromptTemplates(
      createTemplate({ id: "pl_a", updatedAt: 5 }),
      createTemplate({ id: "pl_b", updatedAt: 5 }),
      "recentUpdated",
    ) < 0,
  );
  assert.equal(
    comparePromptTemplates(
      createTemplate({ id: "pl_a", updatedAt: 5 }),
      createTemplate({ id: "pl_a", updatedAt: 5 }),
      "recentUpdated",
    ),
    0,
  );

  // 用 sort 验证组合结果：pinned 在最前，其余按 updatedAt 降序。
  const sorted = [
    createTemplate({ id: "pl_1", pinned: false, updatedAt: 30 }),
    createTemplate({ id: "pl_2", pinned: true, updatedAt: 10 }),
    createTemplate({ id: "pl_3", pinned: false, updatedAt: 50 }),
  ].sort((left, right) => comparePromptTemplates(left, right, "recentUpdated"));
  assert.deepEqual(
    sorted.map((item) => item.id),
    ["pl_2", "pl_3", "pl_1"],
  );

  // 摘要与完整记录共用同一比较函数。
  const summaryA = toPromptTemplateSummary(
    createTemplate({ id: "pl_a", pinned: false, updatedAt: 10 }),
  );
  const summaryB = toPromptTemplateSummary(
    createTemplate({ id: "pl_b", pinned: false, updatedAt: 20 }),
  );
  assert.ok(comparePromptTemplates(summaryA, summaryB, "recentUpdated") > 0);
});
