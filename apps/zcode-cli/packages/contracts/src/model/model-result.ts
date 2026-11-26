import type {
  ModelAssistantContent,
  ModelReasoningContentBlock,
  ModelToolCall,
} from "./message-content.js";
import type { ModelUsage } from "./index.js";

export interface ModelSource {
  type: "source";
  sourceType: "url" | "document";
  id?: string;
  url?: string;
  title?: string;
  mediaType?: string;
  filename?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelToolResult {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  providerExecuted?: boolean;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelTextResult {
  /** assistantContent 存在时为按原序拼接 text part 的派生兼容视图。 */
  text: string;
  finishReason: string;
  usage: ModelUsage;
  /** 完整、原始顺序的 assistant 内容；metadata 属于各 part，不属于聚合 text。 */
  assistantContent?: ModelAssistantContent;
  /** assistantContent 存在时为派生视图，不能独立接受或重建回放事实。 */
  reasoning?: ModelReasoningContentBlock[];
  toolCalls?: ModelToolCall[];
  toolResults?: ModelToolResult[];
  sources?: ModelSource[];
  providerMetadata?: Record<string, unknown>;
}

export type ModelStreamEvent =
  | { type: "start" }
  | {
      /** Compact-only provenance；不携带 provider 正文、不进入 session/UI streaming。 */
      type: "compact_stream_boundary";
      boundary: "provider_response_start" | "inferred_content_block_stop";
    }
  | {
      type: "compact_stream_boundary";
      boundary: "provider_content_block_start";
      blockType: string | null;
      index: number | null;
    }
  | {
      type: "compact_stream_boundary";
      boundary: "provider_content_block_delta";
      deltaType: string | null;
      index: number | null;
    }
  | {
      type: "compact_stream_boundary";
      boundary: "provider_content_block_stop";
      index: number | null;
    }
  | {
      /** 后续 null stop reason 可清除先前状态，沿用既有 Compact 边界语义。 */
      type: "compact_stream_boundary";
      boundary: "provider_stop_reason";
      present: boolean;
    }
  | {
      type: "text_start";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "text_delta";
      id?: string;
      text: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "text_end";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning_start";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning_delta";
      id?: string;
      text: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning_end";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "tool_input_start";
      id: string;
      toolName: string;
      providerExecuted?: boolean;
    }
  | {
      type: "tool_input_delta";
      id: string;
      delta: string;
    }
  | { type: "tool_input_end"; id: string }
  | { type: "tool_call"; toolCall: ModelToolCall }
  | {
      type: "finish";
      finishReason: string;
      providerMetadata?: Record<string, unknown>;
      usage: ModelUsage;
    }
  | { type: "error"; error: unknown };
