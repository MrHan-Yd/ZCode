import type { Model } from "../deps.js";
import type { AgentRuntimeConfig } from "../types.js";

type MidConversationSystemConfig = Pick<AgentRuntimeConfig, "midConversationSystem">;
type MidConversationSystemModel = Pick<Model, "providerKind" | "properties">;

/**
 * 统一解析请求是否可以使用中途 system message。
 *
 * Google 原生协议只接受会话开头的 systemInstruction；中途 system 会让 SDK 抛
 * UnsupportedFunctionalityError。即使配置 force 或模型属性误报，也必须硬约束为
 * false，主请求投影、compact summary 与 microcompact 共用这一判定。
 */
export function resolveUseMidConversationSystem(
  config: MidConversationSystemConfig,
  model: MidConversationSystemModel,
): boolean {
  if (model.providerKind === "google") return false;
  return (
    config.midConversationSystem?.mode === "force" ||
    model.properties.supportsMidConversationSystem
  );
}
