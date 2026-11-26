import type {
  ModelAssistantContent,
  ModelAssistantContentBlock,
  ModelStreamEvent,
  ModelToolCall,
} from "@zcode/contracts";

/** reasoning delta 不带 id 时归并到最近开启的段，与既有 reasoning-stream 语义一致。 */
const DEFAULT_REASONING_STREAM_ID = "\u0000default-reasoning";
const ANONYMOUS_TEXT_PREFIX = "\u0000anonymous-text:";

type OrderedTextPart = {
  kind: "text";
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
};

type OrderedReasoningPart = {
  kind: "reasoning";
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
};

type OrderedToolPart = {
  kind: "tool";
  id: string;
  toolCall: ModelToolCall;
};

type OrderedAssistantPart = OrderedTextPart | OrderedReasoningPart | OrderedToolPart;

/**
 * 按 provider part 边界收集 assistant 内容。
 *
 * 原因：聚合 text/toolCalls 会丢失签名归属和 interleaving；主会话流与辅助生成必须
 * 共用同一套 start/delta/end 合并规则。这里只维护请求内临时顺序，不成为持久化事实。
 */
export class AssistantContentAccumulator {
  private readonly parts: OrderedAssistantPart[] = [];
  private anonymousTextCount = 0;
  private openReasoningId: string | undefined;
  private openTextId: string | undefined;

  handle(event: ModelStreamEvent): void {
    switch (event.type) {
      case "text_start":
        this.startText(event.id, event.providerMetadata);
        return;
      case "text_delta":
        this.appendText(event.id, event.text, event.providerMetadata);
        return;
      case "text_end":
        this.endText(event.id, event.providerMetadata);
        return;
      case "reasoning_start":
        this.startReasoning(event.id, event.providerMetadata);
        return;
      case "reasoning_delta":
        this.appendReasoning(event.id, event.text, event.providerMetadata);
        return;
      case "reasoning_end":
        this.endReasoning(event.id, event.providerMetadata);
        return;
      case "tool_call":
        this.upsertToolCall(event.toolCall);
        return;
      default:
        return;
    }
  }

  /**
   * 下一个 part 在最终 assistantContent 中的位置；append/upsert 前读取。
   *
   * 不能直接返回内部 `parts.length`：snapshot() 会丢弃无签名空 text/reasoning，
   * 而 tool_call 的 providerContentIndex 会和取消/工具终态落盘使用的快照下标混用。
   * 这里按同一保留谓词计数，保证两条写入路径得到同一序号。
   */
  nextContentIndex(): number {
    let index = 0;
    for (const part of this.parts) {
      if (part.kind === "tool") {
        index += 1;
        continue;
      }
      // 与 snapshot() 完全一致的保留条件；空正文只有带 provider 元数据才算有效 part。
      if (part.text.length === 0 && providerOptionsOf(part.metadata) === undefined) continue;
      index += 1;
    }
    return index;
  }

  snapshot(): ModelAssistantContent {
    const content: ModelAssistantContent = [];
    for (const part of this.parts) {
      if (part.kind === "tool") {
        content.push(toolCallBlock(part.toolCall));
        continue;
      }
      const providerOptions = providerOptionsOf(part.metadata);
      // 空正文只有携带签名等回放元数据时才是有效 part。
      if (part.text.length === 0 && providerOptions === undefined) continue;
      content.push({
        type: part.kind,
        text: part.text,
        ...(providerOptions ? { providerOptions } : {}),
      });
    }
    return content;
  }

  private startText(id: string, metadata: Record<string, unknown> | undefined): void {
    if (this.findText(id)) return;
    this.parts.push({
      kind: "text",
      id,
      text: "",
      ...(metadata ? { metadata: cloneMetadata(metadata) } : {}),
    });
    this.openTextId = id;
  }

  private appendText(
    id: string | undefined,
    text: string,
    metadata: Record<string, unknown> | undefined,
  ): void {
    const part = id === undefined ? this.findText(this.openTextId) : this.findText(id);
    if (!part) {
      // 无 id 且没有 open part 时仍要保留正文；用内部匿名 id 固定到达顺序。
      const anonymousId = `${ANONYMOUS_TEXT_PREFIX}${this.anonymousTextCount++}`;
      this.parts.push({
        kind: "text",
        id: anonymousId,
        text,
        ...(metadata ? { metadata: cloneMetadata(metadata) } : {}),
      });
      this.openTextId = anonymousId;
      return;
    }
    part.text += text;
    part.metadata = mergeProviderMetadata(part.metadata, metadata);
  }

  private endText(id: string, metadata: Record<string, unknown> | undefined): void {
    const part = this.findText(id);
    if (part) part.metadata = mergeProviderMetadata(part.metadata, metadata);
    if (this.openTextId === id) this.openTextId = undefined;
  }

  private startReasoning(id: string, metadata: Record<string, unknown> | undefined): void {
    if (this.findReasoning(id)) return;
    this.parts.push({
      kind: "reasoning",
      id,
      text: "",
      ...(metadata ? { metadata: cloneMetadata(metadata) } : {}),
    });
    this.openReasoningId = id;
  }

  private appendReasoning(
    id: string | undefined,
    text: string,
    metadata: Record<string, unknown> | undefined,
  ): void {
    const resolvedId = id ?? this.openReasoningId ?? DEFAULT_REASONING_STREAM_ID;
    let part = this.findReasoning(resolvedId);
    if (!part) {
      // Anthropic-compatible provider 可能不发 reasoning_start；保留该段以便工具轮回放。
      part = {
        kind: "reasoning",
        id: resolvedId,
        text: "",
        ...(metadata ? { metadata: cloneMetadata(metadata) } : {}),
      };
      this.parts.push(part);
      this.openReasoningId = resolvedId;
    }
    part.text += text;
    part.metadata = mergeProviderMetadata(part.metadata, metadata);
  }

  private endReasoning(id: string, metadata: Record<string, unknown> | undefined): void {
    const part = this.findReasoning(id);
    if (part) part.metadata = mergeProviderMetadata(part.metadata, metadata);
    if (this.openReasoningId === id) this.openReasoningId = undefined;
  }

  private upsertToolCall(toolCall: ModelToolCall): void {
    const existing = this.parts.find(
      (part): part is OrderedToolPart => part.kind === "tool" && part.id === toolCall.id,
    );
    if (existing) {
      existing.toolCall = toolCall;
      return;
    }
    this.parts.push({ kind: "tool", id: toolCall.id, toolCall });
  }

  private findText(id: string | undefined): OrderedTextPart | undefined {
    if (id === undefined) return undefined;
    return this.parts.find(
      (part): part is OrderedTextPart => part.kind === "text" && part.id === id,
    );
  }

  private findReasoning(id: string | undefined): OrderedReasoningPart | undefined {
    if (id === undefined) return undefined;
    return this.parts.find(
      (part): part is OrderedReasoningPart => part.kind === "reasoning" && part.id === id,
    );
  }
}

function toolCallBlock(toolCall: ModelToolCall): ModelAssistantContentBlock {
  return {
    type: "tool_call",
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    ...(toolCall.providerExecuted === undefined
      ? {}
      : { providerExecuted: toolCall.providerExecuted }),
    ...(toolCall.providerOptions
      ? { providerOptions: cloneMetadata(toolCall.providerOptions) }
      : {}),
  };
}

function providerOptionsOf(
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  return metadata && Object.keys(metadata).length > 0 ? metadata : undefined;
}

function cloneMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(metadata);
}

/**
 * provider namespace 字段增量合并：后到的显式值覆盖同字段，稀疏更新不能擦掉已有签名，
 * 也不能把两次字符串拼接成非法签名。
 */
export function mergeProviderMetadata(
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
