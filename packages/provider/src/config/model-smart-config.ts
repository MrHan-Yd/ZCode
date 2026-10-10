import { z } from "zod";
import { modelConfigDataSchema } from "@zcode/shared/model-config";
import { ModelConfig, ModelConfigRules, type ModelConfigRule } from "./model-config.js";
import {
  modelApiMatchConfigRuleSchema,
  modelMatchConfigRuleSchema,
  providerModelConfigRuleSchema,
  providerSiteMatchConfigRuleSchema,
  templateModelConfigRuleSchema,
} from "./rule-data-schema.js";
import { parseZCodeBuiltinModelConfigRules } from "./schema.js";

const idSchema = z.string().min(1);
const patternSchema = z
  .string()
  .min(1)
  .refine((pattern) => {
    try {
      new RegExp(`^(?:${pattern})$`);
      return true;
    } catch {
      return false;
    }
  }, "无效匹配正则");
const reasoningLevelsSchema = z
  .array(z.string().refine((value) => value.trim().length > 0, "档位名不能为空"))
  .min(1, "reasoningLevels 不能为空")
  .refine((values) => new Set(values).size === values.length, "reasoningLevels 不能重复");

/**
 * 面向手工维护的扁平规则。每条写 `modelMatch`（正则）或 `providerId` + `modelId`（精确）二选一，
 * 其余为可选的模型参数；未写字段保持稀疏，解析时继续继承内置默认。
 */
export const modelSmartConfigEntrySchema = z
  .object({
    /** 三选一选择器：正则 `modelMatch`、精确 `providerId`+`modelId`、或模板精确 `templateId`+`modelId`。 */
    modelMatch: patternSchema.optional(),
    apiTypeMatch: patternSchema.optional(),
    baseUrlMatch: patternSchema.optional(),
    providerId: idSchema.optional(),
    templateId: idSchema.optional(),
    modelId: idSchema.optional(),
    enabled: z.boolean().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    /** 推理档位映射（`optionSpecs.reasoningLevel.map` 的原始字符串）。 */
    reasoningLevelMap: z.string().optional(),
    /** 最大输出映射（`optionSpecs.maxOutputTokens.map` 的原始字符串）。 */
    maxOutputTokensMap: z.string().optional(),
    reasoningLevels: reasoningLevelsSchema.optional(),
    supportsText: z.boolean().optional(),
    supportsImage: z.boolean().optional(),
    supportsVideo: z.boolean().optional(),
    supportsAudio: z.boolean().optional(),
    supportsPdf: z.boolean().optional(),
    supportsToolCall: z.boolean().optional(),
    supportsJsonSchemaOutput: z.boolean().optional(),
    supportsNativeWebSearch: z.boolean().optional(),
    supportsMidConversationSystem: z.boolean().optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    const selectorCount = [entry.modelMatch, entry.providerId, entry.templateId].filter(
      (value) => value !== undefined,
    ).length;
    if (selectorCount !== 1) {
      context.addIssue({
        code: "custom",
        message: "必须且只能提供 modelMatch / providerId / templateId 之一",
      });
      return;
    }
    if (entry.modelMatch !== undefined) {
      if (entry.modelId !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["modelId"],
          message: "modelMatch 规则不能带 modelId",
        });
      }
      return;
    }
    if (entry.modelId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["modelId"],
        message: "精确规则必须同时提供 modelId",
      });
    }
  });

/**
 * 与内置 release `modelConfigRules` 同形的原样通道：用于把内置（或任意来源的）智能配置整份镜像进来，
 * 不丢 `map` / `apiTypeMatch` / `baseUrlMatch` / `templateId` 等字段。各数组缺省为空。
 */
const verbatimModelConfigRulesSchema = z
  .object({
    modelRules: z.array(modelMatchConfigRuleSchema).default([]),
    modelApiRules: z.array(modelApiMatchConfigRuleSchema).default([]),
    providerSiteRules: z.array(providerSiteMatchConfigRuleSchema).default([]),
    templateModelRules: z.array(templateModelConfigRuleSchema).default([]),
    builtinProviderModelRules: z.array(providerModelConfigRuleSchema).default([]),
  })
  .strict();

export const modelSmartConfigFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative().optional(),
    /** 手工添加用的扁平规则；在同名匹配上与 `modelConfigRules` 冲突时以本数组为准。 */
    models: z.array(modelSmartConfigEntrySchema).default([]),
    /** 原样镜像的内置 `modelConfigRules`；去掉本字段即只用手工扁平规则。 */
    modelConfigRules: verbatimModelConfigRulesSchema.optional(),
  })
  .strict();

export type ModelSmartConfigEntry = z.infer<typeof modelSmartConfigEntrySchema>;
export type ModelSmartConfigFile = z.infer<typeof modelSmartConfigFileSchema>;

/**
 * 远端清单：把模型配置按厂商拆成多个文件时，用入口文件列出分片。
 * `files` 的顺序即合并顺序（同类别数组按此顺序拼接，后者覆盖前者）。
 */
export const modelSmartConfigManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative().optional(),
    files: z.array(z.string().min(1)).min(1),
  })
  .strict();

export type ModelSmartConfigManifest = z.infer<typeof modelSmartConfigManifestSchema>;

/** 把多个分片合并成单份文件；五类规则数组按分片顺序拼接，`models` 同理。 */
export function mergeModelSmartConfigFiles(
  files: readonly ModelSmartConfigFile[],
): ModelSmartConfigFile {
  const concat = <T>(pick: (file: ModelSmartConfigFile) => readonly T[]): T[] =>
    files.flatMap((file) => [...pick(file)]);
  return {
    schemaVersion: 1,
    models: concat((file) => file.models),
    modelConfigRules: {
      modelRules: concat((file) => file.modelConfigRules?.modelRules ?? []),
      modelApiRules: concat((file) => file.modelConfigRules?.modelApiRules ?? []),
      providerSiteRules: concat((file) => file.modelConfigRules?.providerSiteRules ?? []),
      templateModelRules: concat((file) => file.modelConfigRules?.templateModelRules ?? []),
      builtinProviderModelRules: concat(
        (file) => file.modelConfigRules?.builtinProviderModelRules ?? [],
      ),
    },
  };
}

/**
 * 扁平文件 → 现有规则模型。`modelConfigRules`（原样镜像）先入，扁平 `models` 后入并因此覆盖；
 * 正则项映射为 `model`，精确项映射为 `provider-model`。
 */
export function parseModelSmartConfigRules(input: unknown): ModelConfigRules {
  const file = modelSmartConfigFileSchema.parse(input);
  const flatRules = new ModelConfigRules(
    file.models.map((entry) => {
      const config = ModelConfig.fromData(modelConfigDataSchema.parse(entryToConfigData(entry)));
      if (entry.modelMatch !== undefined) {
        if (entry.baseUrlMatch !== undefined) {
          return {
            type: "provider-site",
            modelMatch: entry.modelMatch,
            baseUrlMatch: entry.baseUrlMatch,
            ...(entry.apiTypeMatch === undefined ? {} : { apiTypeMatch: entry.apiTypeMatch }),
            config,
          } satisfies ModelConfigRule;
        }
        if (entry.apiTypeMatch !== undefined) {
          return {
            type: "model-api",
            modelMatch: entry.modelMatch,
            apiTypeMatch: entry.apiTypeMatch,
            config,
          } satisfies ModelConfigRule;
        }
        return { type: "model", modelMatch: entry.modelMatch, config } satisfies ModelConfigRule;
      }
      if (entry.templateId !== undefined) {
        return {
          type: "template-model",
          templateId: entry.templateId,
          modelId: entry.modelId as string,
          config,
        } satisfies ModelConfigRule;
      }
      return {
        type: "provider-model",
        providerId: entry.providerId as string,
        modelId: entry.modelId as string,
        config,
      } satisfies ModelConfigRule;
    }),
  );
  if (file.modelConfigRules === undefined) return flatRules;
  // 镜像层在内置规则之上、扁平手工规则之下；扁平规则覆盖同名模型。
  return mergeModelConfigRules(parseZCodeBuiltinModelConfigRules(file.modelConfigRules), flatRules);
}

/**
 * 保序合并两层规则：`extra` 排在 `base` 之后，按 `ModelConfigRules.resolve` 的「后者覆盖前者」语义获胜。
 * 不能用 `composeEffective`——它会丢掉第二参里的非精确规则。
 */
export function mergeModelConfigRules(
  base: ModelConfigRules,
  extra: ModelConfigRules,
): ModelConfigRules {
  if (extra.rules().length === 0) return base;
  if (base.rules().length === 0) return extra;
  return new ModelConfigRules([...base.rules(), ...extra.rules()]);
}

function entryToConfigData(entry: ModelSmartConfigEntry): z.infer<typeof modelConfigDataSchema> {
  const inputFormat = defined({
    ...(entry.supportsText === undefined ? {} : { supportsText: entry.supportsText }),
    ...(entry.supportsImage === undefined ? {} : { supportsImage: entry.supportsImage }),
    ...(entry.supportsVideo === undefined ? {} : { supportsVideo: entry.supportsVideo }),
    ...(entry.supportsAudio === undefined ? {} : { supportsAudio: entry.supportsAudio }),
    ...(entry.supportsPdf === undefined ? {} : { supportsPdf: entry.supportsPdf }),
  });
  const properties = defined({
    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
    ...(inputFormat === undefined ? {} : { inputFormat }),
    ...(entry.supportsText === undefined
      ? {}
      : { outputFormat: { supportsText: entry.supportsText } }),
    ...(entry.supportsToolCall === undefined ? {} : { supportsToolCall: entry.supportsToolCall }),
    ...(entry.supportsJsonSchemaOutput === undefined
      ? {}
      : { supportsJsonSchemaOutput: entry.supportsJsonSchemaOutput }),
    ...(entry.supportsNativeWebSearch === undefined
      ? {}
      : { supportsNativeWebSearch: entry.supportsNativeWebSearch }),
    ...(entry.supportsMidConversationSystem === undefined
      ? {}
      : { supportsMidConversationSystem: entry.supportsMidConversationSystem }),
  });
  const maxOutputTokensSpec = defined({
    ...(entry.maxOutputTokens === undefined ? {} : { max: entry.maxOutputTokens }),
    ...(entry.maxOutputTokensMap === undefined ? {} : { map: entry.maxOutputTokensMap }),
  });
  const reasoningLevelSpec = defined({
    ...(entry.reasoningLevels === undefined ? {} : { values: entry.reasoningLevels }),
    ...(entry.reasoningLevelMap === undefined ? {} : { map: entry.reasoningLevelMap }),
  });
  const optionSpecs = defined({
    ...(maxOutputTokensSpec === undefined ? {} : { maxOutputTokens: maxOutputTokensSpec }),
    ...(reasoningLevelSpec === undefined ? {} : { reasoningLevel: reasoningLevelSpec }),
  });
  return defined({
    ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
    ...(properties === undefined ? {} : { properties }),
    ...(optionSpecs === undefined ? {} : { optionSpecs }),
  }) as z.infer<typeof modelConfigDataSchema>;
}

function defined<T extends object>(value: T): T | undefined {
  return Object.keys(value).length > 0 ? value : undefined;
}
