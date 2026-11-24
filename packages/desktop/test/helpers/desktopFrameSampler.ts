import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { setTimeout as yieldWorker } from "node:timers/promises";
import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";

export interface DesktopFrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface DesktopFrameSamplerStats {
  frames: number;
  whiteFrames: number;
  maxWhiteFraction: number;
  minGapMs: number;
  maxGapMs: number;
  averageGapMs: number;
  firstFrameMs: number;
  lastFrameMs: number;
  durationMs: number;
  samplesPerFrame: number;
}
export interface DesktopFrameSamplerOptions {
  nativeWindowHandle: Buffer;
  /** Physical screen pixels; caller supplies the isolated window's central 90%, excluding native frame. */
  rect: DesktopFrameRect;
}
type SamplerMessage =
  | { type: "ready" }
  | { type: "result"; stats: DesktopFrameSamplerStats }
  | { type: "error"; message: string };

/** Pure calculation over synthetic/test ROI BGRA bytes; never persists or transmits pixels. */
export function desktopFrameWhiteFraction(
  pixels: Uint8Array,
  width: number,
  height: number,
): number {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    pixels.length !== width * height * 4
  )
    throw new Error("Invalid BGRA ROI dimensions");
  let white = 0;
  let samples = 0;
  for (let y = 0; y < height; y += 4) {
    for (let x = 0; x < width; x += 4) {
      const offset = (y * width + x) * 4;
      if (pixels[offset]! >= 250 && pixels[offset + 1]! >= 250 && pixels[offset + 2]! >= 250)
        white++;
      samples++;
    }
  }
  return white / samples;
}

/** Incremental, numeric-only statistics; the sampler worker is their sole runtime owner. */
export class DesktopFrameAccumulator {
  readonly stats: DesktopFrameSamplerStats = {
    frames: 0,
    whiteFrames: 0,
    maxWhiteFraction: 0,
    minGapMs: 0,
    maxGapMs: 0,
    averageGapMs: 0,
    firstFrameMs: 0,
    lastFrameMs: 0,
    durationMs: 0,
    samplesPerFrame: 0,
  };
  record(fraction: number, elapsedMs: number): void {
    const s = this.stats;
    if (!s.frames) s.firstFrameMs = elapsedMs;
    else {
      const gap = elapsedMs - s.lastFrameMs;
      s.minGapMs = s.frames === 1 ? gap : Math.min(s.minGapMs, gap);
      s.maxGapMs = Math.max(s.maxGapMs, gap);
    }
    s.frames++;
    if (fraction > 0.8) s.whiteFrames++;
    s.maxWhiteFraction = Math.max(s.maxWhiteFraction, fraction);
    s.lastFrameMs = elapsedMs;
    s.averageGapMs = s.frames > 1 ? (s.lastFrameMs - s.firstFrameMs) / (s.frames - 1) : 0;
  }
}

/** Windows-only OS presentation sampling, not CDP. No UI launch, profile access, files or network IO. */
export async function startDesktopFrameSampler(options: DesktopFrameSamplerOptions): Promise<{
  stop(): Promise<DesktopFrameSamplerStats>;
}> {
  const bytes = process.arch === "ia32" ? 4 : 8;
  if (!Buffer.isBuffer(options.nativeWindowHandle) || options.nativeWindowHandle.length !== bytes)
    throw new Error(`nativeWindowHandle must be a ${bytes}-byte Buffer`);
  const hwnd =
    bytes === 8
      ? options.nativeWindowHandle.readBigUInt64LE()
      : BigInt(options.nativeWindowHandle.readUInt32LE());
  if (!hwnd) throw new Error("nativeWindowHandle must be nonzero");
  const { x, y, width, height } = options.rect;
  if (
    ![x, y, width, height, x + width, y + height].every(
      (n) => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647,
    ) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 16_777_216
  )
    throw new Error("rect must be a bounded physical-pixel ROI (at most 16,777,216 pixels)");
  if (process.platform !== "win32") throw new Error("Desktop GDI frame sampler requires Windows");
  const worker = new Worker(new URL(import.meta.url), {
    // Node 24 原生擦除本文件 TS 类型；不继承父线程 eval/tsx 的非 worker flags，避免启动失败。
    execArgv: [],
    workerData: { kind: "desktop-frame-sampler", hwnd, rect: { x, y, width, height } },
  });
  const ready = Promise.withResolvers<void>();
  const done = Promise.withResolvers<DesktopFrameSamplerStats>();
  // 采样错误可能早于调用 stop；先挂拒绝观察者，最终仍把真实错误交给调用者。
  void done.promise.catch(() => undefined);
  let result: DesktopFrameSamplerStats | undefined;
  let failure: Error | undefined;
  let stopped = false;
  let exited = false;
  worker.on("message", (message: SamplerMessage) => {
    if (message.type === "ready") ready.resolve();
    else if (message.type === "result") result = message.stats;
    else failure = new Error(message.message);
  });
  worker.once("error", (error: unknown) => {
    failure = error instanceof Error ? error : new Error(String(error));
  });
  worker.once("exit", (code) => {
    exited = true;
    if (failure || code !== 0 || !result) {
      const error =
        failure ?? new Error(`Desktop sampler exited without clean result (code ${code})`);
      ready.reject(error);
      done.reject(error);
    } else done.resolve(result);
  });
  await ready.promise;
  return {
    stop() {
      if (!stopped && !exited) {
        stopped = true;
        worker.postMessage({ type: "stop" });
      }
      return done.promise;
    },
  };
}

async function sampleDesktopInWorker(): Promise<void> {
  const port = parentPort!;
  const {
    hwnd,
    rect: { x, y, width, height },
  } = workerData as { hwnd: bigint; rect: DesktopFrameRect };
  const k = createRequire(import.meta.url)("koffi") as typeof import("koffi");
  const u = k.load("user32.dll");
  const g = k.load("gdi32.dll");
  const d = k.load("dwmapi.dll");
  const kernel = k.load("kernel32.dll");
  const point = k.struct({ x: "int32_t", y: "int32_t" });
  const boundsType = k.struct({
    left: "int32_t",
    top: "int32_t",
    right: "int32_t",
    bottom: "int32_t",
  });
  const IsWindow = u.func("int __stdcall IsWindow(uintptr_t)");
  const IsWindowVisible = u.func("int __stdcall IsWindowVisible(uintptr_t)");
  const GetWindowRect = u.func("__stdcall", "GetWindowRect", "int", [
    "uintptr_t",
    k.out(k.pointer(boundsType)),
  ]);
  const WindowFromPoint = u.func("__stdcall", "WindowFromPoint", "uintptr_t", [point]);
  const GetAncestor = u.func("uintptr_t __stdcall GetAncestor(uintptr_t, uint32_t)");
  const GetWindow = u.func("uintptr_t __stdcall GetWindow(uintptr_t, uint32_t)");
  const SetDpi = u.func("intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t)");
  const GetDC = u.func("uintptr_t __stdcall GetDC(uintptr_t)");
  const ReleaseDC = u.func("int __stdcall ReleaseDC(uintptr_t, uintptr_t)");
  const CreateCompatibleDC = g.func("uintptr_t __stdcall CreateCompatibleDC(uintptr_t)");
  const CreateDIBSection = g.func(
    "uintptr_t __stdcall CreateDIBSection(uintptr_t, const void *, uint32_t, _Out_ void **, uintptr_t, uint32_t)",
  );
  const SelectObject = g.func("uintptr_t __stdcall SelectObject(uintptr_t, uintptr_t)");
  const DeleteObject = g.func("int __stdcall DeleteObject(uintptr_t)");
  const DeleteDC = g.func("int __stdcall DeleteDC(uintptr_t)");
  const BitBlt = g.func(
    "int __stdcall BitBlt(uintptr_t, int, int, int, int, uintptr_t, int, int, uint32_t)",
  );
  const GdiFlush = g.func("int __stdcall GdiFlush()");
  const DwmFlush = d.func("int32_t __stdcall DwmFlush()");
  const GetLastError = kernel.func("uint32_t __stdcall GetLastError()");
  const check = (value: unknown, api: string) => {
    if (!value) throw new Error(`${api} failed (Win32 ${GetLastError()})`);
  };
  const bounds = { left: 0, top: 0, right: 0, bottom: 0 };
  const guard = () => {
    if (!IsWindow(hwnd) || !IsWindowVisible(hwnd))
      throw new Error("Sampler target HWND is invalid or not visible");
    check(GetWindowRect(hwnd, bounds), "GetWindowRect");
    if (x < bounds.left || y < bounds.top || x + width > bounds.right || y + height > bounds.bottom)
      throw new Error("Sampler ROI is outside the target window");
    for (const dy of [0, Math.floor((height - 1) / 2), height - 1]) {
      for (const dx of [0, Math.floor((width - 1) / 2), width - 1]) {
        const hit = WindowFromPoint({ x: x + dx, y: y + dy });
        const owner = hit ? GetAncestor(hit, 3) : 0;
        if (!hit || BigInt(owner) !== hwnd)
          throw new Error(`Sampler ROI (${x + dx}, ${y + dy}) owner ${owner} differs from ${hwnd}`);
      }
    }
    // 九点探测不能发现窄小遮挡；同时检查目标上方窗口的矩形，宁可拒绝也不读其他窗口内容。
    let top = GetWindow(hwnd, 0);
    for (let count = 0; top && BigInt(top) !== hwnd; count++, top = GetWindow(top, 2)) {
      if (count >= 256) throw new Error("Sampler z-order visibility check exceeded its bound");
      if (IsWindowVisible(top)) {
        check(GetWindowRect(top, bounds), "GetWindowRect(occluder)");
        if (
          bounds.left < x + width &&
          bounds.right > x &&
          bounds.top < y + height &&
          bounds.bottom > y
        )
          throw new Error("Sampler ROI intersects a higher z-order window");
      }
    }
    if (!top) throw new Error("Sampler target disappeared from desktop z-order");
  };
  let screenDC: number | bigint = 0;
  let memoryDC: number | bigint = 0;
  let bitmap: number | bigint = 0;
  let previous: number | bigint = 0;
  let oldDpi: number | bigint = 0;
  let stopping = false;
  port.on("message", (message: { type?: string }) => {
    if (message.type === "stop") stopping = true;
  });
  const accumulator = new DesktopFrameAccumulator();
  let samplingError: unknown;
  const cleanupErrors: string[] = [];
  try {
    oldDpi = SetDpi(-4); // 只调整 worker 的 DPI 坐标，不修改 app/main 或用户配置。
    check(oldDpi, "SetThreadDpiAwarenessContext");
    guard();
    screenDC = GetDC(0);
    check(screenDC, "GetDC(NULL)");
    memoryDC = CreateCompatibleDC(screenDC);
    check(memoryDC, "CreateCompatibleDC");
    const info = Buffer.alloc(44);
    info.writeUInt32LE(40, 0);
    info.writeInt32LE(width, 4);
    info.writeInt32LE(-height, 8); // Top-down BI_RGB BGRA32, no native frame outside ROI.
    info.writeUInt16LE(1, 12);
    info.writeUInt16LE(32, 14);
    const pixelsPointer: unknown[] = [null];
    bitmap = CreateDIBSection(screenDC, info, 0, pixelsPointer, 0, 0);
    check(bitmap, "CreateDIBSection");
    check(pixelsPointer[0], "CreateDIBSection(bits)");
    previous = SelectObject(memoryDC, bitmap);
    check(previous, "SelectObject");
    const pixels = new Uint8Array(k.view(pixelsPointer[0], width * height * 4));
    accumulator.stats.samplesPerFrame = Math.ceil(width / 4) * Math.ceil(height / 4);
    const startedAt = performance.now();
    while (!stopping) {
      const hr = DwmFlush();
      if (hr < 0) throw new Error(`DwmFlush failed (HRESULT 0x${(hr >>> 0).toString(16)})`);
      guard();
      check(BitBlt(memoryDC, 0, 0, width, height, screenDC, x, y, 0x40cc0020), "BitBlt(ROI)");
      // GDI 写入可能仍在本线程批次；先 flush 再读取，避免把旧 DIB 像素误当新桌面帧。
      check(GdiFlush(), "GdiFlush");
      guard();
      accumulator.record(
        desktopFrameWhiteFraction(pixels, width, height),
        performance.now() - startedAt,
      );
      if (accumulator.stats.frames === 1)
        port.postMessage({ type: "ready" } satisfies SamplerMessage);
      await yieldWorker(0); // 让 stop 消息进入 worker；不阻塞 Electron/Node main 的事件循环。
    }
    accumulator.stats.durationMs = performance.now() - startedAt;
  } catch (error) {
    samplingError = error;
  } finally {
    // 先恢复选入对象，再释放 bitmap/DC；每项清理独立尝试，保留原始采样错误而不被 finally 覆盖。
    const cleanup = (api: string, action: () => unknown) => {
      try {
        if (!action()) cleanupErrors.push(api);
      } catch {
        cleanupErrors.push(api);
      }
    };
    if (previous && memoryDC)
      cleanup("SelectObject(restore)", () => SelectObject(memoryDC, previous));
    if (bitmap) cleanup("DeleteObject", () => DeleteObject(bitmap));
    if (memoryDC) cleanup("DeleteDC", () => DeleteDC(memoryDC));
    if (screenDC) cleanup("ReleaseDC", () => ReleaseDC(0, screenDC));
    if (oldDpi) cleanup("SetThreadDpiAwarenessContext(restore)", () => SetDpi(oldDpi));
  }
  if (samplingError) throw samplingError;
  if (cleanupErrors.length)
    throw new Error(`Desktop sampler cleanup failed: ${cleanupErrors.join(", ")}`);
  port.postMessage({ type: "result", stats: accumulator.stats } satisfies SamplerMessage);
  port.close();
}

if (!isMainThread && (workerData as { kind?: string } | null)?.kind === "desktop-frame-sampler") {
  void sampleDesktopInWorker().catch((error: unknown) => {
    parentPort!.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    } satisfies SamplerMessage);
    parentPort!.close();
  });
}
