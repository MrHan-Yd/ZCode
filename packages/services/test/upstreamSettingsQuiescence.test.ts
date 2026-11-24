import assert from "node:assert/strict";
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

let writeOperation = deferred<void>();
let writeStarted = deferred<void>();
let writeCount = 0;
const fsMock = mock.module("node:fs/promises", {
  namedExports: {
    ...fs,
    mkdir: async () => undefined,
    readFile: async () =>
      JSON.stringify({
        closeToTrayOnWindowsMigrationInitialized: true,
        messageStreamShowReasoningMigrationInitialized: true,
      }),
  },
});
const atomicMock = mock.module(new URL("../src/fs/atomicFileUtils.js", import.meta.url), {
  namedExports: {
    atomicWriteText: async () => {
      writeCount += 1;
      writeStarted.resolve();
      await writeOperation.promise;
    },
  },
});
const { createSettingServiceWithMigrations } = await import("../src/setting/settingService.js");

await test("Main 清数据设置写屏障（全部文件操作 fake）", async (t) => {
  try {
    await t.test("屏障等待已接受写入，拒绝新增写，不把未完成 IO 当成完成", async (t) => {
      t.mock.method(console, "log", () => undefined);
      writeOperation = deferred<void>();
      writeStarted = deferred<void>();
      const factory = createSettingServiceWithMigrations();
      const writing = factory.service.update({ desktopZoomLevel: 1 });
      let quiescence: Promise<void> | undefined;
      try {
        await writeStarted.promise;
        const lifecycle = factory as typeof factory & {
          quiesceForClearAllData?: () => Promise<void>;
        };
        assert.equal(typeof lifecycle.quiesceForClearAllData, "function", "Main 必须有设置写屏障");
        let completed = false;
        quiescence = lifecycle.quiesceForClearAllData!().then(() => {
          completed = true;
        });
        await Promise.resolve();
        assert.equal(completed, false, "实际写入未完成，不得允许删除数据");
        const count = writeCount;
        await assert.rejects(factory.service.update({ desktopZoomLevel: 2 }), /quiesc|stopping/i);
        assert.equal(writeCount, count);
        writeOperation.resolve();
        await writing;
        await quiescence;
        assert.equal(completed, true);
      } finally {
        writeOperation.resolve();
        await Promise.allSettled([writing, ...(quiescence ? [quiescence] : [])]);
      }
    });

    await t.test("普通写队列超时后仍在飞的真实 IO 必须等到结束，屏障失败不放行", async (t) => {
      t.mock.method(console, "log", () => undefined);
      t.mock.timers.enable({ apis: ["setTimeout"] });
      writeOperation = deferred<void>();
      writeStarted = deferred<void>();
      const factory = createSettingServiceWithMigrations();
      const writing = factory.service.update({ desktopZoomLevel: 1 });
      const writeRejected = assert.rejects(writing, /timed out/);
      let quiescence: Promise<void> | undefined;
      try {
        await writeStarted.promise;
        t.mock.timers.tick(30_000);
        await writeRejected;
        const lifecycle = factory as typeof factory & {
          quiesceForClearAllData?: () => Promise<void>;
        };
        assert.equal(typeof lifecycle.quiesceForClearAllData, "function");
        let completed = false;
        quiescence = lifecycle.quiesceForClearAllData!().then(() => {
          completed = true;
        });
        await Promise.resolve();
        assert.equal(completed, false, "timeout race 不能释放实际文件写入");
        writeOperation.reject(new Error("underlying write failed"));
        await assert.rejects(quiescence, /underlying write failed|settings.*quiesc/i);
        assert.equal(completed, false);
      } finally {
        writeOperation.resolve();
        await Promise.allSettled([writing, ...(quiescence ? [quiescence] : [])]);
      }
    });
  } finally {
    atomicMock.restore();
    fsMock.restore();
  }
});
