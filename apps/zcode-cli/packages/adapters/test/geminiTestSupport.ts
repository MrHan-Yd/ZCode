import type { ModelProperties } from "@zcode/contracts";
import type { RegistryProviderConfig } from "@zcode/provider";
import { AiSdkModelExecution } from "../src/model/model-execution.js";
import type { ResolvedAiSdkModel } from "../src/model/runner-runtime.js";
import type { ModelStatusContext } from "../src/model/runner-status.js";

type ProviderFetch = typeof globalThis.fetch;

export const GEMINI_PROVIDER_ID = "google-personal";
export const GEMINI_MODEL_ID = "models/gemini-2.5-flash";
export const GEMINI_DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/";

const GEMINI_REASONING_MAP =
  "{'generationConfig': {'thinkingConfig': {'thinkingBudget': reasoningLevel == 'low' ? 1024 : 8192}}}";
const GEMINI_MAX_OUTPUT_MAP = "{'generationConfig': {'maxOutputTokens': maxOutputTokens}}";

export interface CapturedProviderRequest {
  body: Record<string, unknown> | undefined;
  headers: Record<string, string>;
  method: string;
  signal?: AbortSignal | null;
  url: string;
}

export interface MockTransport {
  fetch: ProviderFetch;
  requests: CapturedProviderRequest[];
}

export function createMockTransport(
  respond: (request: CapturedProviderRequest) => Response | Promise<Response>,
): MockTransport {
  const requests: CapturedProviderRequest[] = [];
  const fetchImpl: ProviderFetch = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : undefined;
    const request: CapturedProviderRequest = {
      body: bodyText === undefined ? undefined : (JSON.parse(bodyText) as Record<string, unknown>),
      headers: Object.fromEntries(headers.entries()),
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      signal: init?.signal,
      url,
    };
    requests.push(request);
    return respond(request);
  };
  return { fetch: fetchImpl, requests };
}

export const GEMINI_PROPERTIES: ModelProperties = {
  contextWindow: 1_000_000,
  inputFormat: {
    supportsAudio: false,
    supportsImage: true,
    supportsPdf: true,
    supportsText: true,
    supportsVideo: true,
  },
  outputFormat: { supportsText: true },
  requiresMfjsToolSchema: false,
  supportsJsonSchemaOutput: true,
  supportsMidConversationSystem: false,
  supportsNativeWebSearch: false,
  supportsToolCall: true,
};

export function createGeminiExecution(input: {
  apiKey?: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  headers?: Record<string, string> | null;
  modelId?: string;
  respond: (request: CapturedProviderRequest) => Response | Promise<Response>;
  supportsJsonSchemaOutput?: boolean;
}): {
  binding: ReturnType<AiSdkModelExecution["bindModel"]>;
  requests: CapturedProviderRequest[];
  resolveRequest: (options?: {
    requestAuth?: { apiKey?: string; headers?: Record<string, string> };
  }) => ResolvedAiSdkModel;
} {
  const transport = createMockTransport(input.respond);
  const execution = new AiSdkModelExecution(
    // 空 env 关闭真实代理/TLS 策略，确保请求只进入 mock transport。
    { defaultHeaders: input.defaultHeaders, env: {} },
    { transport: transport.fetch },
  );
  const binding = execution.bindModel({
    providerId: GEMINI_PROVIDER_ID,
    modelId: input.modelId ?? GEMINI_MODEL_ID,
    providerConfig: {
      api: {
        type: "gemini-generate-content",
        baseUrl: input.baseURL ?? GEMINI_DEFAULT_BASE_URL,
        headers: input.headers ?? null,
      },
      access: { type: "api-key", apiKey: input.apiKey ?? "frozen-key" },
    } as unknown as RegistryProviderConfig,
    supportsJsonSchemaOutput: input.supportsJsonSchemaOutput ?? true,
    optionSpecs: {
      reasoningLevel: { map: GEMINI_REASONING_MAP },
      maxOutputTokens: { map: GEMINI_MAX_OUTPUT_MAP },
    },
  });

  return {
    binding,
    requests: transport.requests,
    resolveRequest: (options = {}) =>
      ({
        ...binding.resolveRequest({
          options: { maxOutputTokens: 2048, reasoningLevel: "low" },
          ...(options.requestAuth ? { requestAuth: options.requestAuth } : {}),
        }),
        properties: GEMINI_PROPERTIES,
      }) as ResolvedAiSdkModel,
  };
}

export function createStatusContext(input: {
  modelId?: string;
  providerId?: string;
  transport?: "http" | "sse";
}): ModelStatusContext {
  return {
    maxAttempts: 1,
    modelCall: {},
    modelId: input.modelId ?? GEMINI_MODEL_ID,
    modelRequestSessionType: "main",
    providerId: input.providerId ?? GEMINI_PROVIDER_ID,
    providerKind: "google",
    requestId: "request-gemini-test",
    traceId: "trace-gemini-test",
    transport: input.transport ?? "http",
  } as unknown as ModelStatusContext;
}

export function geminiJsonResponse(input: {
  content: Record<string, unknown>;
  finishReason?: string;
  usageMetadata?: Record<string, unknown>;
}): Response {
  const body: Record<string, unknown> = {
    candidates: [
      {
        content: input.content,
        ...(input.finishReason ? { finishReason: input.finishReason } : {}),
      },
    ],
  };
  if (input.usageMetadata) body.usageMetadata = input.usageMetadata;
  return jsonResponse(body);
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

export function sseResponse(events: unknown[], options: { status?: number } = {}): Response {
  const payload = events
    .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\r\n\r\n`)
    .join("");
  return new Response(payload, {
    headers: { "content-type": "text/event-stream" },
    status: options.status ?? 200,
  });
}

/**
 * Google native SSE 把每个 chunk 当作新增 part；同一文本需要按 chunk 增量发送，
 * 否则 SDK 会把累计文本再拼一遍。
 */
export function sseTextChunk(text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    candidates: [{ content: { parts: [{ text, ...extra }] } }],
  };
}
