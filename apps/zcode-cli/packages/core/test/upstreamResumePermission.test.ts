import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_ENTRY_EXECUTION_STATE, type SessionEntryInfo } from "@zcode/contracts";
import type { ResumeSessionOptions } from "../src/runtime/types.js";
import {
  fixtureRuntime,
  withPermissionTestDirectory,
} from "./upstreamRuntimePermissionFixtures.js";

async function resumeWith(
  options: Pick<ResumeSessionOptions, "executionStateOverride" | "modeOverride">,
) {
  return withPermissionTestDirectory(async (directory) => {
    const fixture = fixtureRuntime({ directory });
    const sessionId = fixture.internal.sessionId;
    await fixture.runtime.ensureSessionPersistedForExternalActivity("Permission fixture");
    const entry: SessionEntryInfo = {
      id: "fixture-execution-entry",
      sessionID: sessionId,
      type: SESSION_ENTRY_EXECUTION_STATE,
      data: { mode: "yolo", planEnabled: true },
      time: { created: 1, updated: 1 },
    };
    fixture.store.entries.set(String(entry.id), entry);
    try {
      await fixture.runtime.resumeFromStore({ ...options, persistedMessages: [] });
      return {
        mode: fixture.internal.config.mode,
        planEnabled: fixture.internal.config.planEnabled,
      };
    } finally {
      fixture.runtime.beginShutdown();
    }
  });
}

test("root cold resume 无调用级覆盖时仍以落盘 execution entry 为准", async () => {
  assert.deepEqual(await resumeWith({}), { mode: "yolo", planEnabled: true });
});

test("原 modeOverride 语义保持：不会再被落盘 execution entry 覆盖", async () => {
  assert.deepEqual(await resumeWith({ modeOverride: "build" }), {
    mode: "build",
    planEnabled: false,
  });
});

test("完整 child executionStateOverride 在历史与 modeOverride 之后生效", async () => {
  assert.deepEqual(
    await resumeWith({
      modeOverride: "yolo",
      executionStateOverride: { mode: "build", planEnabled: true },
    }),
    { mode: "build", planEnabled: true },
  );
});

test("child 恢复可以清除旧 Plan 状态但不能继承旧 yolo", async () => {
  assert.deepEqual(
    await resumeWith({ executionStateOverride: { mode: "edit", planEnabled: false } }),
    { mode: "edit", planEnabled: false },
  );
});
