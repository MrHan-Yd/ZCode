import { z } from "zod";
import { toToolJsonSchema } from "../tools/json-schema.js";
import type { ModelInputMessage } from "./message-content.js";

const providerRecordSchema = z.record(z.unknown());
// z.unknown() 默认接受 undefined，会把必需的 tool input 生成为可选字段；显式排除 undefined，保留 null。
const requiredToolInputSchema = z
  .unknown()
  .refine((value): value is NonNullable<unknown> | null => value !== undefined, {
    message: "Tool call input must be present",
  });

export const modelToolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    input: requiredToolInputSchema,
    providerExecuted: z.boolean().optional(),
    providerOptions: providerRecordSchema.optional(),
  })
  .strict();

export const modelTextContentBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
    providerOptions: providerRecordSchema.optional(),
  })
  .strict();

export const modelReasoningContentBlockSchema = z
  .object({
    type: z.literal("reasoning"),
    text: z.string(),
    providerOptions: providerRecordSchema.optional(),
  })
  .strict();

export const modelToolCallContentBlockSchema = modelToolCallSchema.extend({
  type: z.literal("tool_call"),
});

export const modelAssistantContentBlockSchema = z.discriminatedUnion("type", [
  modelTextContentBlockSchema,
  modelReasoningContentBlockSchema,
  modelToolCallContentBlockSchema,
]);
export const modelAssistantContentSchema = z.array(modelAssistantContentBlockSchema);

const attachmentRefSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["local_file", "resource", "inline"]),
    uri: z.string().optional(),
    path: z.string().optional(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().optional(),
    sha256: z.string().optional(),
    placeholder: z.string().optional(),
  })
  .strict();

export const modelMessageContentBlockSchema = z.discriminatedUnion("type", [
  modelTextContentBlockSchema,
  modelReasoningContentBlockSchema,
  z
    .object({
      type: z.literal("image"),
      mediaType: z.string().min(1),
      dataUrl: z.string().min(1),
      detail: z.enum(["auto", "low", "high", "original"]).optional(),
      source: attachmentRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("video"),
      mediaType: z.string().min(1),
      dataUrl: z.string().min(1),
      source: attachmentRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("file"),
      mediaType: z.string().min(1),
      name: z.string().optional(),
      uri: z.string().optional(),
      dataUrl: z.string().optional(),
      text: z.string().optional(),
      source: attachmentRefSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("resource_link"),
      uri: z.string().min(1),
      name: z.string().optional(),
      title: z.string().optional(),
    })
    .strict(),
]);

export const modelMessageContentSchema = z.union([
  z.string(),
  z.array(modelMessageContentBlockSchema),
]);

const modelInputMessageObjectSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: modelMessageContentSchema,
    assistantContent: modelAssistantContentSchema.optional(),
    cacheControl: z
      .object({
        type: z.literal("ephemeral"),
        ttl: z.enum(["5m", "1h"]).optional(),
        scope: z.enum(["global", "org"]).optional(),
      })
      .strict()
      .optional(),
    toolCalls: z.array(modelToolCallSchema).optional(),
    toolCallId: z.string().optional(),
    toolName: z.string().optional(),
    isError: z.boolean().optional(),
    providerId: z
      .string()
      .min(1)
      .transform((value) => value as ModelInputMessage["providerId"])
      .optional(),
    modelId: z
      .string()
      .min(1)
      .transform((value) => value as ModelInputMessage["modelId"])
      .optional(),
  })
  .strict();

// 用结构联合表达 role 约束，避免 refine 仅在 Zod 生效、JSON Schema 却接受非 assistant 的回放内容。
export const modelInputMessageSchema = z.discriminatedUnion("role", [
  modelInputMessageObjectSchema.extend({ role: z.literal("assistant") }),
  modelInputMessageObjectSchema.omit({ assistantContent: true }).extend({
    role: z.enum(["system", "user", "tool"]),
  }),
]);

export const modelToolCallJsonSchema = toToolJsonSchema(modelToolCallSchema);
export const modelTextContentBlockJsonSchema = toToolJsonSchema(modelTextContentBlockSchema);
export const modelReasoningContentBlockJsonSchema = toToolJsonSchema(
  modelReasoningContentBlockSchema,
);
export const modelToolCallContentBlockJsonSchema = toToolJsonSchema(
  modelToolCallContentBlockSchema,
);
export const modelAssistantContentBlockJsonSchema = toToolJsonSchema(
  modelAssistantContentBlockSchema,
);
export const modelAssistantContentJsonSchema = toToolJsonSchema(modelAssistantContentSchema);
export const modelMessageContentBlockJsonSchema = toToolJsonSchema(modelMessageContentBlockSchema);
export const modelMessageContentJsonSchema = toToolJsonSchema(modelMessageContentSchema);
export const modelInputMessageJsonSchema = toToolJsonSchema(modelInputMessageSchema);
