import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
// 同目录兄弟用相对路径：包内导入按 ui 的约定收敛到带 .js 后缀的相对路径，
// 也让这个模块能被 node:test 直接加载（别名只在应用构建的 tsconfig paths 下可解析）。
import { createTurnOutputTokenEstimator } from "./streamingOutputTokens.js";

/**
 * 实时输出 token 读数的采样边界：逐帧只挂最新快照（一次赋值），估算留到真正读的那一刻。
 *
 * 为什么需要这道边界：估算成本与已输出正文长度成正比（要对整段正文做一次 CJK 字符扫描），
 * 而它唯一的消费方 `useLiveOutputSpeed` 只在 1 秒时钟上取样本。写成「每帧重算 + 写 ref」
 * 等于把每帧的正文重扫一遍去喂一个每秒只用一次的数：本机实测 10k 字符 0.25ms、40k 字符
 * 1.46ms 一次，按流式 flush 的 32ms 节奏折算是每个帧窗 1.5% ~ 9%。按需估算后每帧只剩
 * 一次赋值，估算次数从「每个流式帧」降到「每秒一次」。
 *
 * 默认估算按**当前轮累计**统计正文、思考与工具入参（见 countTurnOutputTokens），已写完的
 * 行按 rowId 缓存字符扫描结果，因此每秒只重算仍在增长的行。读到的始终是**最新已提交快照**
 * 上这一轮的读数；没有任何人读时（入口不渲染、会话不在流式态）连一次估算都不会发生。
 */
export interface LiveOutputTokenReader {
  /**
   * 挂上本帧的最新快照。只在流式态读得到数：非流式（草稿、已结束、被停止）直接挂 null，
   * 于是读数恒为 0——与旧实现「不在 streaming 相位就写 0」同一语义。
   */
  setSnapshot(snapshot: ConversationSnapshot | null, streaming: boolean): void;
  /** 只在采样时刻调用；每次调用做一次估算。 */
  read(): number;
}

export function createLiveOutputTokenReader(
  estimate: (snapshot: ConversationSnapshot | null) => number = createTurnOutputTokenEstimator(),
): LiveOutputTokenReader {
  let latest: ConversationSnapshot | null = null;
  return {
    setSnapshot(snapshot, streaming) {
      latest = streaming ? snapshot : null;
    },
    read() {
      return estimate(latest);
    },
  };
}
