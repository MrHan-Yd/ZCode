import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeConfig } from "../types.js";
import { resolveUseMidConversationSystem } from "./mid-conversation-system-mode.js";
import {
  buildProviderRequestMessages,
  type ProviderRequestMessageProjectionResult,
} from "./provider-request-messages.js";

export function buildRuntimeProviderRequestMessages(
  runtime: { readonly config: Pick<AgentRuntimeConfig, "midConversationSystem"> },
  input: {
    entries: readonly RuntimeMessageEntry[];
    applyCacheControl?: boolean;
    model: Model;
  },
): ProviderRequestMessageProjectionResult {
  // Google 原生协议只接受会话开头的 systemInstruction；中途 system message 会让
  // SDK 抛 UnsupportedFunctionalityError。即使配置 force，也不能越过该协议边界：
  // 继续走提醒投影，而不是制造必败请求（主请求/compact/microcompact 共用判定）。
  const useMidConversationSystem = resolveUseMidConversationSystem(runtime.config, input.model);
  return buildProviderRequestMessages({
    ...input,
    useMidConversationSystem,
  });
}
