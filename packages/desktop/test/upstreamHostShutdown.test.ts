import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  createSchedulerShutdown,
  disposeHostProcessAndWait,
  type ShutdownUtilityProcess,
} from "../src/main/desktopHostShutdown.js";

class FakeProcess extends EventEmitter implements ShutdownUtilityProcess {
  pid = 42;
  messages: Array<{ type: string }> = [];
  kills = 0;
  postMessage(message: { type: string }) {
    this.messages.push(message);
  }
  kill() {
    this.kills += 1;
    return true;
  }
}

const logger = { info: () => undefined, warn: () => undefined };

await test("清数据必须观察 Host/Cron 的物理退出，普通退出保留 fail-open", async (t) => {
  await t.test("严格 Host 等待真实 exit，重复等待不会重复发送 Dispose", async () => {
    const child = new FakeProcess();
    const timers = new WeakMap<ShutdownUtilityProcess, ReturnType<typeof setTimeout>>();
    const pending = [1, 2].map(() =>
      disposeHostProcessAndWait(child, "fake", timers, logger, {
        waitTimeoutMs: 4_500,
        forceKillDelayMs: 4_000,
        requireCleanExit: true,
      }),
    );
    let completed = false;
    void pending[0]!.then(() => {
      completed = true;
    });
    try {
      await Promise.resolve();
      assert.equal(completed, false);
      assert.equal(child.messages.length, 1);
      child.emit("exit", 0);
      await Promise.all(pending);
      assert.equal(completed, true);
    } finally {
      child.emit("exit", 0);
      await Promise.allSettled(pending);
    }
  });

  await t.test("严格 Host 非零退出拒绝；已经退出的失败也不能伪装成成功", async () => {
    const child = new FakeProcess();
    const timers = new WeakMap<ShutdownUtilityProcess, ReturnType<typeof setTimeout>>();
    const pending = disposeHostProcessAndWait(child, "fake", timers, logger, {
      requireCleanExit: true,
    });
    const failed = assert.rejects(pending, /exit|cleanup/i);
    child.emit("exit", 1);
    await failed;
    await assert.rejects(
      disposeHostProcessAndWait(child, "fake", timers, logger, { requireCleanExit: true }),
      /exit|cleanup/i,
    );
  });

  await t.test("严格 Host deadline 拒绝，不把超时或 kill 当成退出", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const child = new FakeProcess();
    const timers = new WeakMap<ShutdownUtilityProcess, ReturnType<typeof setTimeout>>();
    const pending = disposeHostProcessAndWait(child, "fake", timers, logger, {
      waitTimeoutMs: 4_500,
      forceKillDelayMs: 4_000,
      requireCleanExit: true,
    });
    const failed = assert.rejects(pending, /timed out|force|cleanup/i);
    try {
      t.mock.timers.tick(4_500);
      await failed;
      assert.equal(child.kills, 1);
      child.emit("exit", 0);
      await assert.rejects(
        disposeHostProcessAndWait(child, "fake", timers, logger, { requireCleanExit: true }),
        /force|cleanup/i,
      );
    } finally {
      child.emit("exit", 0);
      await Promise.allSettled([pending]);
    }
  });

  await t.test("普通 Host wait 超时仍 resolve（不扩大普通退出语义）", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const child = new FakeProcess();
    const timers = new WeakMap<ShutdownUtilityProcess, ReturnType<typeof setTimeout>>();
    const pending = disposeHostProcessAndWait(child, "fake", timers, logger, {
      waitTimeoutMs: 4_500,
    });
    try {
      t.mock.timers.tick(4_500);
      await pending;
    } finally {
      child.emit("exit", 0);
    }
  });

  await t.test(
    "严格 Cron 的强杀必须拒绝；普通 disposer 已resolve也不能跳过严格物理确认",
    async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const child = new FakeProcess();
      const shutdown = createSchedulerShutdown(child);
      const normal = shutdown.dispose();
      t.mock.timers.tick(1_500);
      await normal;
      const strict = shutdown.dispose({ requireCleanExit: true });
      const failed = assert.rejects(strict, /exit|force|cleanup/i);
      try {
        t.mock.timers.tick(500);
        await failed;
        assert.equal(child.kills, 1);
      } finally {
        child.emit("exit", 0);
        await Promise.allSettled([normal, strict]);
      }
    },
  );

  await t.test("Cron post 失败普通退出仍 fail-open，严格清数据拒绝", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const strict of [false, true]) {
      const child = new FakeProcess();
      child.postMessage = () => {
        throw new Error("post failed");
      };
      const pending = createSchedulerShutdown(child).dispose({ requireCleanExit: strict });
      const observed = strict ? assert.rejects(pending, /post failed/) : pending;
      try {
        t.mock.timers.tick(1_500);
        await observed;
        assert.equal(child.kills, 1);
      } finally {
        child.emit("exit", 0);
        await Promise.allSettled([pending]);
      }
    }
  });

  await t.test("严格 Cron graceful exit(0) 成功，非零退出拒绝", async () => {
    for (const code of [0, 1]) {
      const child = new FakeProcess();
      const pending = createSchedulerShutdown(child).dispose({ requireCleanExit: true });
      const observed = code === 0 ? pending : assert.rejects(pending, /exit|cleanup/i);
      child.emit("exit", code);
      await observed;
    }
  });
});
