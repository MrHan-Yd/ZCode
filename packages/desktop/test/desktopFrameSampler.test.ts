import assert from "node:assert/strict";
import test from "node:test";
import {
  DesktopFrameAccumulator,
  desktopFrameWhiteFraction,
  startDesktopFrameSampler,
} from "./helpers/desktopFrameSampler.js";

function syntheticRoi(width: number, height: number): Uint8Array {
  return new Uint8Array(width * height * 4);
}
function setPixel(
  pixels: Uint8Array,
  width: number,
  x: number,
  y: number,
  b: number,
  g: number,
  r: number,
): void {
  pixels.set([b, g, r, 0], (y * width + x) * 4);
}

// 这些测试只读取合成字节或无效 HWND，不把单测通过宣称成真实 DWM 校准通过。
test("桌面 ROI 仅使用 BGRA 的 RGB≥250、每四像素取样，忽略 alpha", () => {
  const pixels = syntheticRoi(8, 8);
  setPixel(pixels, 8, 0, 0, 250, 250, 250);
  setPixel(pixels, 8, 4, 0, 255, 255, 255);
  setPixel(pixels, 8, 0, 4, 249, 255, 255);
  setPixel(pixels, 8, 4, 4, 255, 249, 255);
  setPixel(pixels, 8, 1, 1, 255, 255, 255);
  assert.equal(desktopFrameWhiteFraction(pixels, 8, 8), 0.5);
  setPixel(pixels, 8, 4, 4, 255, 255, 249);
  assert.equal(desktopFrameWhiteFraction(pixels, 8, 8), 0.5);
  pixels.fill(255);
  assert.equal(desktopFrameWhiteFraction(pixels, 8, 8), 1);
});

test("ROI stride 在非四倍数尺寸也只计算区域内采样点，不接纳全屏额外字节", () => {
  const pixels = syntheticRoi(5, 5);
  setPixel(pixels, 5, 4, 4, 255, 255, 255);
  assert.equal(desktopFrameWhiteFraction(pixels, 5, 5), 0.25);
  assert.throws(() => desktopFrameWhiteFraction(new Uint8Array(104), 5, 5), /dimensions/);
  assert.throws(() => desktopFrameWhiteFraction(pixels, 0, 5), /dimensions/);
  assert.throws(() => desktopFrameWhiteFraction(pixels, 5.5, 5), /dimensions/);
});

test("白帧严格大于80%，统计实际首尾时间及min/max/average gap，不假定60fps", () => {
  const accumulator = new DesktopFrameAccumulator();
  assert.equal(accumulator.stats.frames, 0);
  assert.equal(accumulator.stats.minGapMs, 0);
  accumulator.record(0.8, 10);
  assert.equal(accumulator.stats.whiteFrames, 0);
  assert.equal(accumulator.stats.averageGapMs, 0);
  accumulator.record(0.81, 27);
  accumulator.record(0, 50);
  accumulator.record(1, 61);
  assert.deepEqual(accumulator.stats, {
    frames: 4,
    whiteFrames: 2,
    maxWhiteFraction: 1,
    minGapMs: 11,
    maxGapMs: 23,
    averageGapMs: 17,
    firstFrameMs: 10,
    lastFrameMs: 61,
    durationMs: 0,
    samplesPerFrame: 0,
  });
});

const bytes = process.arch === "ia32" ? 4 : 8;
const invalidHwnd = Buffer.alloc(bytes);
if (bytes === 8) invalidHwnd.writeBigUInt64LE(1n);
else invalidHwnd.writeUInt32LE(1);
const rect = { x: 0, y: 0, width: 8, height: 8 };

test("启动拒绝非 Buffer/零/错误长度句柄和无界ROI，校验期间不取屏幕", async () => {
  await assert.rejects(
    startDesktopFrameSampler({ nativeWindowHandle: new Uint8Array(bytes) as Buffer, rect }),
    /Buffer/,
  );
  await assert.rejects(
    startDesktopFrameSampler({ nativeWindowHandle: Buffer.alloc(bytes - 1), rect }),
    /Buffer/,
  );
  await assert.rejects(
    startDesktopFrameSampler({ nativeWindowHandle: Buffer.alloc(bytes), rect }),
    /nonzero/,
  );
  for (const badRect of [
    { ...rect, width: 0 },
    { ...rect, height: -1 },
    { ...rect, x: 0.5 },
    { ...rect, x: Number.NaN },
    { ...rect, x: 2147483647 },
    { ...rect, width: 8192, height: 8192 },
  ])
    await assert.rejects(
      startDesktopFrameSampler({ nativeWindowHandle: invalidHwnd, rect: badRect }),
      /bounded/,
    );
});

test(
  "非Windows fail closed，不用CDP或其他采样作为替代",
  { skip: process.platform === "win32" },
  async () => {
    await assert.rejects(
      startDesktopFrameSampler({ nativeWindowHandle: invalidHwnd, rect }),
      /requires Windows/,
    );
  },
);

test(
  "Windows真实worker加载本地FFI并拒绝无效HWND，重复执行不留下worker",
  {
    skip: process.platform !== "win32",
    timeout: 15_000,
  },
  async () => {
    for (let iteration = 0; iteration < 3; iteration++) {
      await assert.rejects(
        startDesktopFrameSampler({ nativeWindowHandle: invalidHwnd, rect }),
        /HWND is invalid/,
      );
    }
  },
);
