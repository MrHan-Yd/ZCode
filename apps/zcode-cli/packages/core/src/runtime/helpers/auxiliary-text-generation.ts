import {
  projectModelAssistantContent,
  type Model,
  type ModelAssistantContent,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelTextResult,
  type ModelToolCall,
  type ModelUsage,
} from "@zcode/contracts";
import { AssistantContentAccumulator } from "./assistant-content-accumulator.js";
import { normalizeStreamError } from "./model-errors.js";

/**
 * 以流式传输完成一次辅助生成，并组装成与 `generateText` 等价的最终结果。
 *
 * 部分 OpenAI-compatible 端点（含经网关转发到 `api.cline.bot` 的 `cline-pass/*` 模型）
 * 在**非流式**请求里同样返回 SSE `data:` 帧或非 JSON 正文，AI SDK 会按 JSON 解析并抛
 * `AI_APICallError: Invalid JSON response`；该错误没有 HTTP 状态码、也没有 provider 业务码，
 * 归一化后只剩「模型请求失败」，调用方无从补救。辅助生成只要最终文本，不需要非流式传输，
 * 统一走流式即可复用现有 SSE compat。见 specs/auxiliary-text-generation-transport.md。
 *
 * 组装结果不含 `sources` / `toolResults`：`ModelStreamEvent` 不暴露这两个字段。
 * 需要它们的调用点必须先扩展流事件契约，不能靠本 helper 绕开。
 */
export function generateAuxiliaryText(
  model: Model,
  request: ModelRequest,
): Promise<ModelTextResult> {
  return collectAuxiliaryStreamResult(model.streamText(request));
}

/**
 * 消费辅助生成的流事件并组装最终结果。独立出来是为了能不依赖 Model 直接验证组装语义，
 * 也让「消费流拼结果」在全仓只有这一处实现。
 */
export async function collectAuxiliaryStreamResult(
  events: AsyncIterable<ModelStreamEvent>,
): Promise<ModelTextResult> {
  let text = "";
  // 与既有流式消费（WebSearch）一致：没有 finish 事件时按 unknown 收口，不额外抛错。
  let finishReason = "unknown";
  let usage: ModelUsage = {};
  let providerMetadata: Record<string, unknown> | undefined;
  const toolCalls: ModelToolCall[] = [];
  // 与主会话流共用同一 part 边界与元数据合并规则，保证辅助调用也能回放签名。
  const assistantAccumulator = new AssistantContentAccumulator();

  for await (const event of events) {
    switch (event.type) {
      case "text_delta":
        text += event.text;
        assistantAccumulator.handle(event);
        break;

      case "reasoning_start":
      case "reasoning_delta":
      case "reasoning_end":
      case "text_start":
      case "text_end":
        assistantAccumulator.handle(event);
        break;

      case "tool_call":
        toolCalls.push(event.toolCall);
        assistantAccumulator.handle(event);
        break;

      case "finish":
        finishReason = event.finishReason;
        usage = event.usage;
        providerMetadata = event.providerMetadata;
        break;

      case "error":
        throw normalizeStreamError(event.error);
    }
  }

  const assistantContent: ModelAssistantContent = assistantAccumulator.snapshot();
  const projected =
    assistantContent.length > 0 ? projectModelAssistantContent(assistantContent) : undefined;
  // 只保留有正文或回放元数据的段：reasoning_start/end 之间可能只有元数据。
  const reasoning = projected?.reasoning ?? [];

  return {
    finishReason,
    text: projected ? projected.text : text,
    usage,
    ...(assistantContent.length > 0 ? { assistantContent } : {}),
    ...(reasoning.length > 0 ? { reasoning } : {}),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    ...(providerMetadata ? { providerMetadata } : {}),
  };
}
