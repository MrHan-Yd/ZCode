import { createHash } from "node:crypto";
import type { OrchestrationStep } from "@zcode/shared";
import { findCurrentOrchestrationAttempt } from "@zcode/contracts";
import { fitContentWithSuffix } from "../tool/executor/result-content-projection.js";
import {
  OrchestrationStoreError,
  type OrchestrationArtifactReference,
  type OrchestrationArtifactStoragePort,
  type OrchestrationArtifactsPort,
  type OrchestrationRunRecord,
} from "./contract.js";

export const ORCHESTRATION_CONTENT_MAX_BYTES = 1024 * 1024;
export const ORCHESTRATION_SUMMARY_MAX_BYTES = 4 * 1024;
export const ORCHESTRATION_INPUT_MAX_BYTES = 16 * 1024;
const TRUNCATED_MARKER = "\n[... orchestration output truncated ...]\n";
const TRUNCATED_MARKER_BYTES = Buffer.byteLength(TRUNCATED_MARKER, "utf8");
const OUTPUT_TAIL_RATIO = 0.3;

export class OrchestrationArtifacts implements OrchestrationArtifactsPort {
  private readonly maxContentBytes: number;
  private readonly maxSummaryBytes: number;

  constructor(
    private readonly options: {
      storage: OrchestrationArtifactStoragePort;
      maxContentBytes?: number;
      maxSummaryBytes?: number;
    },
  ) {
    this.maxContentBytes = byteBudget(options.maxContentBytes ?? ORCHESTRATION_CONTENT_MAX_BYTES);
    this.maxSummaryBytes = byteBudget(options.maxSummaryBytes ?? ORCHESTRATION_SUMMARY_MAX_BYTES);
  }

  async save(attemptKey: string, content: string): Promise<OrchestrationArtifactReference> {
    // 未配对 surrogate 会在 UTF-8 编码时变成同一个替代字符，必须在 hash / 截断前拒绝。
    if (!content.isWellFormed())
      throw new OrchestrationStoreError(
        "artifact_conflict",
        "Orchestration artifact must be valid UTF-8 text.",
      );
    const originalBytes = Buffer.byteLength(content, "utf8");
    const body = boundedOutput(content, this.maxContentBytes);
    const summary = boundedOutput(content, this.maxSummaryBytes);
    return this.options.storage.write({
      attemptKey,
      content: body,
      sourceSha256: sha256(content),
      summary,
      originalBytes,
      savedBytes: Buffer.byteLength(body, "utf8"),
      sha256: sha256(body),
      truncated: originalBytes > this.maxContentBytes,
      summaryTruncated: originalBytes > this.maxSummaryBytes,
    });
  }

  read(reference: OrchestrationArtifactReference): Promise<string> {
    return this.options.storage.read(reference);
  }
}

interface OrchestrationStepInput {
  stepId: string;
  title: string;
  status: string;
  summary?: string;
  artifact?: Pick<
    OrchestrationArtifactReference,
    "artifactId" | "uri" | "sha256" | "originalBytes" | "savedBytes" | "truncated"
  >;
  error?: string;
  summaryTruncated?: boolean;
}

export function buildOrchestrationStepInputs(
  record: OrchestrationRunRecord,
  step: OrchestrationStep,
  options: { maxInputBytes?: number } = {},
): string {
  const maxBytes = byteBudget(options.maxInputBytes ?? ORCHESTRATION_INPUT_MAX_BYTES);
  if (maxBytes < 2) return "";
  const inputIds = Array.isArray(step.inputs) ? step.inputs : step.dependsOn;
  const selected: OrchestrationStepInput[] = [];
  for (const stepId of inputIds) {
    if (!isDependencyAncestor(record, step, stepId)) {
      throw new OrchestrationStoreError(
        "invalid_plan",
        "Orchestration input must refer to a dependency ancestor.",
      );
    }
    const dependency = record.state.plan.steps.find((candidate) => candidate.stepId === stepId);
    const state = record.state.steps[stepId];
    if (
      !dependency ||
      !state ||
      state.status === "pending" ||
      state.status === "running" ||
      state.status === "interrupted"
    ) {
      throw new OrchestrationStoreError(
        "invalid_plan",
        "Orchestration dependency has no confirmed terminal output.",
      );
    }
    // 只读当前工作代的有效 attempt：旧 revision 的失效产物不能伪装成新步骤的输入。
    const attempt = findCurrentOrchestrationAttempt(record, stepId);
    const artifact = attempt?.status === state.status ? attempt.artifact : undefined;
    const entry: OrchestrationStepInput = {
      stepId,
      title: dependency.title,
      status: state.status,
      ...(state.error
        ? { error: boundedOutput(state.error, ORCHESTRATION_SUMMARY_MAX_BYTES) }
        : {}),
      ...(artifact
        ? {
            summary: artifact.summary,
            artifact: {
              artifactId: artifact.artifactId,
              uri: artifact.uri,
              sha256: artifact.sha256,
              originalBytes: artifact.originalBytes,
              savedBytes: artifact.savedBytes,
              truncated: artifact.truncated,
            },
            summaryTruncated: artifact.summaryTruncated,
          }
        : {}),
    };
    const fitted = fitInputEntry(selected, entry, maxBytes);
    if (fitted) selected.push(fitted);
  }
  return JSON.stringify(selected);
}

export function buildOrchestrationStepPrompt(
  record: OrchestrationRunRecord,
  step: OrchestrationStep,
  options: { maxInputBytes?: number } = {},
): string {
  const input = buildOrchestrationStepInputs(record, step, options);
  return [
    step.task,
    ...(step.writeScope?.length ? [`Declared write scope: ${step.writeScope.join(", ")}`] : []),
    ...(step.acceptance ? [`Acceptance criteria:\n${step.acceptance}`] : []),
    `<orchestration-inputs>\n${input}\n</orchestration-inputs>`,
  ].join("\n\n");
}

function fitInputEntry(
  previous: OrchestrationStepInput[],
  entry: OrchestrationStepInput,
  maxBytes: number,
): OrchestrationStepInput | undefined {
  const fits = (value: OrchestrationStepInput) =>
    Buffer.byteLength(JSON.stringify([...previous, value]), "utf8") <= maxBytes;
  if (fits(entry)) return entry;
  const minimal = {
    ...entry,
    ...(entry.summary !== undefined ? { summary: "", summaryTruncated: true } : {}),
    ...(entry.error !== undefined ? { error: "" } : {}),
  };
  if (!fits(minimal)) return undefined;
  const source = entry.summary ?? entry.error ?? "";
  let low = 0;
  let high = Buffer.byteLength(source, "utf8");
  let fitted: OrchestrationStepInput = minimal;
  while (low < high) {
    const budget = Math.ceil((low + high) / 2);
    const text = fitContentWithSuffix(source, budget, "", "head");
    const candidate = {
      ...minimal,
      ...(entry.summary !== undefined ? { summary: text } : { error: text }),
    };
    if (fits(candidate)) {
      low = budget;
      fitted = candidate;
    } else high = budget - 1;
  }
  return fitted;
}

function isDependencyAncestor(
  record: OrchestrationRunRecord,
  step: OrchestrationStep,
  stepId: string,
): boolean {
  const seen = new Set<string>();
  const pending = [...step.dependsOn];
  while (pending.length) {
    const current = pending.pop()!;
    if (current === stepId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(
      ...(record.state.plan.steps.find((candidate) => candidate.stepId === current)?.dependsOn ??
        []),
    );
  }
  return false;
}

function boundedOutput(content: string, maxBytes: number): string {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return content;
  // 小预算不能让固定 marker 吃掉全文；先保字节上限，截断事实仍由引用字段表达。
  if (maxBytes <= TRUNCATED_MARKER_BYTES)
    return fitContentWithSuffix(content, maxBytes, "", "head");
  const contentBudget = maxBytes - TRUNCATED_MARKER_BYTES;
  const tailBudget = Math.floor(contentBudget * OUTPUT_TAIL_RATIO);
  const head = fitContentWithSuffix(content, contentBudget - tailBudget, "", "head");
  const tail = fitContentWithSuffix(content, tailBudget, "", "tail");
  return `${head}${TRUNCATED_MARKER}${tail}`;
}

function byteBudget(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OrchestrationStoreError(
      "invalid_plan",
      "Orchestration byte budget must be a non-negative safe integer.",
    );
  }
  return value;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
