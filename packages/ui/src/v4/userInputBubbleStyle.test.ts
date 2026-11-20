import assert from "node:assert/strict";
import test from "node:test";
import {
  USER_INPUT_BUBBLE_BASE_CLASS,
  USER_INPUT_BUBBLE_DEFAULT_BORDER_CLASS,
  USER_INPUT_BUBBLE_ORCHESTRATION_BORDER_CLASS,
  resolveUserInputBubbleBorderClass,
} from "@/v4/userInputBubbleStyle.js";

/**
 * 编排指令气泡标记（specs/orchestrator-mode.md 5.8）：
 * row.orchestrationEnabled 只切换边框色，其余气泡样式与经典消息完全一致。
 */

test("编排轮使用浅蓝色边框", () => {
  assert.equal(resolveUserInputBubbleBorderClass(true), "border-sky-400/70");
  assert.equal(
    resolveUserInputBubbleBorderClass(true),
    USER_INPUT_BUBBLE_ORCHESTRATION_BORDER_CLASS,
  );
});

test("经典轮保持默认边框", () => {
  assert.equal(resolveUserInputBubbleBorderClass(undefined), "border-border");
  assert.equal(resolveUserInputBubbleBorderClass(false), "border-border");
  assert.equal(
    resolveUserInputBubbleBorderClass(undefined),
    USER_INPUT_BUBBLE_DEFAULT_BORDER_CLASS,
  );
});

test("两种状态共用同一套气泡基础样式", () => {
  // 圆角/内边距/宽度约束等基础类不允许随编排状态分叉。
  assert.match(USER_INPUT_BUBBLE_BASE_CLASS, /rounded-xl/u);
  assert.match(USER_INPUT_BUBBLE_BASE_CLASS, /px-4 py-3/u);
  assert.doesNotMatch(USER_INPUT_BUBBLE_BASE_CLASS, /border-/u);
});
