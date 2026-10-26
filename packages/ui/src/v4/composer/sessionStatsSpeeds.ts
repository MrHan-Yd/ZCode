import type { SessionPerformanceSummary } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

/**
 * 「{n} tok/s」的唯一格式化入口。工具条入口、会话统计面板与状态面板里的子智能体行都走它，
 * 避免同一个单位在两处写出不同的取整或后缀。
 */
export function formatSessionSpeedValue(speed: number, intl: IntlInstance): string {
  return intl.formatMessage({ id: "chat.sessionStats.speedValue" }, { speed: Math.round(speed) });
}

/**
 * 会话统计里「输出速度」的显示投影：集中决定每个显示面读哪个口径。
 *
 * 同一份数据在两个面上口径不同：面板的「平均输出速度」是整会话累计（持久层权威值），
 * 入口与面板的「当前输出速度」是当前轮的实时估算。两者分子与时间窗都不同，同时可见时
 * 数值不一致是预期表现——所以这里只做口径标注，不做任何"对齐成同一个数"的换算。
 */
export interface SessionStatsSpeeds {
  average: number | null;
  current: number | null;
  trigger: number | null;
}

export function resolveSessionStatsSpeeds(
  summary: Pick<SessionPerformanceSummary, "tokensPerSecond"> | null,
  liveSpeed: number | null,
): SessionStatsSpeeds {
  // 0 是合法读数：会话可能真的只有 0 tok/s（请求全都没产出 token），此时要显示 0 而不是 `--`。
  // 实时估算不会产出 0——读数没涨时 resolveLiveOutputSpeed 返回 null——所以 `??` 的回落只吃 null。
  const average = summary?.tokensPerSecond ?? null;
  return { average, current: liveSpeed, trigger: liveSpeed ?? average };
}

/**
 * 入口是否渲染。没有 sessionId 不渲染；还拿不到任何事实（草稿会话、保留期外会话）也不渲染。
 * 只要已有主链请求或工具调用记录就渲染，哪怕两个速度口径都算不出来——此时入口显示 `--`，
 * 但面板仍打得开、时长行有意义（只有工具没有主链请求的会话即属此类，见 specs 场景 5）。
 */
export function canRenderSessionStatsEntry(input: {
  sessionId: string | null;
  summary: Pick<SessionPerformanceSummary, "modelRequestCount" | "toolCallCount"> | null;
  speeds: SessionStatsSpeeds;
}): boolean {
  const hasSessionData =
    input.summary !== null &&
    (input.summary.modelRequestCount > 0 || input.summary.toolCallCount > 0);
  return Boolean(input.sessionId) && (hasSessionData || input.speeds.trigger !== null);
}
