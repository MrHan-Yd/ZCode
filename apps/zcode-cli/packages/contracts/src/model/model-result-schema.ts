import { z } from "zod";
import { toToolJsonSchema } from "../tools/json-schema.js";
import {
  modelAssistantContentSchema,
  modelReasoningContentBlockSchema,
  modelToolCallSchema,
} from "./message-content-schema.js";

const providerRecordSchema = z.record(z.unknown());
// z.unknown() 本身会把缺字段/undefined 当作合法载荷；结果和错误需要明确的可序列化值，null 仍合法。
const requiredPayloadSchema = z.unknown().refine(
  (value): value is NonNullable<unknown> | null => value !== undefined,
  { message: "Model result payload must be present" },
);

export const modelUsageSchema = z
  .object({
    costUsd: z.number().optional(),
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
    cacheReadTokens: z.number().optional(),
    cacheWriteTokens: z.number().optional(),
    reasoningTokens: z.number().optional(),
    serverToolUse: z
      .object({
        webSearchRequests: z.number().optional(),
        webFetchRequests: z.number().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const modelSourceSchema = z
  .object({
    type: z.literal("source"),
    sourceType: z.enum(["url", "document"]),
    id: z.string().optional(),
    url: z.string().optional(),
    title: z.string().optional(),
    mediaType: z.string().optional(),
    filename: z.string().optional(),
    providerMetadata: providerRecordSchema.optional(),
  })
  .strict();

export const modelToolResultSchema = modelToolCallSchema
  .omit({ providerOptions: true })
  .extend({ output: requiredPayloadSchema, providerMetadata: providerRecordSchema.optional() });

export const modelTextResultSchema = z
  .object({
    text: z.string(),
    finishReason: z.string(),
    usage: modelUsageSchema,
    assistantContent: modelAssistantContentSchema.optional(),
    reasoning: z.array(modelReasoningContentBlockSchema).optional(),
    toolCalls: z.array(modelToolCallSchema).optional(),
    toolResults: z.array(modelToolResultSchema).optional(),
    sources: z.array(modelSourceSchema).optional(),
    providerMetadata: providerRecordSchema.optional(),
  })
  .strict();

const textStartSchema = z
  .object({
    type: z.literal("text_start"),
    id: z.string(),
    providerMetadata: providerRecordSchema.optional(),
  })
  .strict();
const textDeltaSchema = z
  .object({
    type: z.literal("text_delta"),
    id: z.string().optional(),
    text: z.string(),
    providerMetadata: providerRecordSchema.optional(),
  })
  .strict();
const textEndSchema = textStartSchema.extend({ type: z.literal("text_end") });
const reasoningStartSchema = textStartSchema.extend({ type: z.literal("reasoning_start") });
const reasoningDeltaSchema = textDeltaSchema.extend({ type: z.literal("reasoning_delta") });
const reasoningEndSchema = textStartSchema.extend({ type: z.literal("reasoning_end") });

const compactStreamBoundarySchema = z.discriminatedUnion("boundary", [
  z
    .object({
      type: z.literal("compact_stream_boundary"),
      boundary: z.literal("provider_response_start"),
    })
    .strict(),
  z
    .object({
      type: z.literal("compact_stream_boundary"),
      boundary: z.literal("inferred_content_block_stop"),
    })
    .strict(),
  z
    .object({
      type: z.literal("compact_stream_boundary"),
      boundary: z.literal("provider_content_block_start"),
      blockType: z.string().nullable(),
      index: z.number().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("compact_stream_boundary"),
      boundary: z.literal("provider_content_block_delta"),
      deltaType: z.string().nullable(),
      index: z.number().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("compact_stream_boundary"),
      boundary: z.literal("provider_content_block_stop"),
      index: z.number().nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("compact_stream_boundary"),
      boundary: z.literal("provider_stop_reason"),
      present: z.boolean(),
    })
    .strict(),
]);

const modelContentStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }).strict(),
  textStartSchema,
  textDeltaSchema,
  textEndSchema,
  reasoningStartSchema,
  reasoningDeltaSchema,
  reasoningEndSchema,
  z
    .object({
      type: z.literal("tool_input_start"),
      id: z.string(),
      toolName: z.string(),
      providerExecuted: z.boolean().optional(),
    })
    .strict(),
  z.object({ type: z.literal("tool_input_delta"), id: z.string(), delta: z.string() }).strict(),
  z.object({ type: z.literal("tool_input_end"), id: z.string() }).strict(),
  z.object({ type: z.literal("tool_call"), toolCall: modelToolCallSchema }).strict(),
  z
    .object({
      type: z.literal("finish"),
      finishReason: z.string(),
      providerMetadata: providerRecordSchema.optional(),
      usage: modelUsageSchema,
    })
    .strict(),
  // 与 tool result 共用必需载荷定义，避免 error 缺失/undefined 在运行时和 JSON Schema 中被当作可选。
  z.object({ type: z.literal("error"), error: requiredPayloadSchema }).strict(),
]);

export const modelStreamEventSchema = z.union([
  modelContentStreamEventSchema,
  compactStreamBoundarySchema,
]);

export const modelTextResultJsonSchema = toToolJsonSchema(modelTextResultSchema);
export const modelStreamEventJsonSchema = toToolJsonSchema(modelStreamEventSchema);
