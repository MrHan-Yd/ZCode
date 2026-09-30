// mcp_reference reminder 的 turn-start 注入。
// 契约：解析 canonical text → 与 live MCP inventory 取交集 → 生成本轮 model-only reminder。
// 失败语义：对话 fail open（任何异常都不阻塞本轮），能力注入 fail closed（异常时不注入）。
// 引用绝不触发 connect/reconnect/OAuth——只读取现状。
import { toMcpToolName } from "../../mcp/index.js";
import {
  buildMcpReferenceReminderBody,
  extractMcpReferences,
  type LiveMcpServerReference,
} from "../../mcp-reference/index.js";
import { traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

async function collectLiveMcpServers(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext,
  toolDisallowlist: readonly string[] | undefined,
): Promise<LiveMcpServerReference[]> {
  if (!runtime.mcpPort) return [];
  // initializeMcp 幂等；turn loop 的首个 provider 请求前本来就会等它，
  // 这里提前 await 不增加额外等待。
  await runtime.initializeMcp(traceContext);
  const statuses = await runtime.mcpPort.status();
  const snapshot = runtime.mcpStartupPromise ? await runtime.mcpStartupPromise : undefined;
  const registeredToolNames = new Set(runtime.getTools().map((tool) => tool.name));
  // 与 turn-loop 的 provider 工具过滤保持完全相同的“完整工具名”语义；
  // reminder 里给出的必须是模型真能调用的名字，因此用 toMcpToolName 的 provider 形态。
  const turnDisallowedToolNames = new Set(toolDisallowlist ?? []);
  const toolNamesByServer = new Map<string, string[]>();
  for (const descriptor of snapshot?.tools ?? []) {
    const toolName = toMcpToolName(descriptor);
    if (!registeredToolNames.has(toolName)) continue;
    if (turnDisallowedToolNames.has(toolName)) continue;
    // tool → server 归属只认 descriptor.serverName；不解析 `mcp__` 前缀
    // （sanitize 有损，`plugin:foo:bar` 会变成 `plugin_foo_bar`）。
    const existing = toolNamesByServer.get(descriptor.serverName);
    if (existing) {
      existing.push(toolName);
    } else {
      toolNamesByServer.set(descriptor.serverName, [toolName]);
    }
  }

  return Object.entries(statuses).map(([serverName, status]) => ({
    serverName,
    transport: status.transport,
    connected: status.status === "connected",
    providerVisibleToolNames: toolNamesByServer.get(serverName) ?? [],
  }));
}

export async function injectMcpReferenceReminderFromTurn(
  this: AgentRuntimeInternal,
  userInput: string,
  traceContext: TraceContext,
  toolDisallowlist?: readonly string[],
): Promise<void> {
  // 无引用是绝对主路径：不 touch MCP，零开销返回。
  const extraction = extractMcpReferences(userInput);
  if (extraction.references.length === 0) {
    if (extraction.invalidCount > 0) {
      this.logger?.debug("MCP reference parse rejected invalid destinations", {
        ...traceContextToLogContext(traceContext),
        event: "mcp_reference.parse.invalid",
        invalidCount: extraction.invalidCount,
        module: "core.runtime",
      });
    }
    return;
  }

  const startedAt = Date.now();
  try {
    const liveServers = await collectLiveMcpServers(this, traceContext, toolDisallowlist);
    const result = buildMcpReferenceReminderBody({
      references: extraction.references,
      liveServers,
    });
    // 每轮与消息流同数量级 → 必须 debug（生产 no-op），只输出受控标识与计数。
    this.logger?.debug("MCP reference reminder resolved", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      event: "mcp_reference.reminder.resolved",
      invalidCount: extraction.invalidCount,
      module: "core.runtime",
      referenceCount: extraction.references.length,
      resolvedServerNames: result.diagnostics.resolvedServerNames,
      skipped: result.diagnostics.skipped,
      toolCount: result.diagnostics.toolCount,
      truncated: result.diagnostics.truncated || extraction.truncatedCount > 0,
    });
    if (!result.body) return;
    // 请求级附件：与 `referenced_session_context` 一样不落盘。MCP 能力随时可从工具列表
    // 重新得到，不需要像 plugin_reference 那样固化成 model-only notice。
    this.messageHistory.addAttachment("mcp_reference", result.body);
  } catch (error) {
    // 对话 fail open：reminder 生成失败不影响本轮发送；能力注入 fail closed：不写任何兜底内容。
    this.logger?.debug("MCP reference reminder generation failed", {
      ...traceContextToLogContext(traceContext),
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
      event: "mcp_reference.reminder.failed",
      module: "core.runtime",
      referenceCount: extraction.references.length,
    });
  }
}
