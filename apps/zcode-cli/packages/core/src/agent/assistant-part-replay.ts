import type {
  ModelAssistantContent,
  ModelAssistantContentBlock,
  ModelToolCall,
} from "@zcode/contracts";

/**
 * owner metadata 键：只用于 CLI 恢复 part 顺序与回放参数，绝不能发送给 SDK。
 * 存放于既有 part.metadata JSON 列，不新增 SQLite 列或 schemaVersion。
 */
export const PROVIDER_CONTENT_INDEX_METADATA_KEY = "providerContentIndex";
export const PROVIDER_OPTIONS_METADATA_KEY = "providerOptions";

export interface ProviderReplayMetadata {
  providerContentIndex?: number;
  providerOptions?: Record<string, unknown>;
}

export function providerReplayMetadata(
  input: ProviderReplayMetadata,
): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (
    input.providerContentIndex !== undefined &&
    Number.isInteger(input.providerContentIndex) &&
    input.providerContentIndex >= 0
  ) {
    metadata[PROVIDER_CONTENT_INDEX_METADATA_KEY] = input.providerContentIndex;
  }
  if (input.providerOptions && Object.keys(input.providerOptions).length > 0) {
    metadata[PROVIDER_OPTIONS_METADATA_KEY] = { ...input.providerOptions };
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** 多次 upsert 只合并 replay 字段，不能擦掉对方 owner metadata。 */
export function mergeProviderReplayMetadata(
  base: Record<string, unknown> | undefined,
  replay: ProviderReplayMetadata | undefined,
): Record<string, unknown> | undefined {
  const extra = replay ? providerReplayMetadata(replay) : undefined;
  if (!extra) return base;
  return { ...base, ...extra };
}

export function providerContentIndexFromMetadata(
  metadata: Record<string, unknown> | undefined,
): number | undefined {
  const value = metadata?.[PROVIDER_CONTENT_INDEX_METADATA_KEY];
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** text/tool part 只投影 providerOptions 子记录，不把全部存储 metadata 当作 SDK 参数。 */
export function providerOptionsFromPartMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return plainRecord(metadata?.[PROVIDER_OPTIONS_METADATA_KEY]);
}

/**
 * 既有 reasoning part 直接以 provider namespace 作为 metadata；回放时要排除
 * providerContentIndex 等 CLI owner 字段，但她 provider namespace 原样保留。
 */
export function providerOptionsFromReasoningMetadata(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const { [PROVIDER_CONTENT_INDEX_METADATA_KEY]: _index, ...rest } = metadata;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export function hasProviderReplayOptions(
  providerOptions: Record<string, unknown> | undefined,
): boolean {
  return providerOptions !== undefined && Object.keys(providerOptions).length > 0;
}

export function providerContentIndexForToolCall(
  content: ModelAssistantContent | undefined,
  toolCallId: string,
): number | undefined {
  if (!content) return undefined;
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index]!;
    if (part.type === "tool_call" && part.id === toolCallId) return index;
  }
  return undefined;
}

export function toolCallPart(
  toolCall: ModelToolCall,
): Extract<ModelAssistantContentBlock, { type: "tool_call" }> {
  return {
    type: "tool_call",
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    ...(toolCall.providerExecuted === undefined
      ? {}
      : { providerExecuted: toolCall.providerExecuted }),
    ...(toolCall.providerOptions ? { providerOptions: { ...toolCall.providerOptions } } : {}),
  };
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
