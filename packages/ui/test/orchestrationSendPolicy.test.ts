import assert from "node:assert/strict";
import test from "node:test";
import { resolveOrchestrationInputForSend } from "../src/v4/composer/orchestrationSendPolicy.js";

test("no active orchestration run keeps the classic delivery path", () => {
  assert.equal(resolveOrchestrationInputForSend({ activeRunCount: 0 }), undefined);
  assert.equal(
    resolveOrchestrationInputForSend({ activeRunCount: 0, requestedDelivery: "guide" }),
    undefined,
  );
});

test("an active run queues ordinary sends instead of guiding them", () => {
  assert.equal(resolveOrchestrationInputForSend({ activeRunCount: 1 }), "queue");
  assert.equal(
    resolveOrchestrationInputForSend({ activeRunCount: 2, requestedDelivery: "queue" }),
    "queue",
  );
  // followupMode=guide 的默认请求也必须回到队列：运行中发送不自动 steer。
  assert.equal(
    resolveOrchestrationInputForSend({ activeRunCount: 1, requestedDelivery: "guide" }),
    "queue",
  );
});

test("explicit startNow interrupts the active run while a run is active", () => {
  assert.equal(
    resolveOrchestrationInputForSend({ activeRunCount: 1, requestedDelivery: "startNow" }),
    "interrupt",
  );
});
