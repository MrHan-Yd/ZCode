import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createClearDataOperation,
  waitForClearDataPreparation,
  shouldBlockQuitForClearData,
  type ClearDataDependencies,
  type ClearDataWindow,
} from "../src/main/desktopClearData.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
function fakeOperation(overrides: Partial<ClearDataDependencies> = {}) {
  const events: string[] = [];
  const preparation = deferred();
  let destroyed = false;
  const window: ClearDataWindow = {
    isDestroyed: () => destroyed,
    destroy: () => {
      events.push("destroy");
      destroyed = true;
    },
    webContents: {
      session: {
        clearStorageData: async () => {
          events.push("storage");
        },
      },
      executeJavaScript: async () => {
        throw new Error("renderer code must not run");
      },
    },
  };
  const dependencies: ClearDataDependencies = {
    confirm: async () => {
      events.push("confirm");
      return true;
    },
    beforeClearAllData: () => {
      events.push("admission");
      return preparation.promise;
    },
    listWindows: () => {
      events.push("snapshot");
      return [window];
    },
    clearAdditionalStorage: async () => {
      events.push("partition");
    },
    removeDirectory: async (path) => {
      events.push(`rm:${path}`);
    },
    stopFileLogging: () => {
      events.push("stop-log");
    },
    reportFailure: async () => {
      events.push("error");
    },
    relaunch: () => {
      events.push("relaunch");
    },
    exit: () => {
      events.push("exit");
    },
    ...overrides,
  };
  return { events, preparation, window, run: createClearDataOperation(dependencies) };
}

await test("清数据真正调用的 Main 生命周期操作（所有副作用 fake）", async (t) => {
  await t.test("取消不触发分区清理/关服务/删除/退出", async () => {
    const operation = fakeOperation({ confirm: async () => false });
    await operation.run("unchanged-v2-target");
    assert.deepEqual(operation.events, []);
    assert.equal(operation.window.isDestroyed(), false);
  });
  await t.test("确认关闭 admission 后取快照；原 owner 未退出不清理，成功仅清一次", async () => {
    const operation = fakeOperation();
    const first = operation.run("unchanged-v2-target");
    const second = operation.run("another-request-target");
    try {
      assert.equal(first, second);
      await Promise.resolve();
      assert.deepEqual(operation.events, ["confirm", "admission", "snapshot"]);
      assert.equal(operation.window.isDestroyed(), false);
      operation.preparation.resolve();
      await first;
      assert.deepEqual(operation.events, [
        "confirm",
        "admission",
        "snapshot",
        "destroy",
        "stop-log",
        "partition",
        "storage",
        "rm:unchanged-v2-target",
        "relaunch",
        "exit",
      ]);
    } finally {
      operation.preparation.resolve();
      await Promise.allSettled([first, second]);
    }
  });
  await t.test("准备失败保留窗口与草稿，不删数据或退出", async () => {
    const operation = fakeOperation();
    const pending = operation.run("unchanged-v2-target");
    const rejected = assert.rejects(pending, /host exit unverified/);
    await Promise.resolve();
    operation.preparation.reject(new Error("host exit unverified"));
    await rejected;
    assert.deepEqual(operation.events, ["confirm", "admission", "snapshot", "error"]);
    assert.equal(operation.window.isDestroyed(), false);
  });
  await t.test("storage/rm 失败不能继续 relaunch 或 exit", async () => {
    for (const stage of ["storage", "rm"]) {
      const operation = fakeOperation(
        stage === "storage"
          ? {
              clearAdditionalStorage: async () => {
                throw new Error("storage failed");
              },
            }
          : {
              removeDirectory: async () => {
                throw new Error("rm failed");
              },
            },
      );
      const pending = operation.run("unchanged-v2-target");
      const rejected = assert.rejects(pending, /failed/);
      operation.preparation.resolve();
      await rejected;
      assert.equal(operation.events.includes("relaunch"), false);
      assert.equal(operation.events.includes("exit"), false);
      assert.equal(operation.events.at(-1), "error");
    }
  });
  await t.test("设置底层 IO 永不结束时只拒绝清理，晚到完成不能重启或删除", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const drain = deferred();
    const operation = fakeOperation({
      beforeClearAllData: () => waitForClearDataPreparation(drain.promise, 50),
    });
    const pending = operation.run("unchanged-v2-target");
    const rejected = assert.rejects(pending, /preparation timed out/);
    try {
      await Promise.resolve();
      t.mock.timers.tick(50);
      await rejected;
      drain.resolve();
      await Promise.resolve();
      assert.deepEqual(operation.events, ["confirm", "snapshot", "error"]);
      assert.equal(operation.window.isDestroyed(), false);
    } finally {
      drain.resolve();
      await Promise.allSettled([pending]);
    }
  });
  await t.test("准备截止时间正常成功或失败都不改变底层 owner 的结果", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await waitForClearDataPreparation(Promise.resolve(), 50);
    await assert.rejects(
      waitForClearDataPreparation(Promise.reject(new Error("raw IO failure")), 50),
      /raw IO failure/,
    );
  });
  await t.test("清理中的普通退出被阻止，但用户显式重启恢复保留", () => {
    assert.equal(shouldBlockQuitForClearData(false, false), false);
    assert.equal(shouldBlockQuitForClearData(false, true), false);
    assert.equal(shouldBlockQuitForClearData(true, false), true);
    assert.equal(shouldBlockQuitForClearData(true, true), false);
  });
  await t.test(
    "生产接线复用严格 owner、阻止晚到 Host/Cron，并保留独立 clear admission",
    async () => {
      const main = await readFile(new URL("../src/main/index.ts", import.meta.url), "utf8");
      const commands = await readFile(
        new URL("../src/main/desktopCommandHandlers.ts", import.meta.url),
        "utf8",
      );
      const lifecycle = await readFile(
        new URL("../src/main/desktopWindowLifecycle.ts", import.meta.url),
        "utf8",
      );
      const logger = await readFile(new URL("../src/main/logger.ts", import.meta.url), "utf8");
      assert.ok(main.includes("beforeClearAllData: prepareClearAllData"));
      assert.ok(main.includes("requireCleanExit: true"));
      assert.ok(main.includes("mainSettingsLifecycle.quiesceForClearAllData()"));
      assert.ok(main.includes("canSpawnHost: () => !clearDataAdmissionClosed"));
      assert.ok(main.includes("if (clearDataAdmissionClosed) return;"));
      const beforeQuit = main.slice(main.indexOf('app.on("before-quit"'));
      assert.ok(beforeQuit.includes("shouldBlockQuitForClearData"));
      assert.ok(
        beforeQuit.indexOf("shouldBlockQuitForClearData") <
          beforeQuit.indexOf("shouldConfirmAppQuit"),
      );
      assert.ok(
        main.includes("command === DesktopCommandIds.RelaunchApp && clearDataOperationFailed"),
      );
      assert.ok(main.includes("onClearAllDataFailed:"));
      assert.ok(main.includes("appQuitPreparationInFlight || hasPreparedAppQuit"));
      assert.ok(main.includes("clearDataPreparation = waitForClearDataPreparation"));
      assert.ok(lifecycle.includes("options.canSpawnHost?.() === false"));
      assert.ok(commands.includes("createClearDataOperation"));
      assert.ok(commands.includes("stopFileLogging: options.stopFileLogging"));
      assert.ok(!commands.includes("[clear-all-data] deleted"));
      assert.ok(logger.includes("if (!fileLoggingEnabled) return;"));
    },
  );
});
