import assert from "node:assert/strict";
import test from "node:test";

import {
  fitContentWithSuffix,
  type ResultPreviewDirection,
} from "../src/tool/executor/result-content-projection.js";

/** 确定性伪随机：固定种子，失败可复现。 */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

/** 生成含多字节字符与换行的随机文本（覆盖 UTF-8 边界与行结构）。 */
function makeRandomText(random: () => number, targetBytes: number): string {
  const pieces = ["error:", "PASS", "at Object.<anonymous>", "✓", "中文输出", "\n", " ", "exit code 1"];
  let text = "";
  // char length ≤ 字节长度，用指数回退的全量字节测量替代逐步测量，避免 O(n²) 扫描。
  let nextMeasure = 1024;
  for (;;) {
    text += pieces[Math.floor(random() * pieces.length)];
    if (text.length >= nextMeasure) {
      if (Buffer.byteLength(text, "utf8") >= targetBytes) return text;
      nextMeasure *= 2;
    }
  }
}

test("head/tail 方向行为与既有语义逐字节一致", () => {
  const content = "abcdefgh";
  const suffix = "\n\n[truncated]";
  // 全量放得下：原样返回 + 后缀。
  assert.equal(fitContentWithSuffix(content, 100, suffix, "head"), `${content}${suffix}`);
  assert.equal(fitContentWithSuffix(content, 100, suffix, "tail"), `${content}${suffix}`);
  // head：保留开头（预算需容得下 13B 后缀 + 部分内容；后缀优先占预算是既有语义）。
  const headResult = fitContentWithSuffix(content, 18, suffix, "head");
  assert.ok(headResult.startsWith("a"));
  assert.ok(headResult.endsWith(suffix));
  // tail：保留结尾。
  const tailResult = fitContentWithSuffix(content, 18, suffix, "tail");
  assert.ok(tailResult.startsWith("d"));
  assert.ok(tailResult.endsWith(suffix));
});

test("head-tail：head 是前缀、tail 是后缀、总字节 ≤ 预算、省略字节数精确", () => {
  const random = makeRandom(0x7e1a2b);
  // 规模控制：fitStringToBytes 是 O(n log n) 且逐次分配字符数组，200KB × 300 轮
  // 会跑分钟级；40KB × 80 轮已覆盖退化/截断/字节边界全部路径。
  for (let round = 0; round < 80; round += 1) {
    const contentBytes = 200 + Math.floor(random() * 40_000);
    const content = makeRandomText(random, contentBytes);
    const suffix = `\n\n[Tool output truncated: originalBytes=${Math.floor(random() * 1_000_000)}]`;
    const maxBytes = 64 + Math.floor(random() * 4096);
    const direction: ResultPreviewDirection = "head-tail";

    const result = fitContentWithSuffix(content, maxBytes, suffix, direction);

    // 不变量 1：总字节严格不超预算。
    const resultBytes = Buffer.byteLength(result, "utf8");
    assert.ok(resultBytes <= maxBytes, `round ${round}: ${resultBytes} > ${maxBytes}`);

    // 不变量 2：head 是原文前缀、tail 是原文后缀（去掉 marker 与 suffix 后）。
    const markerMatch = result.match(/\n\n\[\.\.\. (\d+) bytes in the middle omitted \.\.\.\]\n\n/);
    if (!markerMatch) {
      // 合法的无 marker 情形：内容整体放得下（原样返回），或预算装不下
      // marker+两端内容而退化为 head 截断（specs/tool-result-head-tail-truncation.md）。
      const stripped = result.slice(0, result.length - suffix.length);
      assert.ok(
        content.startsWith(stripped),
        `round ${round}: no-marker result is not a prefix of content`,
      );
      continue;
    }
    const omittedClaimed = Number(markerMatch![1]);
    const markerStart = result.indexOf(markerMatch![0]);
    const head = result.slice(0, markerStart);
    const tail = result.slice(markerStart + markerMatch![0].length, result.length - suffix.length);
    assert.ok(content.startsWith(head), `round ${round}: head is not a prefix`);
    assert.ok(content.endsWith(tail), `round ${round}: tail is not a suffix`);

    // 不变量 3：声称的省略字节数 = 原文字节 - head 字节 - tail 字节。
    const omittedReal =
      Buffer.byteLength(content, "utf8") - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
    assert.equal(omittedClaimed, omittedReal, `round ${round}: omitted byte count mismatch`);
    assert.ok(omittedReal > 0, `round ${round}: nothing omitted but marker present`);
  }
});

test("head-tail：极小预算退化为 head，不产出挤占预算的 marker", () => {
  const content = makeRandomText(makeRandom(42), 50_000);
  const suffix = "[truncated]";
  const result = fitContentWithSuffix(content, 512, suffix, "head-tail");
  assert.ok(!result.includes("bytes in the middle omitted"));
  assert.ok(Buffer.byteLength(result, "utf8") <= 512);
});

test("head-tail：内容装得下时截断后缀必须保留（与 head/tail 同契约）", () => {
  const content = "short content";
  const suffix = "\n\n[Tool output truncated by resultBudget]";
  // 预算远大于内容：head-tail 不能像修复前那样静默丢掉 suffix。
  assert.equal(fitContentWithSuffix(content, 10_000, suffix, "head-tail"), `${content}${suffix}`);
  // 边界：预算恰好等于 内容 + 后缀。
  const exact = Buffer.byteLength(`${content}${suffix}`, "utf8");
  assert.equal(fitContentWithSuffix(content, exact, suffix, "head-tail"), `${content}${suffix}`);
});

test("head-tail：恰好略超预算的内容也能截断且信息不假", () => {
  const content = "a".repeat(5048);
  const suffix = "[truncated]";
  const result = fitContentWithSuffix(content, 5000, suffix, "head-tail");
  assert.ok(Buffer.byteLength(result, "utf8") <= 5000);
  assert.ok(result.includes("bytes in the middle omitted"));
});
