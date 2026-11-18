// ============================================================
// Orchestration Mode Section Builder
// ============================================================
//
// 编排主会话仍然与人对话，所以保留正常 Agent Identity；这里追加一段稳定的
// 「你是调度者」约束，而不是替换整段 system prompt。工具面、团队和计划规则都从
// 运行时配置投影，避免 prompt 与注册表各写一份。

import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

export interface OrchestratorPromptContext {
  team: readonly string[];
  writableRoles: readonly string[];
}

const TOOL_SURFACE = [
  "You have exactly these tools: `CreateOrchestrationPlan`, `AmendOrchestrationPlan`, `CancelOrchestrationRun`, `AskUserQuestion`, `TodoRead`, `TodoWrite`, `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`.",
  "`Edit`, `Write`, `Bash`, `Agent`, `Task`, and `js` are unavailable and rejected by the executor even if you call them. Do not try to work around that boundary.",
].join("\n");

function buildRules(context: OrchestratorPromptContext): string {
  const writable = context.writableRoles.length
    ? context.writableRoles.join(", ")
    : "(none — every step is read-only)";
  return [
    "# Orchestration mode",
    TOOL_SURFACE,
    "",
    `Orchestration team: ${context.team.join(", ")}.`,
    `Writable roles: ${writable}. Every step that uses a writable role must declare \`writeScope\`.`,
    "",
    "## How to work",
    "- Inspect the workspace yourself with the read-only tools first, then express the work as a DAG in `CreateOrchestrationPlan`.",
    "- Every step role must be in the team. A step that uses a role outside the team is rejected; do not silently downgrade it.",
    "- `task` is a self-contained prompt. The child does not see this conversation, so include file paths, constraints, and expected output.",
    "- `dependsOn` is the only ordering mechanism. Steps without a dependency may run in parallel; steps whose `writeScope` overlaps are serialized by the scheduler.",
    "- Downstream steps receive structured summaries and artifact references of their dependencies. Do not paste full prior output into the next task.",
    "- The tool returns `async_launched` immediately. Continue only after the completion notification arrives; then summarize per-step outcomes, artifacts, and any failed or blocked step for the user.",
    "- Use `AmendOrchestrationPlan` when the user changes direction, and `CancelOrchestrationRun` when they ask to stop. Do not guess which one they meant.",
    "- In plan mode the children run read-only. Produce a design or review plan, not an implementation plan.",
    "- Keep one plan in flight per session unless the user explicitly asks for a second; a new run supersedes the previous one.",
  ].join("\n");
}

export function buildOrchestratorSection(context: OrchestratorPromptContext): ContextSection {
  const content = buildRules(context);
  return {
    name: "Orchestration Mode",
    source: "orchestrator",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
