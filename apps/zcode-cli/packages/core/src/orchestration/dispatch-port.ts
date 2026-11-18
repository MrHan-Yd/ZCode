import type { Model, SessionId, SubagentRunRequest, TraceContext, TurnId } from "@zcode/contracts";
import type {
  ClaimedOrchestrationAttempt,
  OrchestrationChildReference,
  OrchestrationRunRecord,
} from "./contract.js";

export interface OrchestrationDispatchContext {
  sessionId: SessionId;
  turnId?: TurnId;
  trace: TraceContext;
  model?: Model;
  /** 由父 session 的不可变配置提供；子代理不继承编排角色。 */
  workingDirectory: string;
  workspaceRoot: string;
}

export type OrchestrationDispatchResult =
  | { status: "completed"; content: string }
  | { status: "failed" | "cancelled" | "interrupted"; error: string };

export interface OrchestrationDispatchHandle {
  child: OrchestrationChildReference;
  wait(): Promise<OrchestrationDispatchResult>;
  stop(): Promise<void>;
}

export interface OrchestrationDispatchPort {
  start(input: {
    record: OrchestrationRunRecord;
    claim: ClaimedOrchestrationAttempt;
    prompt: string;
    context: OrchestrationDispatchContext;
    signal: AbortSignal;
  }): Promise<OrchestrationDispatchHandle>;
}

export function orchestrationSubagentRequest(
  input: Parameters<OrchestrationDispatchPort["start"]>[0],
): SubagentRunRequest {
  return {
    sessionId: input.context.sessionId,
    ...(input.context.turnId ? { turnId: input.context.turnId } : {}),
    parentToolCallId: input.claim.attempt.key,
    agentType: input.claim.step.role,
    description: input.claim.step.title,
    prompt: input.prompt,
    workingDirectory: input.context.workingDirectory,
    workspaceRoot: input.context.workspaceRoot,
    trace: input.context.trace,
  };
}
