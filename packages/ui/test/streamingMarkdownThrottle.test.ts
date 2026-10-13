import assert from "node:assert/strict";
import test from "node:test";

import { createStreamingTextThrottle } from "../src/lib/streamingMarkdownThrottle.js";

/**
 * 按 useStreamingTextThrottle 的驱动语义模拟：每条文本到达触发一次 attempt；
 * 未发射则安排 retryInMs 定时器，触发时以「当时最新文本」重试（React effect
 * 顺序保证定时器回调晚于其之前的所有文本输入）。
 */
function simulateDrive(
  inputs: Array<{ text: string; atMs: number }>,
  minIntervalMs: number,
): Array<{ text: string; atMs: number }> {
  const throttle = createStreamingTextThrottle(minIntervalMs);
  const emissions: Array<{ text: string; atMs: number }> = [];
  let latest = "";
  let timerAt: number | null = null;

  const attempt = (nowMs: number): void => {
    const { value, retryInMs } = throttle.push(latest, nowMs);
    if (value !== null) {
      emissions.push({ text: value, atMs: nowMs });
      timerAt = null;
      return;
    }
    timerAt = nowMs + retryInMs;
  };

  const ordered = [...inputs].sort((a, b) => a.atMs - b.atMs);
  let i = 0;
  for (;;) {
    const nextInput = ordered[i];
    const timerDue = timerAt;
    // 取更早的事件：输入到达或挂起定时器触发。
    if (nextInput !== undefined && (timerDue === null || nextInput.atMs <= timerDue)) {
      latest = nextInput.text;
      i += 1;
      attempt(nextInput.atMs);
      continue;
    }
    if (timerDue !== null) {
      attempt(timerDue);
      continue;
    }
    if (nextInput === undefined) break;
  }
  return emissions;
}

/** 确定性伪随机：固定种子，失败可复现。 */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

test("首帧立即发射，settle 后首帧同样立即发射", () => {
  const throttle = createStreamingTextThrottle(80);
  const first = throttle.push("a", 1000);
  assert.equal(first.value, "a");
  assert.equal(first.retryInMs, 0);

  throttle.settle();
  const second = throttle.push("b", 1010);
  assert.equal(second.value, "b");
});

test("静默期内的输入被推迟，retryInMs 精确等于剩余等待", () => {
  const throttle = createStreamingTextThrottle(80);
  throttle.push("a", 1000);
  const deferred = throttle.push("ab", 1030);
  assert.equal(deferred.value, null);
  assert.equal(deferred.retryInMs, 50);

  const ready = throttle.push("abc", 1080);
  assert.equal(ready.value, "abc");
});

test("非法间隔直接抛错", () => {
  assert.throws(() => createStreamingTextThrottle(0), RangeError);
  assert.throws(() => createStreamingTextThrottle(-1), RangeError);
  assert.throws(() => createStreamingTextThrottle(Number.NaN), RangeError);
});

test("模拟 hook 驱动：静默期满后 trailing 补发最新值，尾帧不丢", () => {
  const emissions = simulateDrive(
    [
      { text: "a", atMs: 0 },
      { text: "ab", atMs: 10 },
      { text: "abc", atMs: 20 },
      { text: "abcd", atMs: 30 },
      { text: "abcde", atMs: 40 },
    ],
    80,
  );
  // 首帧 0ms 发射；后续 10/20/30/40 均在静默期内被推迟；40ms 安排的定时器在
  // 80ms 触发并以最新文本补发。
  assert.deepEqual(
    emissions.map((e) => ({ text: e.text, atMs: e.atMs })),
    [
      { text: "a", atMs: 0 },
      { text: "abcde", atMs: 80 },
    ],
  );
});

test("随机混合序列：发射间隔恒 ≥ minIntervalMs，且最终发射值收敛到最新文本（300 轮）", () => {
  const random = makeRandom(0x51ba7e);
  for (let round = 0; round < 300; round += 1) {
    const minIntervalMs = 16 + Math.floor(random() * 128);
    const inputCount = 2 + Math.floor(random() * 30);
    let atMs = Math.floor(random() * 1000);
    let text = "";
    const inputs: Array<{ text: string; atMs: number }> = [];
    for (let i = 0; i < inputCount; i += 1) {
      // 0–40ms 的随机 chunk 间隔（覆盖 32ms flush 节奏附近的密集区间）。
      atMs += Math.floor(random() * 40);
      text += "t".repeat(1 + Math.floor(random() * 5));
      inputs.push({ text, atMs });
    }

    const emissions = simulateDrive(inputs, minIntervalMs);

    // 不变量 1：发射间隔恒 ≥ minIntervalMs（首帧除外）。
    for (let e = 1; e < emissions.length; e += 1) {
      const gap = emissions[e]!.atMs - emissions[e - 1]!.atMs;
      assert.ok(
        gap >= minIntervalMs,
        `round ${round}: emission gap ${gap} < minIntervalMs ${minIntervalMs}`,
      );
    }

    // 不变量 2：每次发射的文本都是某个历史输入（前缀链上的一环）。
    for (const emission of emissions) {
      assert.ok(
        inputs.some((input) => input.text === emission.text),
        `round ${round}: emitted text not from inputs`,
      );
    }

    // 不变量 3：挂载即有首帧发射（不空白），且发射值单调不回退（追加式文本）。
    assert.ok(emissions.length >= 1);
    for (let e = 1; e < emissions.length; e += 1) {
      assert.ok(
        emissions[e]!.text.startsWith(emissions[e - 1]!.text),
        `round ${round}: emitted text regressed`,
      );
    }

    // 不变量 4（尾帧不丢）：继续把流推进到「最后一个输入 + 间隔」后，最新文本必然
    // 已被发射（trailing 定时器收敛），settle 只需兜底时钟停摆的极端情况。
    const last = inputs[inputs.length - 1]!;
    const emittedLast = emissions.some((emission) => emission.text === last.text);
    assert.ok(
      emittedLast,
      `round ${round}: last text never emitted before settle`,
    );
  }
});
