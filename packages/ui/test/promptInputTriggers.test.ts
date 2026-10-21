import assert from "node:assert/strict";
import test from "node:test";
import {
  extractActivePromptInputTrigger,
  getActivePromptInputTokenTailLength,
} from "../src/lib/promptInputTriggers.js";

/**
 * §2/§11.2：`;` 只在行首或空白后触发；`；` 只归一触发语义。
 * 这里覆盖空格、Tab、换行与全角空格 U+3000 四种前置空白。
 */
test("; 在行首触发，query 为空", () => {
  assert.deepEqual(extractActivePromptInputTrigger(";"), { trigger: ";", query: "" });
});

test("; 在空格 / Tab / 换行 / 全角空格后触发", () => {
  assert.deepEqual(extractActivePromptInputTrigger(" ;"), { trigger: ";", query: "" });
  assert.deepEqual(extractActivePromptInputTrigger("\t;"), { trigger: ";", query: "" });
  assert.deepEqual(extractActivePromptInputTrigger("\n;"), { trigger: ";", query: "" });
  // U+3000 IDEOGRAPHIC SPACE：中文输入法常见的“全角空格”。
  assert.deepEqual(extractActivePromptInputTrigger("\u3000;"), { trigger: ";", query: "" });
});

test("; 后继续输入时 query 正确截取", () => {
  assert.deepEqual(extractActivePromptInputTrigger(";go"), { trigger: ";", query: "go" });
  assert.deepEqual(extractActivePromptInputTrigger("hello ;review"), {
    trigger: ";",
    query: "review",
  });
  assert.deepEqual(extractActivePromptInputTrigger("line1\nline2 ;abc_1"), {
    trigger: ";",
    query: "abc_1",
  });
});

test("全角 ； 归一为 ; 但保留 query", () => {
  assert.deepEqual(extractActivePromptInputTrigger("；"), { trigger: ";", query: "" });
  assert.deepEqual(extractActivePromptInputTrigger("；rev"), { trigger: ";", query: "rev" });
  assert.deepEqual(extractActivePromptInputTrigger("\u3000；rev"), { trigger: ";", query: "rev" });
});

test("中文正文 / 代码 / 紧贴 token 的分号不触发提示词面板", () => {
  assert.equal(extractActivePromptInputTrigger("你好；世界"), null);
  assert.equal(extractActivePromptInputTrigger("你好;世界"), null);
  assert.equal(extractActivePromptInputTrigger("const a = 1;"), null);
  assert.equal(extractActivePromptInputTrigger("foo;bar"), null);
  // `@foo;bar` 不是提示词 trigger；它仍由 @ mention 面板消费（见下一个用例）。
  assert.notEqual(extractActivePromptInputTrigger("@foo;bar")?.trigger, ";");
  assert.equal(extractActivePromptInputTrigger("https://a.com;x"), null);
});

test("@foo;bar 仍被识别为 mention 查询", () => {
  assert.deepEqual(extractActivePromptInputTrigger("@foo;bar"), {
    trigger: "@",
    query: "foo;bar",
  });
});

test("/、@、$、#、¥、￥ 触发回归", () => {
  assert.deepEqual(extractActivePromptInputTrigger("/go"), { trigger: "/", query: "go" });
  assert.deepEqual(extractActivePromptInputTrigger("@file"), { trigger: "@", query: "file" });
  assert.deepEqual(extractActivePromptInputTrigger("$skill"), { trigger: "$", query: "skill" });
  assert.deepEqual(extractActivePromptInputTrigger("#sess"), { trigger: "#", query: "sess" });
  // 部分输入法把 `$` 输入成全角/半角日元符号，触发语义归一为 `$`。
  assert.deepEqual(extractActivePromptInputTrigger("¥skill"), { trigger: "$", query: "skill" });
  assert.deepEqual(extractActivePromptInputTrigger("￥skill"), { trigger: "$", query: "skill" });
  assert.deepEqual(extractActivePromptInputTrigger(" /cmd"), { trigger: "/", query: "cmd" });
  assert.deepEqual(extractActivePromptInputTrigger("@"), { trigger: "@", query: "" });
});

test("getActivePromptInputTokenTailLength：;go|al + goal 返回 2", () => {
  assert.equal(getActivePromptInputTokenTailLength({ trigger: ";", query: "go" }, "al", "goal"), 2);
});

test("getActivePromptInputTokenTailLength：尾部只计算与候选后缀能对上的部分", () => {
  // 候选值带触发符时先剥离再比较。
  assert.equal(
    getActivePromptInputTokenTailLength({ trigger: ";", query: "go" }, "al", ";goal"),
    2,
  );
  // 光标后遇到空白即结束，不吞掉后面的正文。
  assert.equal(
    getActivePromptInputTokenTailLength({ trigger: ";", query: "go" }, "al more", "goal"),
    2,
  );
  // 只输入了部分后缀。
  assert.equal(getActivePromptInputTokenTailLength({ trigger: ";", query: "go" }, "a", "goal"), 1);
  // 后缀对不上不删除。
  assert.equal(getActivePromptInputTokenTailLength({ trigger: ";", query: "go" }, "xx", "goal"), 0);
});

test("getActivePromptInputTokenTailLength：空 query 与无尾随文本返回 0", () => {
  assert.equal(
    getActivePromptInputTokenTailLength({ trigger: ";", query: "" }, "anything", "goal"),
    0,
  );
  assert.equal(getActivePromptInputTokenTailLength({ trigger: ";", query: "go" }, "", "goal"), 0);
  // 已经输入完整候选时没有“未输入后缀”，不能把光标后的正文当 tail。
  assert.equal(
    getActivePromptInputTokenTailLength({ trigger: ";", query: "goal" }, "x", "goal"),
    0,
  );
});
