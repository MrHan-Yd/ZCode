import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

/**
 * `@streamdown/code` 的 token 缓存规模探针。
 *
 * 该缓存由第三方包持有，原先无淘汰：key 含代码长度，流式期间每次增量都是新 key，
 * 因此条目数约等于高亮调用次数 —— 实测一个 40 条消息的会话可累积 4795 条 / 282MB heap，
 * 而它对本项目的内存诊断原本完全不可见。
 *
 * 我们用 pnpm 补丁给它加了「代码字符总量」上界并注入这个只读探针
 * （见 patches/@streamdown__code@1.1.1.patch），把它的规模纳入常规采样，
 * 这样上界可以按真实会话数据调，而不是靠合成负载拍一个数。
 *
 * 补丁未应用时探针不存在，provider 返回空对象即可：缺少补丁不能让诊断或构建失败。
 */
interface StreamdownCodeCacheStats {
  entries?: number;
  chars?: number;
}

type StreamdownCodeCacheProbe = () => StreamdownCodeCacheStats;

function readStreamdownCodeCacheProbe(): StreamdownCodeCacheProbe | undefined {
  const probe = (
    globalThis as typeof globalThis & {
      __zcodeStreamdownCodeCacheStats?: StreamdownCodeCacheProbe;
    }
  ).__zcodeStreamdownCodeCacheStats;
  return typeof probe === "function" ? probe : undefined;
}

uiMemoryDiagnosticsRegistry.register("streamdownCodeCache", () => {
  const probe = readStreamdownCodeCacheProbe();
  if (!probe) {
    return {};
  }

  const stats = probe();
  const counters: Record<string, number> = {};
  if (typeof stats.entries === "number") {
    counters.entries = stats.entries;
  }
  if (typeof stats.chars === "number") {
    counters.chars = stats.chars;
  }
  return counters;
});
