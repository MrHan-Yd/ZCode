// MCP 对话引用（@ MCP server capability hint）核心模块出口。
export {
  extractMcpReferences,
  MAX_MCP_REFERENCES_PER_TURN,
  type ExtractMcpReferencesResult,
} from "./references.js";
export {
  buildMcpReferenceReminderBody,
  MAX_MCP_REFERENCE_REMINDER_BYTES,
  MAX_MCP_REFERENCE_SERVERS,
  MAX_MCP_REFERENCE_TOOL_NAMES,
  type BuildMcpReferenceReminderInput,
  type BuildMcpReferenceReminderResult,
  type LiveMcpServerReference,
  type McpReferenceReminderDiagnostics,
  type McpReferenceSkipReason,
} from "./reminder.js";
