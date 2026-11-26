import type { AgentColor, AgentPermissionMode, BuiltInSubagentName } from "./subagents-types.js";

/**
 * 内置子智能体目录。
 *
 * `description` 用于设置页与编排团队选择器；`agentDescription` 用于 Agent 工具暴露给
 * 模型的描述。两者分开是为了保持经典模式下 general-purpose / Explore 的提示词原文不变，
 * 同时让设置页继续使用较短的说明。
 *
 * 这里只放跨 services / CLI / UI 共享的纯元数据；system prompt 在 CLI core 维护，
 * 因为它是运行时实现细节，不属于展示契约。
 */
export interface BuiltInSubagentDefinition {
  name: BuiltInSubagentName;
  description: string;
  agentDescription?: string;
  color: AgentColor;
  /** 该角色是否允许写文件；只用于展示与团队选择提示，真正的工具边界由 tools/permissionMode 决定。 */
  canWrite: boolean;
  tools: readonly string[];
  disallowedTools?: readonly string[];
  permissionMode?: AgentPermissionMode;
  maxTurns?: number;
  injectAgentsMd?: boolean;
  /** 选择器筛选用标签，不进入 AgentSummary / Markdown schema。 */
  tags: readonly string[];
}

const GENERAL_PURPOSE_AGENT_DESCRIPTION =
  "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. When you are searching for a keyword or file and are not confident that you will find the right match in the first few tries use this agent to perform the search for you.";

const EXPLORE_AGENT_DESCRIPTION =
  'Read-only search agent for broad fan-out searches - when answering means sweeping many files, directories, or naming conventions and you only need the conclusion, not the file dumps. It reads excerpts rather than whole files, so it locates code; it doesn\'t review or audit it. Specify search breadth: "medium" for moderate exploration, "very thorough" for multiple locations and naming conventions.';

const BUG_FIXER_AGENT_DESCRIPTION =
  "Bug-fixing agent for regressions, failing tests, runtime errors, and review findings that need code changes. It reproduces the failure first, fixes the root cause at the owning layer, adds regression coverage, and reports the commands it ran. Prefer this over general-purpose for a known defect that needs a verified fix.";

export const BUILT_IN_SUBAGENT_DEFINITIONS: readonly BuiltInSubagentDefinition[] = [
  {
    name: "general-purpose",
    description:
      "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
    agentDescription: GENERAL_PURPOSE_AGENT_DESCRIPTION,
    color: "blue",
    canWrite: true,
    tools: ["*"],
    injectAgentsMd: true,
    tags: ["通用", "执行"],
  },
  {
    name: "Explore",
    description: "Read-only search agent for broad fan-out searches.",
    agentDescription: EXPLORE_AGENT_DESCRIPTION,
    color: "cyan",
    canWrite: false,
    tools: ["Bash", "Glob", "Grep", "Read", "WebFetch", "WebSearch", "TodoWrite"],
    injectAgentsMd: false,
    tags: ["检索", "只读"],
  },
  {
    name: "architect",
    description:
      "Architecture agent for module boundaries, interface contracts, dependency direction, and migration plans.",
    color: "purple",
    canWrite: false,
    tools: [
      "Read",
      "Glob",
      "Grep",
      "Bash",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
      "Skill",
    ],
    permissionMode: "plan",
    maxTurns: 15,
    injectAgentsMd: true,
    tags: ["架构", "API", "DDD", "迁移"],
  },
  {
    name: "frontend",
    description:
      "Frontend implementation agent for web, desktop, mobile, and mini-program UIs. Detects the existing stack and follows repo conventions.",
    color: "teal",
    canWrite: true,
    tools: ["*"],
    maxTurns: 30,
    injectAgentsMd: true,
    tags: [
      "Web",
      "React",
      "Vue",
      "Svelte",
      "Angular",
      "Next",
      "Nuxt",
      "React Native",
      "Flutter",
      "Electron",
      "Tauri",
      "小程序",
    ],
  },
  {
    name: "backend",
    description:
      "Backend implementation agent for APIs, services, persistence, and concurrency. Detects the existing stack and follows repo conventions.",
    color: "green",
    canWrite: true,
    tools: ["*"],
    maxTurns: 30,
    injectAgentsMd: true,
    tags: [
      "Node",
      "TypeScript",
      "Python",
      "Java",
      "Kotlin",
      "Go",
      "Rust",
      "C#",
      "PHP",
      "SQL",
    ],
  },
  {
    name: "ui-designer",
    description:
      "UI/UX design agent for layout, design tokens, states, responsive behavior, and accessibility. Read-only; returns a design spec for frontend implementation.",
    color: "pink",
    canWrite: false,
    tools: ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Skill"],
    permissionMode: "plan",
    maxTurns: 15,
    injectAgentsMd: true,
    tags: ["Design", "A11y", "Responsive", "Design Token"],
  },
  {
    name: "tester",
    description:
      "Testing agent for unit, integration, end-to-end, contract, and performance tests. Writes tests only and reuses the repo's existing test stack.",
    color: "orange",
    canWrite: true,
    tools: ["*"],
    maxTurns: 40,
    injectAgentsMd: true,
    tags: ["单测", "集成", "E2E", "契约", "性能"],
  },
  {
    name: "reviewer",
    description:
      "Read-only review agent for correctness, security, compatibility, performance, and maintainability. Returns severity-ranked findings with file references.",
    color: "red",
    canWrite: false,
    tools: [
      "Read",
      "Glob",
      "Grep",
      "Bash",
      "WebFetch",
      "WebSearch",
      "TodoWrite",
      "Skill",
    ],
    permissionMode: "plan",
    maxTurns: 15,
    injectAgentsMd: true,
    tags: ["安全", "性能", "逻辑", "兼容"],
  },
  {
    name: "bug-fixer",
    description:
      "Bug-fix agent for reproducing failures, finding root causes, applying minimal fixes, and adding regression coverage.",
    agentDescription: BUG_FIXER_AGENT_DESCRIPTION,
    color: "yellow",
    canWrite: true,
    tools: ["*"],
    maxTurns: 40,
    injectAgentsMd: true,
    tags: ["Bug", "修复", "根因", "回归"],
  },
];

export function getBuiltInSubagentDefinition(
  name: string,
): BuiltInSubagentDefinition | undefined {
  return BUILT_IN_SUBAGENT_DEFINITIONS.find((definition) => definition.name === name);
}
