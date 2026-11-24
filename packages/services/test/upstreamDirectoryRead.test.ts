import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import { mock, test } from "node:test";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function entry(name: string, kind: "file" | "directory" | "symlink"): Dirent {
  return {
    name,
    parentPath: "/fixture",
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
}

const reads: Array<{ path: string; operation: ReturnType<typeof deferred<Dirent[]>> }> = [];
const fsMock = mock.module("node:fs/promises", {
  namedExports: {
    ...fs,
    readdir: (path: string) => {
      const operation = deferred<Dirent[]>();
      reads.push({ path, operation });
      return operation.promise;
    },
    stat: async () => ({ isDirectory: () => true }),
  },
});
const { createFileService } = await import("../src/file/fileService.js");

await test("上游挂起目录读取保护（不访问真实目录）", async (t) => {
  try {
    await t.test("达到无响应阈值后跨 service 实例复用底层读取", async (t) => {
      let now = 1_000;
      t.mock.method(Date, "now", () => now);
      const firstService = createFileService();
      const secondService = createFileService();
      const offset = reads.length;
      const promises = [firstService.readdir({ path: "/fixture/slow" })];
      try {
        assert.equal(reads.length - offset, 1);
        now += 30_000;
        promises.push(secondService.readdir({ path: "/fixture/slow", includeHidden: true }));
        promises.push(firstService.readdir({ path: "/fixture/slow" }));
        assert.equal(reads.length - offset, 1, "挂起目录不应重复占用 libuv 线程");
        reads[offset]!.operation.resolve([entry(".hidden", "directory"), entry("a", "file")]);
        const [visible, hidden, repeated] = await Promise.all(promises);
        assert.deepEqual(
          visible?.map((item) => item.name),
          ["a"],
        );
        assert.deepEqual(
          hidden?.map((item) => item.name),
          [".hidden", "a"],
        );
        assert.deepEqual(repeated, visible);
      } finally {
        for (const read of reads.slice(offset)) read.operation.resolve([]);
        await Promise.allSettled(promises);
      }
    });

    await t.test("阈值前独立读完成不能清除最早挂起的记录", async (t) => {
      let now = 1_000;
      t.mock.method(Date, "now", () => now);
      const service = createFileService();
      const offset = reads.length;
      const promises = [service.readdir({ path: "/fixture/concurrent" })];
      try {
        now += 29_999;
        promises.push(service.readdir({ path: "/fixture/concurrent" }));
        assert.equal(reads.length - offset, 2, "健康并发保持既有行为");
        reads[offset + 1]!.operation.resolve([entry("fresh", "file")]);
        await promises[1];
        now += 1;
        promises.push(service.readdir({ path: "/fixture/concurrent" }));
        assert.equal(reads.length - offset, 2, "较晚并发完成不能解除最早挂起的保护");
        reads[offset]!.operation.resolve([]);
        await Promise.all(promises);
      } finally {
        for (const read of reads.slice(offset)) read.operation.resolve([]);
        await Promise.allSettled(promises);
      }
    });

    await t.test("成功和失败后都重新读取，不缓存目录内容或错误", async (t) => {
      let now = 1_000;
      t.mock.method(Date, "now", () => now);
      const service = createFileService();
      const offset = reads.length;
      const promises: Array<Promise<unknown>> = [];
      try {
        const first = service.readdir({ path: "/fixture/settled" });
        promises.push(first);
        reads[offset]!.operation.resolve([entry("old", "file")]);
        assert.deepEqual(
          (await first).map((item) => item.name),
          ["old"],
        );
        const second = service.readdir({ path: "/fixture/settled" });
        promises.push(second);
        assert.equal(reads.length - offset, 2);
        const rejected = assert.rejects(second, /permission denied/);
        reads[offset + 1]!.operation.reject(new Error("permission denied"));
        await rejected;
        now += 60_000;
        const third = service.readdir({ path: "/fixture/settled" });
        promises.push(third);
        assert.equal(reads.length - offset, 3);
        reads[offset + 2]!.operation.resolve([
          entry("z", "file"),
          entry("b", "directory"),
          entry("a", "symlink"),
        ]);
        const result = await third;
        assert.deepEqual(
          result.map((item) => [item.name, item.type, item.isSymbolicLink]),
          [
            ["a", "directory", true],
            ["b", "directory", false],
            ["z", "file", false],
          ],
        );
      } finally {
        for (const read of reads.slice(offset)) read.operation.resolve([]);
        await Promise.allSettled(promises);
      }
    });
  } finally {
    fsMock.restore();
  }
});
