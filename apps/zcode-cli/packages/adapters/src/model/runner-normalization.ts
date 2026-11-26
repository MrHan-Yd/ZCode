import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import type {
  Logger,
  ModelAssistantContent,
  ModelReasoningContentBlock,
  ModelSource,
  ModelStreamEvent,
  ModelTextResult,
  ModelToolResult,
  ModelUsage,
} from "@zcode/contracts";
import { normalizeModelToolInput } from "./tool-input-normalization.js";
import type { AiSdkGenerateTextResult } from "./runner-runtime.js";
import { asRecord, isRecord, numberProperty, stringProperty } from "./runner-record.js";
import { normalizeModelToolName } from "./tool-call-validation.js";
import { readModelRequestCostUsd } from "./model-request-cost.js";

export function normalizeUsage(usage?: Partial<LanguageModelUsage>): ModelUsage {
  const rawUsage = isRecord(usage?.raw) ? usage.raw : undefined;
  const rawServerToolUse = isRecord(rawUsage?.server_tool_use)
    ? rawUsage.server_tool_use
    : undefined;
  const webSearchRequests = numberProperty(rawServerToolUse, "web_search_requests");
  const webFetchRequests = numberProperty(rawServerToolUse, "web_fetch_requests");
  const costUsd = readModelRequestCostUsd(rawUsage);

  return {
    ...(costUsd !== undefined ? { costUsd } : {}),
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    totalTokens: usage?.totalTokens,
    cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens,
    cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens,
    reasoningTokens: usage?.outputTokenDetails?.reasoningTokens,
    ...(webSearchRequests !== undefined || webFetchRequests !== undefined
      ? {
          serverToolUse: {
            webFetchRequests,
            webSearchRequests,
          },
        }
      : {}),
  };
}

export function normalizeReasoning(
  reasoning?: readonly {
    providerMetadata?: unknown;
    text?: string;
    type?: string;
  }[],
): ModelReasoningContentBlock[] | undefined {
  if (!reasoning || reasoning.length === 0) {
    return undefined;
  }

  return reasoning
    .filter((part) => part.type === "reasoning" && typeof part.text === "string")
    .map((part) => ({
      type: "reasoning",
      text: part.text!,
      providerOptions: isRecord(part.providerMetadata) ? part.providerMetadata : undefined,
    }));
}

/**
 * 从 SDK 原始有序 content 生成 assistantContent。
 * 原因：聚合 text/toolCalls 会丢失签名归属和 interleaving；不能从 result.text 重建。
 * 显式空 content 返回空数组，调用方不得再回退旧视图。
 */
export function normalizeAssistantContent(
  result: AiSdkGenerateTextResult,
  logger?: Logger,
): ModelAssistantContent | undefined {
  const content = (result as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const blocks: ModelAssistantContent = [];
  content.forEach((part, index) => {
    const record = plainRecord(part);
    switch (record?.type) {
      case "text": {
        if (typeof record.text !== "string") return;
        const providerOptions = plainRecord(record.providerMetadata);
        // 空文本只有在携带签名等回放元数据时才是有效 part。
        if (record.text.length === 0 && providerOptions === undefined) return;
        blocks.push({
          type: "text",
          text: record.text,
          ...(providerOptions ? { providerOptions } : {}),
        });
        return;
      }

      case "reasoning": {
        if (typeof record.text !== "string") return;
        const providerOptions = plainRecord(record.providerMetadata);
        // 无正文但有 provider 元数据的 reasoning 也要保留，不能用空壳清理误删签名。
        if (record.text.length === 0 && providerOptions === undefined) return;
        blocks.push({
          type: "reasoning",
          text: record.text,
          ...(providerOptions ? { providerOptions } : {}),
        });
        return;
      }

      case "tool-call": {
        const id = typeof record.toolCallId === "string" ? record.toolCallId : crypto.randomUUID();
        const name = normalizeModelToolName(record.toolName, {
          providerExecuted: booleanProperty(record, "providerExecuted"),
          source: "generateText",
          toolCallId: id,
          toolCallIndex: index,
        });
        const providerOptions = plainRecord(record.providerMetadata);
        const providerExecuted = booleanProperty(record, "providerExecuted");
        blocks.push({
          type: "tool_call",
          id,
          name,
          ...(providerExecuted === undefined ? {} : { providerExecuted }),
          input: normalizeModelToolInput(record.input, {
            logger,
            source: "generateText",
            toolName: name,
          }),
          ...(providerOptions ? { providerOptions } : {}),
        });
        return;
      }

      default:
        // source/file/tool-result 等不在 assistant replay 联合内；它们不拥有签名。
        return;
    }
  });

  return blocks;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function booleanProperty(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function providerMetadataRecord(value: unknown): Record<string, unknown> | undefined {
  return plainRecord(value);
}

export function toModelStreamEvent(chunk: TextStreamPart<ToolSet>): ModelStreamEvent | undefined {
  switch (chunk.type) {
    case "start":
      return {
        type: "start",
      };

    case "text-start":
      return {
        type: "text_start",
        id: chunk.id,
        providerMetadata: providerMetadataRecord(chunk.providerMetadata),
      };

    case "text-delta":
      return {
        type: "text_delta",
        id: chunk.id,
        text: chunk.text,
        providerMetadata: providerMetadataRecord(chunk.providerMetadata),
      };

    case "text-end":
      return {
        type: "text_end",
        id: chunk.id,
        providerMetadata: providerMetadataRecord(chunk.providerMetadata),
      };

    case "reasoning-start":
      return {
        type: "reasoning_start",
        id: chunk.id,
        providerMetadata: isRecord(chunk.providerMetadata) ? chunk.providerMetadata : undefined,
      };

    case "reasoning-delta":
      return {
        type: "reasoning_delta",
        id: chunk.id,
        text:
          stringProperty(asRecord(chunk), "delta") ?? stringProperty(asRecord(chunk), "text") ?? "",
        providerMetadata: isRecord(chunk.providerMetadata) ? chunk.providerMetadata : undefined,
      };

    case "reasoning-end":
      return {
        type: "reasoning_end",
        id: chunk.id,
        providerMetadata: isRecord(chunk.providerMetadata) ? chunk.providerMetadata : undefined,
      };

    case "tool-input-start": {
      const inputStartToolName = normalizeModelToolName(chunk.toolName, {
        providerExecuted: chunk.providerExecuted,
        source: "streamText",
        streamChunkType: chunk.type,
        toolCallId: chunk.id,
      });
      return {
        type: "tool_input_start",
        id: chunk.id,
        providerExecuted: chunk.providerExecuted,
        toolName: inputStartToolName,
      };
    }

    case "tool-input-delta":
      return {
        type: "tool_input_delta",
        id: chunk.id,
        delta: chunk.delta,
      };

    case "tool-input-end":
      return {
        type: "tool_input_end",
        id: chunk.id,
      };

    case "tool-call": {
      // 签名/回放元数据只属于这个调用 part，不能挂到结果或聚合文本上。
      const providerOptions = providerMetadataRecord(chunk.providerMetadata);
      return {
        type: "tool_call",
        toolCall: {
          id: chunk.toolCallId,
          // Final tool-call 的 name/input 由 assembler 统一校验和归一化。
          name: chunk.toolName,
          providerExecuted: chunk.providerExecuted,
          // 执行参数只取 AI SDK final tool-call，避免从展示用 delta 猜测输入，
          // 也避免 stream/model-io 多次解析并重复告警。
          input: chunk.input,
          ...(providerOptions ? { providerOptions } : {}),
        },
      };
    }

    case "finish":
      return {
        type: "finish",
        finishReason: chunk.finishReason,
        providerMetadata: buildFinishProviderMetadata(chunk),
        usage: normalizeUsage(chunk.totalUsage),
      };

    case "error":
      return {
        type: "error",
        error: chunk.error,
      };

    default:
      return undefined;
  }
}

export function normalizeToolCalls(
  result: AiSdkGenerateTextResult,
  logger?: Logger,
): ModelTextResult["toolCalls"] {
  const toolCalls = (result as unknown as { toolCalls?: unknown[] }).toolCalls;
  if (!Array.isArray(toolCalls)) return undefined;

  return toolCalls.map((toolCall, index) => {
    const value = toolCall as {
      toolCallId?: string;
      id?: string;
      toolName?: string;
      name?: string;
      input?: unknown;
      args?: unknown;
      providerExecuted?: boolean;
    };
    const id = value.toolCallId ?? value.id ?? crypto.randomUUID();
    const name = normalizeModelToolName(value.toolName ?? value.name, {
      providerExecuted: value.providerExecuted,
      source: "generateText",
      toolCallId: id,
      toolCallIndex: index,
    });

    return {
      id,
      name,
      providerExecuted: value.providerExecuted,
      // 上游会把 JSON "null" 转成原生 null；显式 null 不能被
      // nullish fallback 擦成旧版 args，否则 runtime 与 provider-visible input 漂移。
      input: normalizeModelToolInput(value.input !== undefined ? value.input : value.args, {
        logger,
        source: "generateText",
        toolName: name,
      }),
    };
  });
}

export function normalizeToolResults(
  result: AiSdkGenerateTextResult,
  normalizedToolCalls?: ModelTextResult["toolCalls"],
): ModelToolResult[] | undefined {
  const toolResults = (result as unknown as { toolResults?: unknown[] }).toolResults;
  if (!Array.isArray(toolResults)) return undefined;
  const normalizedInputByToolCallId = new Map(
    (normalizedToolCalls ?? []).map((toolCall) => [toolCall.id, toolCall.input]),
  );

  const normalized = toolResults.map((toolResult) => {
    const value = toolResult as {
      toolCallId?: string;
      id?: string;
      toolName?: string;
      name?: string;
      input?: unknown;
      output?: unknown;
      result?: unknown;
      providerExecuted?: boolean;
      providerMetadata?: unknown;
    };

    const id = value.toolCallId ?? value.id ?? crypto.randomUUID();
    return {
      id,
      name: value.toolName ?? value.name ?? "unknown",
      // AI SDK 会为 invalid tool-call 生成携带原始 input 的 tool-error。
      // 复用同 id final call 的归一化结果，避免 malformed string/null 从 toolResults 泄漏。
      input: normalizedInputByToolCallId.has(id)
        ? normalizedInputByToolCallId.get(id)
        : value.input,
      output: value.output ?? value.result,
      providerExecuted: value.providerExecuted,
      providerMetadata: isRecord(value.providerMetadata)
        ? (value.providerMetadata as Record<string, unknown>)
        : undefined,
    };
  });

  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeSources(result: AiSdkGenerateTextResult): ModelSource[] | undefined {
  const sources = (result as unknown as { sources?: unknown[] }).sources;
  if (!Array.isArray(sources)) return undefined;

  const normalized = sources
    .map((source): ModelSource | undefined => {
      if (!isRecord(source)) return undefined;
      const sourceType = stringProperty(source, "sourceType");
      if (sourceType !== "url" && sourceType !== "document") return undefined;

      return {
        type: "source",
        sourceType,
        id: stringProperty(source, "id"),
        url: stringProperty(source, "url"),
        title: stringProperty(source, "title"),
        mediaType: stringProperty(source, "mediaType"),
        filename: stringProperty(source, "filename"),
        providerMetadata: isRecord(source.providerMetadata)
          ? (source.providerMetadata as Record<string, unknown>)
          : undefined,
      };
    })
    .filter((source): source is ModelSource => source !== undefined);

  return normalized.length > 0 ? normalized : undefined;
}

function buildFinishProviderMetadata(
  chunk: TextStreamPart<ToolSet>,
): Record<string, unknown> | undefined {
  if (chunk.type !== "finish") return undefined;

  const record = asRecord(chunk);
  const providerMetadata = isRecord(record.providerMetadata) ? { ...record.providerMetadata } : {};
  const response = isRecord(record.response) ? record.response : undefined;
  const responseBody = response && isRecord(response.body) ? response.body : undefined;

  const merged = {
    ...providerMetadata,
    ...(response ? { response } : {}),
    ...(responseBody ?? {}),
    ...(record.rawFinishReason === undefined ? {} : { rawFinishReason: record.rawFinishReason }),
  };

  return Object.keys(merged).length > 0 ? merged : undefined;
}
