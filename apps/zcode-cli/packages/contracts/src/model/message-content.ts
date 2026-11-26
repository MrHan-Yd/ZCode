import type { ModelId, ModelProviderId } from "./index.js";

export type ModelMessageRole = "system" | "user" | "assistant" | "tool";

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
  providerExecuted?: boolean;
  /** 具体调用 part 的回放参数；不能用请求级 metadata 或工具结果 metadata 代替。 */
  providerOptions?: Record<string, unknown>;
}

export type AttachmentKind = "local_file" | "resource" | "inline";

export interface AttachmentRef {
  id: string;
  kind: AttachmentKind;
  uri?: string;
  path?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  placeholder?: string;
}

export interface ModelTextContentBlock {
  type: "text";
  text: string;
  /** 签名属于原始 text part，包括仅携带 metadata 的空 text。 */
  providerOptions?: Record<string, unknown>;
}

export interface ModelReasoningContentBlock {
  type: "reasoning";
  text: string;
  providerOptions?: Record<string, unknown>;
}

/** assistant 有序内容中的工具声明，不扩大 user/tool 媒体输入的内容联合。 */
export interface ModelToolCallContentBlock extends ModelToolCall {
  type: "tool_call";
}

export type ModelAssistantContentBlock =
  | ModelTextContentBlock
  | ModelReasoningContentBlock
  | ModelToolCallContentBlock;

/** provider 原始 part 顺序；不能重排 reasoning/text/tools，也不能过滤空 signed part。 */
export type ModelAssistantContent = ModelAssistantContentBlock[];

export interface ModelImageContentBlock {
  type: "image";
  mediaType: string;
  dataUrl: string;
  detail?: "auto" | "low" | "high" | "original";
  source?: AttachmentRef;
}

export interface ModelFileContentBlock {
  type: "file";
  mediaType: string;
  name?: string;
  uri?: string;
  dataUrl?: string;
  text?: string;
  source?: AttachmentRef;
}

/** 视频输入内容块（provider-neutral，与 image 同构；只承载 base64 dataUrl）。 */
export interface ModelVideoContentBlock {
  type: "video";
  mediaType: string;
  dataUrl: string;
  source?: AttachmentRef;
}

export interface ModelResourceLinkContentBlock {
  type: "resource_link";
  uri: string;
  name?: string;
  title?: string;
}

export type ModelMessageContentBlock =
  | ModelTextContentBlock
  | ModelReasoningContentBlock
  | ModelImageContentBlock
  | ModelVideoContentBlock
  | ModelFileContentBlock
  | ModelResourceLinkContentBlock;

export type ModelMessageContent = string | ModelMessageContentBlock[];

export interface ModelCacheControl {
  type: "ephemeral";
  ttl?: "5m" | "1h";
  scope?: "global" | "org";
}

export interface ModelInputMessage {
  role: ModelMessageRole;
  /** assistantContent 存在时仅为派生兼容视图；旧数据无该字段时沿用原 content。 */
  content: ModelMessageContent;
  /** 仅 assistant role 可携带；存在时是该消息 provider 内容的唯一权威，包括显式空数组。 */
  assistantContent?: ModelAssistantContent;
  cacheControl?: ModelCacheControl;
  /** assistantContent 存在时从其中的 tool_call 派生，不能独立更新。 */
  toolCalls?: ModelToolCall[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  providerId?: ModelProviderId;
  modelId?: ModelId;
}

/**
 * 无状态地派生兼容视图，不修改输入、不缓存、不生成签名。
 * 原因：聚合 text/toolCalls 会丢失签名所在 part 和 interleaving，回放只能读取 assistantContent。
 */
export function projectModelAssistantContent(parts: readonly ModelAssistantContentBlock[]): {
  content: Array<ModelTextContentBlock | ModelReasoningContentBlock>;
  text: string;
  reasoning: ModelReasoningContentBlock[];
  toolCalls: ModelToolCall[];
} {
  const content: Array<ModelTextContentBlock | ModelReasoningContentBlock> = [];
  const reasoning: ModelReasoningContentBlock[] = [];
  const toolCalls: ModelToolCall[] = [];
  let text = "";

  for (const part of parts) {
    switch (part.type) {
      case "text":
        content.push(part);
        text += part.text;
        break;
      case "reasoning":
        content.push(part);
        reasoning.push(part);
        break;
      case "tool_call": {
        const { type: _type, ...toolCall } = part;
        toolCalls.push(toolCall);
        break;
      }
    }
  }

  return { content, text, reasoning, toolCalls };
}

export function modelMessageContentToText(content: ModelMessageContent): string {
  if (typeof content === "string") return content;
  return content.map(modelMessageContentBlockToText).filter(Boolean).join("\n\n");
}

export function modelMessageContentBlockToText(block: ModelMessageContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "reasoning":
      return "";
    case "image":
      return attachmentPlaceholder("Attached", block.mediaType, block.source?.placeholder);
    case "video":
      return attachmentPlaceholder("Attached", block.mediaType, block.source?.placeholder);
    case "file":
      if (block.text !== undefined && block.text.length > 0) return block.text;
      return attachmentPlaceholder(
        "Attached",
        block.mediaType,
        block.name ?? block.source?.placeholder,
      );
    case "resource_link":
      return `[Resource: ${block.title ?? block.name ?? block.uri}]`;
  }
}

function attachmentPlaceholder(prefix: string, mediaType: string, name?: string): string {
  return name && name.length > 0 ? `[${prefix} ${mediaType}: ${name}]` : `[${prefix} ${mediaType}]`;
}
