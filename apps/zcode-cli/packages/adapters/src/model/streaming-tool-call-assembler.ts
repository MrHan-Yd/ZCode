import type {
  Logger,
  ModelAssistantContent,
  ModelStreamEvent,
  ModelToolCall,
} from "@zcode/contracts";
import { normalizeModelToolInput } from "./tool-input-normalization.js";
import { normalizeModelToolName } from "./tool-call-validation.js";

interface StreamingToolCallAssemblerOptions {
  logger?: Logger;
}

/**
 * 单个 provider part 的有序占位。text/reasoning 在 start 时保留位置，
 * tool-call 在 tool-input-start 时保留声明位置，final call 到达后原位替换。
 */
type OrderedAssistantPart =
  | { kind: "text"; id: string; text: string; metadata?: Record<string, unknown> }
  | { kind: "reasoning"; id: string; text: string; metadata?: Record<string, unknown> }
  | { kind: "tool"; id: string };

export class StreamingToolCallAssembler {
  private readonly completedStreamingInputIds = new Set<string>();
  private readonly logger?: Logger;
  private readonly normalizedToolCalls = new Map<string, ModelToolCall>();
  private readonly orderedParts: OrderedAssistantPart[] = [];
  private readonly providerExecutedById = new Map<string, boolean>();
  private readonly reservedToolPartIds = new Set<string>();
  private readonly streamingInputIds = new Set<string>();
  private openReasoningId: string | undefined;
  private openTextId: string | undefined;

  constructor(options: StreamingToolCallAssemblerOptions = {}) {
    this.logger = options.logger;
  }

  snapshotNormalizedToolCalls(): ModelToolCall[] {
    return Array.from(this.normalizedToolCalls.values(), (toolCall) => ({ ...toolCall }));
  }

  /**
   * 有序 assistantContent：text/reasoning/tool_call 按 provider 原始声明顺序，
   * 每个 part 保留自己的 providerOptions（例如 google.thoughtSignature）。
   */
  snapshotAssistantContent(): ModelAssistantContent {
    const blocks: ModelAssistantContent = [];
    for (const part of this.orderedParts) {
      if (part.kind === "tool") {
        const toolCall = this.normalizedToolCalls.get(part.id);
        if (!toolCall) continue;
        blocks.push({
          type: "tool_call",
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
          ...(toolCall.providerExecuted === undefined
            ? {}
            : { providerExecuted: toolCall.providerExecuted }),
          ...(toolCall.providerOptions ? { providerOptions: toolCall.providerOptions } : {}),
        });
        continue;
      }

      const providerOptions =
        part.metadata && Object.keys(part.metadata).length > 0 ? part.metadata : undefined;
      // 空文本只有携带签名等回放元数据时才是有效 part。
      if (part.text.length === 0 && providerOptions === undefined) continue;
      if (part.kind === "text") {
        blocks.push({
          type: "text",
          text: part.text,
          ...(providerOptions ? { providerOptions } : {}),
        });
      } else {
        blocks.push({
          type: "reasoning",
          text: part.text,
          ...(providerOptions ? { providerOptions } : {}),
        });
      }
    }
    return blocks;
  }

  handle(event: ModelStreamEvent): ModelStreamEvent[] {
    switch (event.type) {
      case "tool_input_start":
        this.reserveToolPart(event.id);
        return this.handleToolInputStart(event);
      case "tool_input_delta":
        return this.normalizedToolCalls.has(event.id) ? [] : [event];
      case "tool_input_end":
        return this.handleToolInputEnd(event);
      case "tool_call":
        return this.handleToolCall(event.toolCall);
      case "text_start":
        this.startTextPart(event.id, event.providerMetadata);
        return [event];
      case "text_delta":
        this.appendTextPart(event.id, event.text, event.providerMetadata);
        return [event];
      case "text_end":
        this.endTextPart(event.id, event.providerMetadata);
        return [event];
      case "reasoning_start":
        this.startReasoningPart(event.id, event.providerMetadata);
        return [event];
      case "reasoning_delta":
        this.appendReasoningPart(event.id, event.text, event.providerMetadata);
        return [event];
      case "reasoning_end":
        this.endReasoningPart(event.id, event.providerMetadata);
        return [event];
      case "finish":
        return [...this.flush(), event];
      default:
        return [event];
    }
  }

  flush(): ModelStreamEvent[] {
    this.completedStreamingInputIds.clear();
    this.providerExecutedById.clear();
    this.streamingInputIds.clear();
    return [];
  }

  private handleToolInputStart(
    event: Extract<ModelStreamEvent, { type: "tool_input_start" }>,
  ): ModelStreamEvent[] {
    if (this.normalizedToolCalls.has(event.id)) {
      return [];
    }

    const toolName = normalizeModelToolName(event.toolName, {
      providerExecuted: event.providerExecuted,
      source: "streamText",
      streamEventType: event.type,
      toolCallId: event.id,
    });
    if (event.providerExecuted !== undefined) {
      this.providerExecutedById.set(event.id, event.providerExecuted);
    }
    this.streamingInputIds.add(event.id);
    return [{ ...event, toolName }];
  }

  private handleToolInputEnd(
    event: Extract<ModelStreamEvent, { type: "tool_input_end" }>,
  ): ModelStreamEvent[] {
    if (this.normalizedToolCalls.has(event.id)) {
      return [];
    }
    this.completedStreamingInputIds.add(event.id);
    return [event];
  }

  private handleToolCall(toolCall: ModelToolCall): ModelStreamEvent[] {
    if (this.normalizedToolCalls.has(toolCall.id)) {
      return [];
    }
    if (
      this.streamingInputIds.has(toolCall.id) &&
      !this.completedStreamingInputIds.has(toolCall.id)
    ) {
      // 已经进入流式 input 生命周期时，final call 不能替代缺失的
      // tool-input-end；只移除“首次 JSON 可解析”合成，不改变既有 end gate。
      return [];
    }

    const providerExecuted =
      toolCall.providerExecuted ?? this.providerExecutedById.get(toolCall.id);
    const toolName = normalizeModelToolName(toolCall.name, {
      providerExecuted,
      source: "streamText",
      streamEventType: "tool_call",
      toolCallId: toolCall.id,
    });
    const normalizedToolCall = {
      ...toolCall,
      input: normalizeModelToolInput(toolCall.input, {
        logger: this.logger,
        source: "streamText",
        toolName,
      }),
      name: toolName,
      // 流式 start 可能携带 final call 省略的 provider 执行标记。
      // 这里只补回原有元数据，不改变工具提交、重试或执行语义。
      providerExecuted,
    };
    this.completedStreamingInputIds.delete(toolCall.id);
    this.providerExecutedById.delete(toolCall.id);
    this.streamingInputIds.delete(toolCall.id);
    this.normalizedToolCalls.set(normalizedToolCall.id, normalizedToolCall);
    // tool-input-start 已保留声明位置；final call 只做原位替换，不追加第二个调用。
    this.reserveToolPart(toolCall.id);
    return [{ type: "tool_call", toolCall: normalizedToolCall }];
  }

  private startTextPart(id: string, metadata: Record<string, unknown> | undefined): void {
    if (this.findTextPart(id)) return;
    this.orderedParts.push({
      kind: "text",
      id,
      text: "",
      ...(metadata ? { metadata: mergeProviderMetadata(undefined, metadata) } : {}),
    });
    this.openTextId = id;
  }

  private appendTextPart(
    id: string | undefined,
    text: string,
    metadata: Record<string, unknown> | undefined,
  ): void {
    const part = id === undefined ? this.findTextPart(this.openTextId) : this.findTextPart(id);
    if (!part) {
      // delta 无 id 且没有 open part 时无法确定 part 边界，不能把它们拼进别的签名容器。
      if (id === undefined) return;
      this.orderedParts.push({
        kind: "text",
        id,
        text,
        ...(metadata ? { metadata: mergeProviderMetadata(undefined, metadata) } : {}),
      });
      this.openTextId = id;
      return;
    }
    part.text += text;
    part.metadata = mergeProviderMetadata(part.metadata, metadata);
  }

  private endTextPart(id: string, metadata: Record<string, unknown> | undefined): void {
    const part = this.findTextPart(id);
    if (part) {
      part.metadata = mergeProviderMetadata(part.metadata, metadata);
    }
    if (this.openTextId === id) {
      this.openTextId = undefined;
    }
  }

  private startReasoningPart(id: string, metadata: Record<string, unknown> | undefined): void {
    if (this.findReasoningPart(id)) return;
    this.orderedParts.push({
      kind: "reasoning",
      id,
      text: "",
      ...(metadata ? { metadata: mergeProviderMetadata(undefined, metadata) } : {}),
    });
    this.openReasoningId = id;
  }

  private appendReasoningPart(
    id: string | undefined,
    text: string,
    metadata: Record<string, unknown> | undefined,
  ): void {
    const part =
      id === undefined ? this.findReasoningPart(this.openReasoningId) : this.findReasoningPart(id);
    if (!part) {
      if (id === undefined) return;
      this.orderedParts.push({
        kind: "reasoning",
        id,
        text,
        ...(metadata ? { metadata: mergeProviderMetadata(undefined, metadata) } : {}),
      });
      this.openReasoningId = id;
      return;
    }
    part.text += text;
    part.metadata = mergeProviderMetadata(part.metadata, metadata);
  }

  private endReasoningPart(id: string, metadata: Record<string, unknown> | undefined): void {
    const part = this.findReasoningPart(id);
    if (part) {
      part.metadata = mergeProviderMetadata(part.metadata, metadata);
    }
    if (this.openReasoningId === id) {
      this.openReasoningId = undefined;
    }
  }

  private reserveToolPart(id: string): void {
    if (this.reservedToolPartIds.has(id)) return;
    this.reservedToolPartIds.add(id);
    this.orderedParts.push({ kind: "tool", id });
  }

  private findTextPart(
    id: string | undefined,
  ): Extract<OrderedAssistantPart, { kind: "text" }> | undefined {
    if (id === undefined) return undefined;
    return this.orderedParts.find(
      (part): part is Extract<OrderedAssistantPart, { kind: "text" }> =>
        part.kind === "text" && part.id === id,
    );
  }

  private findReasoningPart(
    id: string | undefined,
  ): Extract<OrderedAssistantPart, { kind: "reasoning" }> | undefined {
    if (id === undefined) return undefined;
    return this.orderedParts.find(
      (part): part is Extract<OrderedAssistantPart, { kind: "reasoning" }> =>
        part.kind === "reasoning" && part.id === id,
    );
  }
}

/**
 * provider namespace 字段增量合并：后到的显式值覆盖同字段，稀疏更新不能擦掉已有签名，
 * 也不能把两次字符串拼接成非法签名。
 */
function mergeProviderMetadata(
  current: Record<string, unknown> | undefined,
  update: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!update) return current;
  const merged: Record<string, unknown> = { ...current };
  for (const [namespace, value] of Object.entries(update)) {
    const existing = plainRecord(merged[namespace]);
    const incoming = plainRecord(value);
    merged[namespace] = existing && incoming ? { ...existing, ...incoming } : value;
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
