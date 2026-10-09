import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveConversationEmptySlot,
  resolveLoadingPreview,
} from "../src/v4/conversationEmptySlot.js";

test("消息区槽位优先级：草稿 > 错误 > 冷恢复占位 > 空", () => {
  // 草稿态（sessionId 为 null）永远走问候语空态，即使同时处于 connecting。
  assert.equal(
    resolveConversationEmptySlot({ isDraft: true, connecting: true, errored: true }),
    "draft",
  );
  assert.equal(
    resolveConversationEmptySlot({ isDraft: true, connecting: false, errored: false }),
    "draft",
  );

  // 错误优先于加载：错误面板接管消息区，此时不能残留骨架。
  assert.equal(
    resolveConversationEmptySlot({ isDraft: false, connecting: true, errored: true }),
    "none",
  );

  // subscribe ACK 先到、首个 snapshot 未达：这是需要骨架的那个窗口。
  assert.equal(
    resolveConversationEmptySlot({ isDraft: false, connecting: true, errored: false }),
    "loading",
  );

  // 已 live 且无行（例如被停止、无可见输出）：不塞占位，交给既有空态/正文。
  assert.equal(
    resolveConversationEmptySlot({ isDraft: false, connecting: false, errored: false }),
    "none",
  );
});

test("预览行只认非空文本，缺失时不渲染且不影响骨架", () => {
  assert.equal(resolveLoadingPreview("正在核对 backfillMac 的调用方"), "正在核对 backfillMac 的调用方");
  // sessions-index 的 lastAssistantPreview 是 optional：空、纯空白都按「没有预览」处理。
  assert.equal(resolveLoadingPreview("  上下留白  "), "上下留白");
  assert.equal(resolveLoadingPreview(""), null);
  assert.equal(resolveLoadingPreview("   \n\t "), null);
  assert.equal(resolveLoadingPreview(undefined), null);
  assert.equal(resolveLoadingPreview(null), null);
});
