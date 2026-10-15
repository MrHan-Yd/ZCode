import {
  sessionPerformanceBatchParamsSchema,
  type SessionPerformanceBatchResult,
  type SessionPerformanceSnapshot,
} from "@zcode/shared";
import type { SessionId } from "@zcode/contracts";
import { readSessionPerformanceAggregate } from "./session-performance.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

type SessionPerformanceQuerySource = "main_turn" | "subagent";

/** 子会话链向上找宿主的跳数上限：正常是一跳（子 → 父），嵌套子智能体多几跳，防环。 */
const MAX_PARENT_HOPS = 4;

/**
 * 批量会话统计（子智能体速度用，见 specs/session-performance-stats.md 规则 7）。
 *
 * 与单会话入口的两点差别，都是子会话本身的性质决定的：
 *
 * 1. **口径按会话种类选**：主会话读主链 `main_turn`，子智能体的子会话读 `subagent`
 *    ——子代理请求记在子会话 id 上，用主链口径会读出全 0。裁决只在这里做，
 *    客户端既不下发也不被信任为口径来源。
 * 2. **不要求运行时常驻**：运行中的 subagent 有独立 child event log，但没有独立
 *    bootstrap record（与 `v4-bridge` 的 `resolveConversationBackingRecord` 同一条事实）。
 *    因此归属与作用域判据改成「沿持久化 parentID 找回一个本进程的祖先 record」，
 *    同时**不**为了只读统计去 cold resume 子 runtime。
 *
 * 查不到归属的 id 整体缺席而不是报错：批量轮询里一个刚结束的子会话不该让整批读数失败。
 */
export async function querySessionPerformanceBatch(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<SessionPerformanceBatchResult> {
  const params = sessionPerformanceBatchParamsSchema.parse(rawParams);
  const entries: SessionPerformanceSnapshot[] = [];
  // 去重但保留请求顺序：结果顺序即入参顺序的一半由调用方决定（另一半是缺席项被跳过）。
  for (const sessionId of new Set(params.sessionIds)) {
    const querySources = await resolveSessionPerformanceSources(context, sessionId);
    if (!querySources) continue;
    entries.push(await readSessionPerformanceAggregate(context, sessionId, querySources));
  }
  return { entries };
}

async function resolveSessionPerformanceSources(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<readonly SessionPerformanceQuerySource[] | null> {
  const resident = context.sessions.get(sessionId);
  if (resident) {
    return resident.parentSessionId ? ["subagent"] : ["main_turn"];
  }

  const sessionStore = context.deps.sessionStore;
  if (!sessionStore?.getSession) return null;

  // 非驻留会话只认「有本进程祖先 record」的那些：这一条同时回答了「这个 id 属于本进程的
  // 哪个工作区」。没有祖先的（别的 workspace 的历史会话、已回收的会话）直接缺席，不报错。
  let ancestorId = (await sessionStore.getSession(sessionId as SessionId))?.parentID;
  for (let hop = 0; hop < MAX_PARENT_HOPS && ancestorId; hop += 1) {
    if (context.sessions.get(String(ancestorId))) {
      return ["subagent"];
    }
    ancestorId = (await sessionStore.getSession(ancestorId))?.parentID;
  }
  return null;
}
