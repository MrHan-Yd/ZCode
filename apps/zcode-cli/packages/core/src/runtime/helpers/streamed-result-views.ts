import { projectModelAssistantContent } from "@zcode/contracts";
import type {
  ModelAssistantContent,
  ModelReasoningContentBlock,
  ModelToolCall,
} from "@zcode/contracts";

export interface StreamedModelResultViews {
  readonly reasoning: ModelReasoningContentBlock[] | undefined;
  readonly text: string;
  readonly toolCalls: ModelToolCall[] | undefined;
}

/**
 * 流式模型结果的兼容视图优先级。
 *
 * Bug 原因：Gemini 的 thoughtSignature 要求以有序 assistantContent 为权威，
 * 但把该视图无条件套到所有 provider 后，非 Gemini 分支不再产出聚合数组，
 * toolCalls 退化为 undefined，turn-model-step 收不到任何工具调用就直接结束
 * turn，UI 再把未终态的工具行收口成 “Tool call ended without a terminal
 * event”。这里把“有序视图优先、否则回退到流内聚合视图”固定为唯一规则：
 * 只有持有有序 part 的 provider（Gemini）读取有序视图，其余格式继续用聚合视图。
 *
 * 空数组按“未提供”处理：Gemini 空快照时聚合视图同样为空，两种语义等价；
 * 调用点只在有序内容非空时传入，避免把空数组误当权威空内容。
 */
export function resolveStreamedModelResultViews(input: {
  orderedAssistantContent?: ModelAssistantContent;
  aggregatedText: string;
  aggregatedReasoning: readonly ModelReasoningContentBlock[];
  aggregatedToolCalls: readonly ModelToolCall[];
}): StreamedModelResultViews {
  const ordered = input.orderedAssistantContent;
  if (ordered !== undefined && ordered.length > 0) {
    const projected = projectModelAssistantContent(ordered);
    return {
      reasoning: projected.reasoning.length > 0 ? projected.reasoning : undefined,
      text: projected.text,
      toolCalls: projected.toolCalls.length > 0 ? projected.toolCalls : undefined,
    };
  }

  return {
    reasoning: input.aggregatedReasoning.length > 0 ? [...input.aggregatedReasoning] : undefined,
    text: input.aggregatedText,
    toolCalls: input.aggregatedToolCalls.length > 0 ? [...input.aggregatedToolCalls] : undefined,
  };
}
