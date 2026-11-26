import type { ModelInputMessage } from "./message-content.js";
import type {
  JsonSchema,
  ModelRequestAdmission,
  ModelRequestSessionType,
  ModelRetryBudget,
  ModelStatusSink,
  ModelStreamRecoveryStatus,
  ModelToolChoice,
  ModelToolContract,
} from "./index.js";
import type { TraceContext } from "../tracing/tracer.js";
import type { ModelApiCallObservation } from "../telemetry/index.js";
import { modelInputMessageJsonSchema } from "./message-content-schema.js";

export interface ModelRequestSettings {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
}

export interface ModelTextRequest extends ModelRequestSettings {
  messages: ModelInputMessage[];
  tools?: ModelToolContract[];
  toolChoice?: ModelToolChoice;
  responseJsonSchema?: JsonSchema;
  providerOptions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  /** Runtime-only status hook，不进入 JSON Schema。 */
  statusSink?: ModelStatusSink;
  /** Runtime-only trace；序列化请求通过 metadata 传 trace id。 */
  traceContext?: TraceContext;
  /** Runtime-only 强类型模型调用分类，不进入 Provider 请求。 */
  modelCall?: ModelApiCallObservation;
  /** Runtime-only 宿主 session 分类，静态 headers 不能覆盖受控归因。 */
  modelRequestSessionType?: ModelRequestSessionType;
  /** Runtime-only 重试预算，缺省 default，不进入 Provider 请求或 JSON Schema。 */
  modelRetryBudget?: ModelRetryBudget;
  /** Runtime-only 每次尝试的 admission 端口，结束即 release。 */
  modelRequestAdmission?: ModelRequestAdmission;
  /** Runtime-only SSE idle 重试序号；每次在 adapter base timeout 上增加 30000ms。 */
  streamIdleTimeoutRetryNumber?: number;
  /** Runtime-only recovery attribution，只用于 status/telemetry。 */
  streamRecovery?: ModelStreamRecoveryStatus;
  /** Compact 隐藏流保留真实 provider provenance；工具执行仍等待 SDK final end。 */
  preserveProviderStreamBoundaries?: boolean;
}

export const modelSelectionJsonSchema = {
  type: "object",
  required: ["providerId", "modelId"],
  additionalProperties: false,
  properties: {
    providerId: { type: "string", minLength: 1 },
    modelId: { type: "string", minLength: 1 },
    options: {
      type: "object",
      additionalProperties: false,
      properties: {
        reasoningLevel: { type: "string", minLength: 1 },
        maxOutputTokens: { type: "number", minimum: 1 },
      },
    },
  },
} satisfies JsonSchema;

const modelToolChoiceJsonSchema = {
  oneOf: [
    { enum: ["auto", "none", "required"] },
    {
      type: "object",
      required: ["type", "toolName"],
      additionalProperties: false,
      properties: {
        type: { enum: ["tool"] },
        toolName: { type: "string", minLength: 1 },
      },
    },
  ],
} satisfies JsonSchema;

export const modelTextRequestJsonSchema = {
  type: "object",
  required: ["messages"],
  additionalProperties: false,
  properties: {
    messages: { type: "array", items: modelInputMessageJsonSchema },
    tools: { type: "array" },
    toolChoice: modelToolChoiceJsonSchema,
    temperature: { type: "number" },
    maxOutputTokens: { type: "number" },
    topP: { type: "number" },
    topK: { type: "number" },
    presencePenalty: { type: "number" },
    frequencyPenalty: { type: "number" },
    stopSequences: { type: "array", items: { type: "string" } },
    seed: { type: "number" },
    responseJsonSchema: { type: "object" },
    providerOptions: { type: "object" },
    metadata: { type: "object" },
  },
} satisfies JsonSchema;
