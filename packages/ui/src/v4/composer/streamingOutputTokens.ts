import { countWideChars, estimateOutputTokensFromCharCounts } from "@zcode/shared";
import type { ConversationRow, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";

/**
 * 行里由模型生成的输出文本：正文、思考，以及工具调用入参。
 *
 * 工具入参（`inputText`）同样是模型逐 token 生成、并在界面上逐字展示的内容；agent 轮里
 * 大量输出就是写文件/改代码的入参。只统计正文会让这些阶段一直算不出速度。
 */
function outputTextOfRow(row: ConversationRow): string | null {
  switch (row.kind) {
    case "assistantText":
    case "reasoning":
      return row.text;
    case "toolCall":
      return row.inputText;
    default:
      return null;
  }
}

/** 当前轮 = 窗口末行的 turnId。turn 是行上的标签，同一轮的行在窗口里连续。 */
function currentTurnIdOf(snapshot: ConversationSnapshot): string | null {
  return snapshot.rows.window.at(-1)?.turnId ?? null;
}

/**
 * 当前轮已产出的估算 token 数。
 *
 * 按**整轮累计**统计，不按行的 `state === "streaming"` 过滤：同一轮内已经结束的正文、
 * 思考和工具入参继续计入。段边界（思考结束 → 正文开始、正文结束 → 工具入参开始）因此
 * 不会把读数打回 0——旧口径只数「当前流式行」，每换一段都要等观测窗滑过才恢复，表现为
 * 「只有一开始有、过一会只剩平均」。跨轮（末行 turnId 变化）才归零。
 *
 * 字符是流式期间唯一可得的信号，token 数只能估算（见 specs/session-performance-stats.md 规则 4）。
 */
export function countTurnOutputTokens(snapshot: ConversationSnapshot | null): number {
  if (!snapshot) return 0;
  const turnId = currentTurnIdOf(snapshot);
  if (turnId === null) return 0;
  let charCount = 0;
  let wideCharCount = 0;
  for (const row of snapshot.rows.window) {
    if (row.turnId !== turnId) continue;
    const text = outputTextOfRow(row);
    if (text === null || text.length === 0) continue;
    charCount += text.length;
    wideCharCount += countWideChars(text);
  }
  return charCount === 0 ? 0 : estimateOutputTokensFromCharCounts(charCount, wideCharCount);
}

/**
 * 带按行缓存的整轮估算器：整轮累计意味着每秒要读的正文比单个流式行多得多，但一轮里
 * 绝大多数行已经写完、文本长度不再变化。缓存按 rowId 记住上次的 (长度, 宽字符数)，
 * 长度不变直接复用，一秒只重算仍在增长的 1~2 行；换轮清空。
 */
export function createTurnOutputTokenEstimator(): (
  snapshot: ConversationSnapshot | null,
) => number {
  let turnId: string | null = null;
  const measuredRows = new Map<number, { length: number; wideChars: number }>();
  return (snapshot) => {
    if (!snapshot) {
      turnId = null;
      measuredRows.clear();
      return 0;
    }
    const currentTurnId = currentTurnIdOf(snapshot);
    if (currentTurnId !== turnId) {
      turnId = currentTurnId;
      measuredRows.clear();
    }
    if (currentTurnId === null) return 0;
    let charCount = 0;
    let wideCharCount = 0;
    for (const row of snapshot.rows.window) {
      if (row.turnId !== currentTurnId) continue;
      const text = outputTextOfRow(row);
      if (text === null || text.length === 0) continue;
      let measured = measuredRows.get(row.rowId);
      if (measured === undefined || measured.length !== text.length) {
        measured = { length: text.length, wideChars: countWideChars(text) };
        measuredRows.set(row.rowId, measured);
      }
      charCount += measured.length;
      wideCharCount += measured.wideChars;
    }
    return charCount === 0 ? 0 : estimateOutputTokensFromCharCounts(charCount, wideCharCount);
  };
}
