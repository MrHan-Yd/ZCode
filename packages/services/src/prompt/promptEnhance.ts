import type { ZCodeWorkspaceGenerateTextParams } from "@zcode/shared";
import { ServiceChannels, ZCODE_AGENT_PROVIDER_NOT_READY_CODE } from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import { createServiceDescriptor } from "../descriptors.js";

/** 轨迹面板按这个值显示「提示优化」，改值会丢标签；同时它不会覆盖输入栏 context meter。 */
const PROMPT_ENHANCE_QUERY_SOURCE = "prompt_enhance";
const MAX_DRAFT_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 16_000;
const MAX_OUTPUT_TOKENS = 4_096;
const TRUNCATED_DRAFT_MARKER = "\n...draft truncated...";

export type PromptEnhanceFailureReason =
  | "empty-draft"
  | "model-unavailable"
  | "aborted"
  | "invalid-output"
  | "request-failed";

/**
 * 结果用可序列化的判别联合而不是抛错：renderer 经 ProxyChannel 调用时，抛出的 Error
 * 只会保留 message，reason/detail 这类自定义字段过不了 RPC 边界，调用方就没法区分
 * 「模型没配置」和「请求失败」两种完全不同的提示。异常仍然只在传输层失败时抛出。
 */
export type PromptEnhanceResult =
  | { ok: true; text: string }
  | { ok: false; reason: PromptEnhanceFailureReason; detail?: string };

export interface PromptEnhanceParams {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  selection: ZCodeWorkspaceGenerateTextParams["selection"];
  /** 输入框当前草稿原文。 */
  text: string;
  /**
   * 调用方生成的请求 id，与 cancel(requestId) 配对。
   * 这里刻意不用 AbortSignal：AbortSignal 过不了 @zcode/rpc 的序列化边界
   * （非原始对象走 JSON fallback，signal 会退化成 {}，host 侧再调 addEventListener
   * 就抛 TypeError）。可序列化的 requestId 只在 host 内换成真实 signal。
   */
  requestId: string;
}

/**
 * Renderer 消费这个 host 服务，不直接触达 agent 协议。远端 workspace 由该 workspace 所属的
 * host 实现，模型调用仍在本机 CLI 内完成。
 */
export interface IPromptEnhanceService {
  enhance(params: PromptEnhanceParams): Promise<PromptEnhanceResult>;
  /** 取消在途增强；requestId 未知或已结束时为幂等空操作。 */
  cancel(requestId: string): Promise<void>;
}

export const IPromptEnhanceService = createServiceDescriptor<IPromptEnhanceService>(
  ServiceChannels.PromptEnhance,
);

interface PromptEnhanceTextGenerator {
  generateText(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    selection: ZCodeWorkspaceGenerateTextParams["selection"];
    messages: Array<{ role: "system" | "user"; content: string }>;
    querySource: string;
    maxOutputTokens?: number;
    signal?: AbortSignal;
  }): Promise<{ text: string }>;
}

export function createPromptEnhanceService(options: {
  textGenerator: PromptEnhanceTextGenerator;
  logger?: ServiceLogger;
}): IPromptEnhanceService {
  // 「这次增强还能不能被取消」的唯一事实源：requestId → 本次生成的 AbortController。
  // 真实 AbortSignal 只在这里创建并直接交给同进程的 textGenerator，不过 RPC 边界。
  const inFlight = new Map<string, AbortController>();

  return {
    async enhance(params: PromptEnhanceParams): Promise<PromptEnhanceResult> {
      const requestId = params.requestId?.trim() ?? "";
      const draft = normalizeDraft(params.text);
      if (!draft) {
        return { ok: false, reason: "empty-draft" };
      }

      const providerId = params.selection?.providerId?.trim() ?? "";
      const modelId = params.selection?.modelId?.trim() ?? "";
      if (!providerId || !modelId) {
        return { ok: false, reason: "model-unavailable" };
      }
      const selection = {
        providerId,
        modelId,
        ...(params.selection.options ? { options: { ...params.selection.options } } : {}),
      };

      const controller = new AbortController();
      // 调用方复用同一 requestId 时按「新请求替换旧请求」处理：先中止旧的再接管，
      // 否则旧 controller 会永久留在在途表里，那次生成也再无法取消。
      inFlight.get(requestId)?.abort();
      inFlight.set(requestId, controller);

      options.logger?.info(undefined, "开始增强提示词", {
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        providerId,
        model: modelId,
        draftChars: draft.length,
        requestId,
      });

      let raw: string;
      try {
        const result = await options.textGenerator.generateText({
          workspacePath: params.workspacePath,
          ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
          ...(params.remoteSessionId ? { remoteSessionId: params.remoteSessionId } : {}),
          selection,
          messages: buildPromptEnhanceMessages(draft),
          querySource: PROMPT_ENHANCE_QUERY_SOURCE,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          signal: controller.signal,
        });
        raw = result.text;
      } catch (error) {
        if (controller.signal.aborted) {
          return { ok: false, reason: "aborted" };
        }
        // provider 未就绪在 UI 上和「模型没配置」是同一个处置：让用户先去配模型，
        // 因此合并成同一个 reason，避免 UI 再维护第二套分支。
        if (readErrorCode(error) === ZCODE_AGENT_PROVIDER_NOT_READY_CODE) {
          return { ok: false, reason: "model-unavailable" };
        }
        const detail = error instanceof Error ? error.message : String(error);
        options.logger?.warn(undefined, "提示词增强请求失败", {
          workspacePath: params.workspacePath,
          providerId,
          model: modelId,
          detail,
        });
        return { ok: false, reason: "request-failed", detail };
      } finally {
        // 只清理仍属于本次 controller 的条目：同 id 新请求接管后不能误删新的在途记录。
        if (inFlight.get(requestId) === controller) {
          inFlight.delete(requestId);
        }
      }

      const text = sanitizeEnhancedPrompt(raw);
      if (!text) {
        // 模型可能只回了解释或空串；空结果不能让 UI 清空用户草稿。
        return { ok: false, reason: "invalid-output" };
      }
      return { ok: true, text };
    },

    async cancel(requestId: string): Promise<void> {
      // 未知 id、已结束的 id、重复调用都是空操作：AbortController.abort() 本身幂等，
      // 在途条目的删除始终由 enhance 的 finally 负责，这里不改变表的归属。
      inFlight.get(requestId?.trim() ?? "")?.abort();
    },
  };
}

function readErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : "";
}

function normalizeDraft(value: string): string {
  const normalized = value.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length <= MAX_DRAFT_CHARS) {
    return normalized;
  }
  return `${normalized
    .slice(0, MAX_DRAFT_CHARS - TRUNCATED_DRAFT_MARKER.length)
    .trimEnd()}${TRUNCATED_DRAFT_MARKER}`;
}

/**
 * 用 system + user 两条消息表达约束，而不是把规则塞进一条 user prompt：
 * 这条通道没有默认系统提示词（workspace-generate-text 只透传调用方给的 messages），
 * 约束必须显式携带，否则模型容易把「润色指令」当成任务本身去执行。
 */
function buildPromptEnhanceMessages(
  draft: string,
): Array<{ role: "system" | "user"; content: string }> {
  return [
    {
      role: "system",
      content: [
        "You rewrite a developer's draft prompt for an AI coding agent so it becomes clearer, more complete and directly actionable.",
        "",
        "Rules:",
        "- Return only the rewritten prompt text.",
        "- Keep the author's language, intent and technical terms; never translate.",
        "- Never answer, execute or comment on the prompt itself.",
        "- Do not add explanations, titles or code fences.",
        "- Preserve file paths, shell commands, code identifiers and @mentions exactly as written.",
        "- Keep every concrete requirement the author already stated; add only what they imply.",
        "- If the draft is already clear, return it with minimal edits.",
      ].join("\n"),
    },
    {
      role: "user",
      content: ["Rewrite the draft prompt below.", "", "<draft>", draft, "</draft>"].join("\n"),
    },
  ];
}

function sanitizeEnhancedPrompt(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  // 模型偶尔会把结果整体包进围栏或引号，这两类是确定性装饰，剥掉后仍是原文；
  // 「以下为改写结果」这类前缀无法可靠识别，不做猜测性裁剪。
  const fenced = /^```(?:[a-zA-Z0-9_-]+)?\s*\n?([\s\S]*?)\n?```$/u.exec(trimmed);
  const withoutFence = (fenced?.[1] ?? trimmed).trim();
  return stripWrappingQuotes(withoutFence).slice(0, MAX_OUTPUT_CHARS).trim();
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1).trim();
  }
  return value;
}
