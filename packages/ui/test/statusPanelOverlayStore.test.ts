import assert from "node:assert/strict";
import test from "node:test";
import {
  closeStatusPanelOverlay,
  openStatusPanelOverlay,
  resetStatusPanelOverlay,
  subscribeStatusPanelOpened,
  toggleStatusPanelOverlay,
} from "../src/v4/statusPanelOverlayStore.js";

// 每个用例都从空状态开始：openedListeners 在模块级保存，reset 只清开关状态，
// 退订由用例自己负责。
function collectOpenEvents(): { events: string[]; dispose: () => void } {
  const events: string[] = [];
  const dispose = subscribeStatusPanelOpened((sessionId) => events.push(sessionId));
  return { events, dispose };
}

test("toggle 打开时通知打开订阅，关闭时不通知", (t) => {
  resetStatusPanelOverlay();
  const { events, dispose } = collectOpenEvents();
  t.after(dispose);

  toggleStatusPanelOverlay("s1");
  assert.deepEqual(events, ["s1"]);

  toggleStatusPanelOverlay("s1");
  assert.deepEqual(events, ["s1"], "同一 session 再点一次是关闭，不能触发互斥收起");
});

test("openStatusPanelOverlay 只在关→开跃迁时通知", (t) => {
  resetStatusPanelOverlay();
  const { events, dispose } = collectOpenEvents();
  t.after(dispose);

  openStatusPanelOverlay("s1");
  openStatusPanelOverlay("s1");
  assert.deepEqual(events, ["s1"], "已经打开时重复 open 不应再次收起 Git 浮层");

  closeStatusPanelOverlay("s1");
  openStatusPanelOverlay("s1");
  assert.deepEqual(events, ["s1", "s1"], "关闭后重新打开要再次通知");
});

test("切到另一个 session 打开面板同样通知互斥方", (t) => {
  resetStatusPanelOverlay();
  const { events, dispose } = collectOpenEvents();
  t.after(dispose);

  openStatusPanelOverlay("s1");
  toggleStatusPanelOverlay("s2");
  assert.deepEqual(events, ["s1", "s2"]);
});

test("resetStatusPanelOverlay 静默清空：不通知打开订阅，之后可再次打开", (t) => {
  resetStatusPanelOverlay();
  const { events, dispose } = collectOpenEvents();
  t.after(dispose);

  openStatusPanelOverlay("s1");
  resetStatusPanelOverlay();
  assert.deepEqual(events, ["s1"], "reset 是收起，不应触发互斥通知");

  // reset 若没真正清空状态，open 会因「已打开」而提前 return，这里就不会产生事件。
  openStatusPanelOverlay("s1");
  assert.deepEqual(events, ["s1", "s1"]);
});

test("退订后不再收到打开通知", () => {
  resetStatusPanelOverlay();
  const { events, dispose } = collectOpenEvents();
  dispose();

  openStatusPanelOverlay("s1");
  assert.deepEqual(events, []);
});
