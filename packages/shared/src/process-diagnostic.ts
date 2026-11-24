import { z } from "zod";

// 启动早期或协议故障时 stdout 尚不可用，进程诊断使用独立的 stderr 单行契约。
export const ZCODE_PROCESS_DIAGNOSTIC_PREFIX = "[zcode-process-exception] ";
export const ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS = 128;
export const ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS = 4_000;
export const ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS = 16_000;
export const ZCODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS = 128 * 1024;
export const ZCODE_AGENT_LIFECYCLE_LOG_MARKER = "[zcode-agent-lifecycle-reported]";

const AGENT_DIAGNOSTIC_AUTH_SCHEME_PATTERN =
  /\b(Bearer|Basic)\s+(?:(?:Bearer|Basic)\s+)*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[A-Za-z0-9._~+/=-]+)/gi;
const AGENT_DIAGNOSTIC_COOKIE_PATTERN =
  /(["']?(?:set-)?cookie["']?\s*[:=]\s*)(?:(["'])(?:\\.|(?!\2)[^\\])*\2|[^\r\n]*)/gi;
const AGENT_DIAGNOSTIC_SENSITIVE_ASSIGNMENT_PATTERN =
  /(["']?(?:api[-_]?key|authorization|cookie|credential|password|secret|token)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}]+)/gi;
const AGENT_DIAGNOSTIC_API_KEY_PATTERN = /\b(sk-)[A-Za-z0-9_-]{16,}\b/gi;

/** Agent 日志与 main 上报共用的纯凭据规则；不改变路径、归因或输出限长。 */
export function redactAgentDiagnosticSecrets(value: string): string {
  return (
    value
      // 修复原因：官方 b95ebaff 先遮 Bearer/Basic；赋值优先会把 scheme 换掉并泄露后面的 token。
      // 连续 scheme 与带引号值整体处理，避免重复遮盖时重新暴露嵌套/转义值的后缀。
      .replace(AGENT_DIAGNOSTIC_AUTH_SCHEME_PATTERN, "$1 <redacted>")
      .replace(AGENT_DIAGNOSTIC_COOKIE_PATTERN, (_match, prefix: string, quote?: string) =>
        quote ? `${prefix}${quote}<redacted>${quote}` : `${prefix}<redacted>`,
      )
      .replace(AGENT_DIAGNOSTIC_SENSITIVE_ASSIGNMENT_PATTERN, (match: string, prefix: string) => {
        // 官方修复保留引号，使 services → main 二次处理幂等，不吞掉同一行后面的错误码。
        const quote = match.charAt(prefix.length);
        return quote === '"' || quote === "'"
          ? `${prefix}${quote}<redacted>${quote}`
          : `${prefix}<redacted>`;
      })
      .replace(AGENT_DIAGNOSTIC_API_KEY_PATTERN, "$1<redacted>")
  );
}

const processErrorKindSchema = z.enum(["uncaughtException", "unhandledRejection"]);
export const zcodeProcessDiagnosticSchema = z
  .object({
    version: z.literal(1),
    errorId: z.uuid(),
    kind: processErrorKindSchema,
    origin: processErrorKindSchema,
    name: z.string().min(1).max(ZCODE_PROCESS_DIAGNOSTIC_NAME_MAX_CHARS),
    message: z.string().max(ZCODE_PROCESS_DIAGNOSTIC_MESSAGE_MAX_CHARS),
    stack: z.string().max(ZCODE_PROCESS_DIAGNOSTIC_STACK_MAX_CHARS).optional(),
    occurredAt: z.number().int().nonnegative(),
  })
  .strict();
export type ZCodeProcessDiagnostic = z.infer<typeof zcodeProcessDiagnosticSchema>;

export function parseZCodeProcessDiagnostic(line: string): ZCodeProcessDiagnostic | undefined {
  if (
    !line.startsWith(ZCODE_PROCESS_DIAGNOSTIC_PREFIX) ||
    line.length > ZCODE_PROCESS_DIAGNOSTIC_MAX_LINE_CHARS
  ) {
    return undefined;
  }
  try {
    const result = zcodeProcessDiagnosticSchema.safeParse(
      JSON.parse(line.slice(ZCODE_PROCESS_DIAGNOSTIC_PREFIX.length)),
    );
    return result.success ? result.data : undefined;
  } catch {
    // 诊断旁路不得因损坏帧中断业务协议或退出处理。
    return undefined;
  }
}
