import type { SessionPerformanceSnapshot } from "@zcode/shared";
import { SESSION_PERFORMANCE_MAX_SESSIONS } from "@zcode/shared";

/**
 * 「智能体」分区里运行中子智能体的速度读数：把批量会话统计按 childSessionId 归位。
 *
 * 口径是**该子会话自己的累计平均 TPS**（子代理请求记在子会话 id 上，`query_source = 'subagent'`），
 * 与父会话面板第四行同一套换算、与工具条入口的实时估算**不是**同一个数——两者不能互相换算，
 * 也不该被「修成一致」（见 specs/session-performance-stats.md 规则 4 与规则 7）。
 *
 * 缺席即不产出读数：`tokensPerSecond` 为 null 表示"还没有已完成请求 / 计量缺失 / 超出保留期"，
 * 显示层据此整段不渲染数字。既不能显示 0（会被读成"卡住了"），也不是 `--`（那是面板五行的行语义）。
 */
export function resolveSubagentSpeedReadings(
  entries: readonly SessionPerformanceSnapshot[] | null,
  childSessionIds: readonly string[],
): ReadonlyMap<string, number> {
  const readings = new Map<string, number>();
  if (!entries || entries.length === 0) return readings;
  // 只认本次请求的 id 集合：投影不替调用方过滤归属，但也不接受集合外的会话（例如上一次
  // 请求的响应晚到）。子智能体结束后的残留读数同样在这里被挡掉——它已不在集合里。
  const requested = new Set(childSessionIds);
  for (const entry of entries) {
    if (!requested.has(entry.sessionId)) continue;
    const speed = entry.summary.tokensPerSecond;
    if (speed === null) continue;
    readings.set(entry.sessionId, speed);
  }
  return readings;
}

/**
 * 收起态 trailing 取的那一个：与同一处显示的时长必须是同一个子智能体，因此按「运行最久」
 * 选（时长本身也是这一条的最长值）。全部缺少 `startedAt` 时返回第一个——此时时长显示为
 * 1 秒的兜底值，读数仍然指向同一行。
 */
export function resolveLongestRunningSubagent<T extends { startedAt?: number }>(
  subagents: readonly T[],
  now: number,
): T | null {
  let longest: T | null = null;
  let longestElapsedMs = -1;
  for (const subagent of subagents) {
    const elapsedMs = Math.max(0, now - (subagent.startedAt ?? now));
    if (elapsedMs > longestElapsedMs) {
      longest = subagent;
      longestElapsedMs = elapsedMs;
    }
  }
  return longest;
}

/**
 * 轮询要带的 id 集合：按输入顺序去重并截断到 wire schema 的上限。
 * 分区把运行中的子智能体按启动时间排序后传进来，因此截断保留的是运行最久的那些——
 * 与收起态 trailing 读的那一个一致，不会出现"页面显示的那个子智能体恰好没被轮询到"。
 */
export function resolveSubagentSpeedPollIds(childSessionIds: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const childSessionId of childSessionIds) {
    if (seen.has(childSessionId)) continue;
    seen.add(childSessionId);
    unique.push(childSessionId);
    if (unique.length >= SESSION_PERFORMANCE_MAX_SESSIONS) break;
  }
  return unique;
}
