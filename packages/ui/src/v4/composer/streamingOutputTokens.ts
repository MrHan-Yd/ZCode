import { countWideChars, estimateOutputTokensFromCharCounts } from "@zcode/shared";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

/**
 * 当前正在流式输出的估算 token 数。正文与思考都算输出；只有流式态的行参与，
 * 因此 0 表示此刻没有输出——新一轮还没吐字，或上一轮已结束。
 * 字符是流式期间唯一可得的信号，token 数只能估算（见 specs/session-performance-stats.md）。
 */
export function countStreamingOutputTokens(snapshot: ConversationSnapshot | null): number {
  if (!snapshot) return 0;
  let charCount = 0;
  let wideCharCount = 0;
  for (const row of snapshot.rows.window) {
    if (row.kind !== "assistantText" && row.kind !== "reasoning") continue;
    if (row.state !== "streaming") continue;
    charCount += row.text.length;
    wideCharCount += countWideChars(row.text);
  }
  return charCount === 0 ? 0 : estimateOutputTokensFromCharCounts(charCount, wideCharCount);
}
