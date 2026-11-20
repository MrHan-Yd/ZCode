import { findCurrentOrchestrationAttempt } from "@zcode/contracts";
import type { OrchestrationRunRecord } from "./contract.js";
import { summarizeRun } from "./scheduler.js";
import { fitContentWithSuffix } from "../tool/executor/result-content-projection.js";

const COMPLETION_NOTICE_MAX_BYTES = 12 * 1024;

export function buildOrchestrationCompletionNotice(record: OrchestrationRunRecord): string {
  const summary = summarizeRun(record.state);
  const lines = [
    `Orchestration run ${record.runId} (plan "${record.state.plan.planId}", revision ${record.state.plan.revision}) finished with status: ${record.status}.`,
    `Steps: ${summary.completed}/${summary.total} completed, ${summary.failed} failed, ${summary.blocked} blocked, ${summary.cancelled} cancelled, ${summary.interrupted} interrupted, ${summary.pending} pending, ${summary.running} running.`,
    "",
  ];
  for (const step of record.state.plan.steps) {
    const state = record.state.steps[step.stepId];
    if (!state) continue;
    const artifact = findCurrentOrchestrationAttempt(record, step.stepId)?.artifact;
    lines.push(
      [
        `- ${step.stepId} (${step.role}, ${step.title}): ${state.status}`,
        state.error ? ` — ${state.error}` : "",
        artifact ? ` - artifact ${artifact.uri}` : "",
      ].join(""),
    );
  }
  lines.push(
    "",
    record.status === "completed"
      ? "Summarize the completed work for the user. Do not re-run finished steps."
      : "Review the failed or blocked steps and decide whether to amend the plan or report the failure. Do not assume output for steps without an artifact.",
  );
  return boundNotice(lines.join("\n"));
}

export function buildOrchestrationFailureNotice(runId: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return boundNotice(
    [
      `Orchestration run ${runId} stopped because the scheduler failed before reaching a terminal record.`,
      message,
      "Treat unfinished steps as interrupted and decide whether to amend the plan.",
    ].join("\n"),
  );
}

function boundNotice(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= COMPLETION_NOTICE_MAX_BYTES) return text;
  // 通知不是产物：截断到 UTF-8 字符边界即可，原文始终可从 run journal / artifact 读取。
  return fitContentWithSuffix(
    text,
    COMPLETION_NOTICE_MAX_BYTES,
    "\n[... orchestration summary truncated ...]",
    "head",
  );
}
