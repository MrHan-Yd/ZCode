import assert from "node:assert/strict";
import test from "node:test";
import { hasTailPreviewContent } from "../src/lib/sessionTailPreview.js";

/**
 * 空预览必须回退骨架：会话本身没有可展示消息，或服务端因 revert 主动不提供预览。
 */

const message = {
  id: "msg-1",
  role: "user" as const,
  createdAt: 1,
  text: "hello",
  toolCallCount: 0,
};

test("null 或空列表不展示预览", () => {
  assert.equal(hasTailPreviewContent(null), false);
  assert.equal(
    hasTailPreviewContent({ sessionId: "sess-1", hasMore: false, messages: [] }),
    false,
  );
});

test("有消息时展示预览", () => {
  assert.equal(
    hasTailPreviewContent({ sessionId: "sess-1", hasMore: false, messages: [message] }),
    true,
  );
});
