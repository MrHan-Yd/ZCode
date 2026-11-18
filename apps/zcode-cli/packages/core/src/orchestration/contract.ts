export type {
  ClaimedOrchestrationAttempt,
  CreateOrchestrationRunInput,
  OrchestrationArtifactReference,
  OrchestrationArtifactsPort,
  OrchestrationArtifactStoragePort,
  OrchestrationArtifactWrite,
  OrchestrationAttemptOutcome,
  OrchestrationAttemptRecord,
  OrchestrationAttemptStatus,
  OrchestrationChildReference,
  OrchestrationEventType,
  OrchestrationJournalPort,
  OrchestrationJournalUpdate,
  OrchestrationRunEvent,
  OrchestrationRunOwner,
  OrchestrationRunRecord,
  OrchestrationRunState,
  OrchestrationRunStatus,
  OrchestrationRunStorePort,
  OrchestrationStepState,
  OrchestrationStepStatus,
} from "@zcode/contracts";
import type { OrchestrationRunRecord } from "@zcode/contracts";
import type { OrchestrationDispatchContext } from "./dispatch-port.js";

export { OrchestrationStoreError } from "@zcode/contracts";

/**
 * 主会话工具面看到的编排用例接口。工具 handler 只依赖这五个方法，
 * 不直接接触 journal / store / dispatcher，也避免 tool 层反向依赖 service 实现。
 */
export interface OrchestrationToolPort {
  start(input: {
    plan: unknown;
    team?: readonly string[];
    maxConcurrency?: number;
    context: OrchestrationDispatchContext;
  }): Promise<OrchestrationRunRecord>;
  amend(input: {
    runId: string;
    plan: unknown;
    team?: readonly string[];
    maxConcurrency?: number;
    context: OrchestrationDispatchContext;
  }): Promise<OrchestrationRunRecord>;
  cancel(runId: string): Promise<OrchestrationRunRecord>;
  get(runId: string): Promise<OrchestrationRunRecord | undefined>;
}
