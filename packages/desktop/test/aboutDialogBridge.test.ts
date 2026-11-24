import assert from "node:assert/strict";
import test from "node:test";
import { createAboutDialogBridge } from "../src/preload/aboutDialogBridge.js";

const payload = { appVersion: "4.0.1", optimizedForAppleSilicon: false };

test("About 早到请求覆盖单槽，首次订阅消费后不再回放", () => {
  const bridge = createAboutDialogBridge();
  bridge.receive({ ...payload, appVersion: "4.0.0" });
  bridge.receive(payload);
  const received: unknown[] = [];
  const dispose = bridge.subscribe((value) => received.push(value));
  assert.deepEqual(received, [payload]);
  dispose();
  bridge.subscribe((value) => received.push(value))();
  assert.deepEqual(received, [payload]);
});

test("About bridge 拒绝非法数据并精确清理 listener", () => {
  const bridge = createAboutDialogBridge();
  const received: unknown[] = [];
  const dispose = bridge.subscribe((value) => received.push(value));
  bridge.receive({ ...payload, diagnostics: "synthetic" });
  bridge.receive({ appVersion: "", optimizedForAppleSilicon: false });
  assert.equal(received.length, 0);
  bridge.receive(payload);
  assert.deepEqual(received, [payload]);
  dispose();
  dispose();
  bridge.receive({ ...payload, appVersion: "4.0.2" });
  assert.deepEqual(received, [payload]);
  bridge.subscribe((value) => received.push(value))();
  assert.equal(received.length, 2);
});
