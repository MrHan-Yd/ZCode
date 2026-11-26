import { createPartId } from "../deps.js";
import type { MessageId, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeModelStreamSnapshot } from "../types.js";
import { hasAssistantReasoningContent } from "./turn-output-token-continuation.js";
import {
  hasProviderReplayOptions,
  mergeProviderReplayMetadata,
  providerReplayMetadata,
} from "../../agent/assistant-part-replay.js";

export async function persistCancelledStreamSnapshot(
  runtime: AgentRuntimeInternal,
  options: {
    assistantCreatedAt: number;
    assistantMessageId: MessageId;
    snapshot: RuntimeModelStreamSnapshot;
    traceContext: TraceContext;
  },
): Promise<void> {
  // 用户 stop 时模型请求会以异常退出，成功路径里的最终 text/reasoning
  // 持久化不会执行；这里只 flush 已经到达本进程的 text/reasoning，工具仍等终态路径处理。
  const completedAt = Date.now();
  const assistantContent = options.snapshot.assistantContent;
  if (assistantContent) {
    for (const [providerContentIndex, part] of assistantContent.entries()) {
      if (part.type === "text") {
        if (part.text.length === 0 && !hasProviderReplayOptions(part.providerOptions)) continue;
        await runtime.persistPart(
          {
            id: createPartId(),
            sessionID: runtime.sessionId,
            messageID: options.assistantMessageId,
            type: "text",
            text: part.text,
            metadata: providerReplayMetadata({
              providerContentIndex,
              providerOptions: part.providerOptions,
            }),
            time: {
              start: options.assistantCreatedAt,
              end: completedAt,
            },
          },
          options.traceContext,
        );
        continue;
      }
      if (part.type === "reasoning") {
        if (part.text.length === 0 && !hasProviderReplayOptions(part.providerOptions)) continue;
        await runtime.persistPart(
          {
            id: createPartId(),
            sessionID: runtime.sessionId,
            messageID: options.assistantMessageId,
            type: "reasoning",
            text: part.text,
            metadata: mergeProviderReplayMetadata(part.providerOptions, { providerContentIndex }),
            time: {
              start: options.assistantCreatedAt,
              end: completedAt,
            },
          },
          options.traceContext,
        );
      }
      // tool_call 由 streaming coordinator / turn-tools 以同一 part id 持久化。
    }
    return;
  }

  for (const reasoning of options.snapshot.reasoning) {
    if (!hasAssistantReasoningContent(reasoning)) continue;
    await runtime.persistPart(
      {
        id: createPartId(),
        sessionID: runtime.sessionId,
        messageID: options.assistantMessageId,
        type: "reasoning",
        text: reasoning.text,
        metadata: reasoning.providerOptions,
        time: {
          start: options.assistantCreatedAt,
          end: completedAt,
        },
      },
      options.traceContext,
    );
  }
  if (!options.snapshot.text) {
    return;
  }
  await runtime.persistPart(
    {
      id: createPartId(),
      sessionID: runtime.sessionId,
      messageID: options.assistantMessageId,
      type: "text",
      text: options.snapshot.text,
      time: {
        start: options.assistantCreatedAt,
        end: completedAt,
      },
    },
    options.traceContext,
  );
}
