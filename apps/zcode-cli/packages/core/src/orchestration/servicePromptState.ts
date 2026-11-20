import type { OrchestrationRunRecord } from "./contract.js";
import { summarizeRun } from "./scheduler.js";
import { fitContentWithSuffix } from "../tool/executor/result-content-projection.js";

const PROMPT_STATE_MAX_BYTES = 4 * 1024;

export function describeOrchestrationRun(record: OrchestrationRunRecord): string {
  const summary = summarizeRun(record.state);
  return [
    `run \`${record.runId}\`, plan \`${record.state.plan.planId}\``,
    `revision ${record.state.plan.revision}, generation ${record.state.generation}`,
    `status ${record.status}`,
    `${summary.completed}/${summary.total} completed`,
    ...[
      summary.running ? `${summary.running} running` : "",
      summary.failed ? `${summary.failed} failed` : "",
      summary.blocked ? `${summary.blocked} blocked` : "",
      summary.cancelled ? `${summary.cancelled} cancelled` : "",
      summary.interrupted ? `${summary.interrupted} interrupted` : "",
    ].filter(Boolean),
  ].join(", ");
}

export function boundOrchestrationPromptState(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= PROMPT_STATE_MAX_BYTES) return text;
  return fitContentWithSuffix(
    text,
    PROMPT_STATE_MAX_BYTES,
    "\n[... orchestration run state truncated ...]",
    "head",
  );
}
