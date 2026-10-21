import { z } from "zod";
import {
  PROMPT_LIBRARY_LIMITS,
  type PromptLibraryFileV1,
  type PromptTemplate,
  type PromptTemplateInput,
} from "./prompt-library.js";

/**
 * 提示词库 schema（Host 与 UI 共用）。
 *
 * 写入语义：
 * - title/tags/alias 去首尾空白；
 * - content 只做 CRLF → LF 归一，保留首尾空白与换行，不做 trim；
 * - 拒绝 C0 控制字符（`\n`、`\t` 除外），避免 JSON 文件与输入框出现不可见控制序列。
 */
// eslint-disable-next-line no-control-regex -- 控制字符正是要拒绝的对象（与 config-sync / MCP 命名口径一致）
const DISALLOWED_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

export const PROMPT_TEMPLATE_ALIAS_REGEX = /^[a-z0-9_-]{1,24}$/;

function hasNoDisallowedControlCharacters(value: string): boolean {
  return !DISALLOWED_CONTROL_CHARACTERS.test(value);
}

function normalizeContentLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

const promptTemplateTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROMPT_LIBRARY_LIMITS.maxTitleLength)
  .refine(hasNoDisallowedControlCharacters, {
    message: "title must not contain control characters",
  });

const promptTemplateContentSchema = z
  .string()
  .transform(normalizeContentLineEndings)
  .pipe(
    z
      .string()
      .refine((value) => value.trim().length > 0, { message: "content must not be blank" })
      .refine((value) => value.length <= PROMPT_LIBRARY_LIMITS.maxContentLength, {
        message: "content is too long",
      })
      .refine(hasNoDisallowedControlCharacters, {
        message: "content must not contain control characters",
      }),
  );

const promptTemplateTagSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROMPT_LIBRARY_LIMITS.maxTagLength)
  .refine(hasNoDisallowedControlCharacters, {
    message: "tag must not contain control characters",
  });

const promptTemplateTagsSchema = z
  .array(promptTemplateTagSchema)
  .max(PROMPT_LIBRARY_LIMITS.maxTags);

/** 空字符串表示“清除 alias”，因此先归一成 undefined 再走格式校验。 */
const promptTemplateAliasSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim().length === 0 ? undefined : value),
  z
    .string()
    .trim()
    .regex(PROMPT_TEMPLATE_ALIAS_REGEX, {
      message: "alias must match [a-z0-9_-]{1,24}",
    })
    .optional(),
);

export const promptTemplateSchema = z.object({
  id: z.string().min(1),
  title: promptTemplateTitleSchema,
  content: promptTemplateContentSchema,
  tags: promptTemplateTagsSchema,
  alias: promptTemplateAliasSchema.optional(),
  pinned: z.boolean(),
  lastUsedAt: z.number().int().nonnegative().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
});

export const promptLibraryFileV1Schema = z.object({
  version: z.literal(1),
  updatedAt: z.number().int().nonnegative(),
  items: z.array(promptTemplateSchema).max(PROMPT_LIBRARY_LIMITS.maxItems),
});

export const promptTemplateInputSchema = z.object({
  title: promptTemplateTitleSchema,
  content: promptTemplateContentSchema,
  tags: promptTemplateTagsSchema.optional(),
  alias: promptTemplateAliasSchema.optional(),
});

export const promptTemplateUpdateInputSchema = promptTemplateInputSchema.extend({
  id: z.string().trim().min(1),
  expectedUpdatedAt: z.number().int().nonnegative().optional(),
});

export type PromptTemplateSchemaInput = z.input<typeof promptTemplateInputSchema>;
export type PromptTemplateSchemaValue = z.output<typeof promptTemplateInputSchema>;

/**
 * 编译期断言：schema 输出必须与公开类型同构，避免 Host 写入与 UI 消费的字段漂移。
 */
type AssertAssignable<From extends To, To> = From;
export type PromptTemplateSchemaMatchesModel = AssertAssignable<
  z.output<typeof promptTemplateSchema>,
  PromptTemplate
>;
export type PromptTemplateInputSchemaMatchesModel = AssertAssignable<
  z.output<typeof promptTemplateInputSchema>,
  PromptTemplateInput
>;
export type PromptLibraryFileV1SchemaMatchesModel = AssertAssignable<
  z.output<typeof promptLibraryFileV1Schema>,
  PromptLibraryFileV1
>;
