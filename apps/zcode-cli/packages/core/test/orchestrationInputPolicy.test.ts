import assert from "node:assert/strict";
import test from "node:test";
import {
  decideOrchestrationInput,
  resolveOrchestrationInputMode,
  shouldPromoteDeferredOrchestrationInput,
} from "../src/orchestration/input-policy.js";

test("缺省与未知语义一律回落到 guide，不会被猜成取消", () => {
  assert.equal(resolveOrchestrationInputMode(undefined), "guide");
  assert.equal(resolveOrchestrationInputMode(""), "guide");
  assert.equal(resolveOrchestrationInputMode("cancel"), "guide");
  assert.equal(resolveOrchestrationInputMode("guide"), "guide");
  assert.equal(resolveOrchestrationInputMode("queue"), "queue");
  assert.equal(resolveOrchestrationInputMode("interrupt"), "interrupt");
});

test("没有活动 run 时三种语义都走普通 admission", () => {
  for (const mode of ["guide", "queue", "interrupt"] as const) {
    assert.deepEqual(decideOrchestrationInput({ mode, activeRunIds: [], sessionBusy: false }), {
      action: "admit",
    });
  }
});

test("空闲主会话：guide 直接开始新一轮，queue 等 run 收口，interrupt 先取消", () => {
  const runs = ["orch-a", "orch-b"];
  assert.deepEqual(
    decideOrchestrationInput({ mode: "guide", activeRunIds: runs, sessionBusy: false }),
    { action: "admit" },
  );
  assert.deepEqual(
    decideOrchestrationInput({ mode: "queue", activeRunIds: runs, sessionBusy: false }),
    { action: "defer_until_idle", runIds: runs },
  );
  assert.deepEqual(
    decideOrchestrationInput({ mode: "interrupt", activeRunIds: runs, sessionBusy: false }),
    { action: "cancel_then_admit", runIds: runs },
  );
});

test("主会话仍有在飞 turn 时交回既有 steer/queue 路径，不在 admission 里抢答", () => {
  const runs = ["orch-a"];
  for (const mode of ["guide", "queue", "interrupt"] as const) {
    assert.deepEqual(decideOrchestrationInput({ mode, activeRunIds: runs, sessionBusy: true }), {
      action: "admit",
    });
  }
});

test("run 收口后仍应提升排队消息；只有 session teardown 才放弃", () => {
  assert.equal(shouldPromoteDeferredOrchestrationInput({ shuttingDown: false }), true);
  assert.equal(shouldPromoteDeferredOrchestrationInput({ shuttingDown: true }), false);
});
