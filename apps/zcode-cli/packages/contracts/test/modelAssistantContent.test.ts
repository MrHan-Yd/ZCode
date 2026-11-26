import assert from "node:assert/strict";
import test from "node:test";
import * as model from "../src/model/index.js";
import { toToolJsonSchema } from "../src/tools/json-schema.js";
import type {
  JsonSchema,
  ModelAssistantContent,
  ModelInputMessage,
  ModelStreamEvent,
  ModelTextContentBlock,
  ModelTextResult,
  ModelToolCall,
} from "../src/model/index.js";

const textOptions = { google: { thoughtSignature: " fixture-text/+== " } };
const reasoningOptions = { google: { thoughtSignature: "fixture-reasoning/+==" } };
const toolOptions = { google: { thoughtSignature: "fixture-tool/+==" } };
const tailOptions = { google: { thoughtSignature: "fixture-empty-tail/+==" } };
const signedText: ModelTextContentBlock = {
  type: "text",
  text: "before",
  providerOptions: textOptions,
};
const signedTool: ModelToolCall = {
  id: "call-1",
  name: "read_fixture",
  input: { path: "fixture.txt" },
  providerExecuted: false,
  providerOptions: toolOptions,
};
const unsignedTool: ModelToolCall = {
  id: "call-2",
  name: "read_fixture",
  input: null,
};
const assistantContent: ModelAssistantContent = [
  signedText,
  { type: "reasoning", text: "thinking", providerOptions: reasoningOptions },
  { type: "tool_call", ...signedTool },
  { type: "text", text: "between" },
  { type: "tool_call", ...unsignedTool },
  { type: "text", text: "", providerOptions: tailOptions },
];
const message: ModelInputMessage = {
  role: "assistant",
  content: [assistantContent[0] as ModelTextContentBlock],
  assistantContent,
  toolCalls: [signedTool, unsignedTool],
};
const result: ModelTextResult = {
  text: "beforebetween",
  finishReason: "tool-calls",
  usage: { inputTokens: 7, outputTokens: 9, reasoningTokens: 3, totalTokens: 16 },
  assistantContent,
  toolCalls: [signedTool, unsignedTool],
  providerMetadata: { google: { requestId: "fixture-request" } },
};

function roundTrip(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function record(value: unknown): JsonSchema {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as JsonSchema;
}

function property(schema: JsonSchema, name: string): JsonSchema {
  return record(record(schema.properties)[name]);
}

function branches(schema: JsonSchema): JsonSchema[] {
  if (!Array.isArray(schema.oneOf)) return [schema];
  return schema.oneOf.flatMap((candidate: unknown) => branches(record(candidate)));
}

function branch(schema: JsonSchema, value: string, discriminant = "type"): JsonSchema {
  const match = branches(schema).find((candidate) => {
    const discriminator = property(candidate, discriminant);
    return (
      discriminator.const === value ||
      (Array.isArray(discriminator.enum) && discriminator.enum.includes(value))
    );
  });
  return record(match);
}

test("输入 JSON Schema 声明具体 text/tool 签名和有序 assistant 内容，而不是聚合 metadata", () => {
  const input = branch(model.modelInputMessageJsonSchema, "assistant", "role");
  assert.equal(property(input, "assistantContent").type, "array");
  const contentVariants = property(input, "content").oneOf;
  assert.ok(Array.isArray(contentVariants));
  const contentArray = record(contentVariants[1]);
  const textSchema = branch(record(contentArray.items), "text");
  assert.equal(property(textSchema, "providerOptions").type, "object");
  const callSchema = record(property(input, "toolCalls").items);
  assert.equal(property(callSchema, "providerOptions").type, "object");
  assert.ok((callSchema.required as string[]).includes("input"));
});

test("Zod 内容校验与 JSON 往返保留逐 part 的原签名、空尾 text 和合法 unsigned parallel call", () => {
  assert.deepEqual(model.modelTextContentBlockSchema.parse(roundTrip(signedText)), signedText);
  assert.deepEqual(model.modelToolCallSchema.parse(roundTrip(signedTool)), signedTool);
  const parsed = model.modelAssistantContentSchema.parse(roundTrip(assistantContent));
  assert.deepEqual(parsed, assistantContent);
  assert.equal(parsed.at(-1)?.type, "text");
  assert.equal((parsed.at(-1) as ModelTextContentBlock).text, "");
  assert.equal(Object.hasOwn(parsed[4]!, "providerOptions"), false);
  assert.deepEqual(
    (parsed[0] as ModelTextContentBlock).providerOptions?.google,
    textOptions.google,
  );
});

test("result 与 assistant input/history 使用相同的有序序列，不把 finish metadata 当签名", () => {
  const parsedMessage = model.modelInputMessageSchema.parse(roundTrip(message));
  const parsedResult = model.modelTextResultSchema.parse(roundTrip(result));
  assert.deepEqual(parsedMessage, message);
  assert.deepEqual(parsedResult, result);
  assert.deepEqual(parsedMessage.assistantContent, parsedResult.assistantContent);
  assert.deepEqual(parsedResult.providerMetadata, { google: { requestId: "fixture-request" } });
});

test("兼容视图仅从有序内容派生，保持 text 原文和 tool 字段且不改写输入", () => {
  const before = structuredClone(assistantContent);
  const projection = model.projectModelAssistantContent(assistantContent);
  assert.deepEqual(projection.content, [
    assistantContent[0],
    assistantContent[1],
    assistantContent[3],
    assistantContent[5],
  ]);
  assert.equal(projection.text, "beforebetween");
  assert.deepEqual(projection.reasoning, [assistantContent[1]]);
  assert.deepEqual(projection.toolCalls, [signedTool, unsignedTool]);
  assert.deepEqual(assistantContent, before);
  assert.equal(Object.hasOwn(projection.toolCalls[1]!, "providerOptions"), false);
  assert.equal(Object.hasOwn(projection.toolCalls[0]!, "type"), false);
  assert.deepEqual(model.projectModelAssistantContent([]), {
    content: [],
    text: "",
    reasoning: [],
    toolCalls: [],
  });
});

test("metadata-only reasoning 与空签名保留，缺签名不能自动补 sentinel", () => {
  const content: ModelAssistantContent = [
    { type: "reasoning", text: "", providerOptions: reasoningOptions },
    { type: "text", text: "", providerOptions: { google: { thoughtSignature: "" } } },
    { type: "tool_call", ...unsignedTool },
  ];
  assert.deepEqual(model.modelAssistantContentSchema.parse(roundTrip(content)), content);
  const projection = model.projectModelAssistantContent(content);
  assert.equal(projection.reasoning.length, 1);
  assert.equal(Object.hasOwn(projection.toolCalls[0]!, "providerOptions"), false);
});

test("text/reasoning start-delta-end 每个边界都能携带原 part metadata", () => {
  const events: ModelStreamEvent[] = [
    { type: "text_start", id: "text-1", providerMetadata: textOptions },
    { type: "text_delta", id: "text-1", text: "before", providerMetadata: textOptions },
    { type: "text_end", id: "text-1", providerMetadata: tailOptions },
    { type: "text_delta", text: "legacy-idless", providerMetadata: textOptions },
    { type: "reasoning_start", id: "thinking-1", providerMetadata: reasoningOptions },
    {
      type: "reasoning_delta",
      id: "thinking-1",
      text: "thinking",
      providerMetadata: reasoningOptions,
    },
    { type: "reasoning_end", id: "thinking-1", providerMetadata: reasoningOptions },
    { type: "tool_call", toolCall: signedTool },
    { type: "tool_call", toolCall: unsignedTool },
  ];
  for (const event of events) {
    assert.deepEqual(model.modelStreamEventSchema.parse(roundTrip(event)), event);
  }
});

test("签名容器保持 opaque namespace，非 record 和未知外层字段严格拒绝", () => {
  const opaque: ModelTextContentBlock = {
    type: "text",
    text: "",
    providerOptions: { google: { thoughtSignature: "fixture" }, other: { nested: [1, null] } },
  };
  assert.deepEqual(model.modelTextContentBlockSchema.parse(opaque), opaque);
  for (const providerOptions of [null, [], "fixture", 7]) {
    assert.equal(
      model.modelTextContentBlockSchema.safeParse({ ...signedText, providerOptions }).success,
      false,
    );
    assert.equal(
      model.modelToolCallSchema.safeParse({ ...signedTool, providerOptions }).success,
      false,
    );
  }
  assert.equal(
    model.modelTextContentBlockSchema.safeParse({ ...signedText, thoughtSignature: "wrong-level" })
      .success,
    false,
  );
  assert.equal(
    model.modelInputMessageSchema.safeParse({ ...message, acceptedQueue: [] }).success,
    false,
  );
  assert.equal(
    model.modelTextResultSchema.safeParse({ ...result, anotherHistory: [] }).success,
    false,
  );
  assert.equal(
    model.modelStreamEventSchema.safeParse({ type: "text_end", id: "text-1", providerMetadata: [] })
      .success,
    false,
  );
});

test("assistantContent 仅 assistant role 合法；tool input 必须存在但允许 null 与空工具名", () => {
  for (const role of ["system", "user", "tool"]) {
    assert.equal(
      model.modelInputMessageSchema.safeParse({ role, content: "", assistantContent }).success,
      false,
    );
  }
  assert.equal(
    model.modelInputMessageSchema.safeParse({
      role: "assistant",
      content: "",
      assistantContent: [],
    }).success,
    true,
  );
  const { input: _input, ...withoutInput } = signedTool;
  assert.equal(model.modelToolCallSchema.safeParse(withoutInput).success, false);
  assert.equal(
    model.modelToolCallSchema.safeParse({ ...signedTool, input: undefined }).success,
    false,
  );
  assert.equal(
    model.modelToolCallSchema.safeParse({ ...signedTool, input: null, name: "" }).success,
    true,
  );
  assert.equal(
    model.modelAssistantContentSchema.safeParse([
      { type: "image", mediaType: "image/png", dataUrl: "fixture" },
    ]).success,
    false,
  );
});

test("tool result output 与 error payload 必须存在，null 合法且调用 metadata 不冒充结果 metadata", () => {
  const toolResult = {
    id: signedTool.id,
    name: signedTool.name,
    input: null,
    output: null,
    providerMetadata: { google: { result: "fixture-result" } },
  };
  assert.deepEqual(model.modelToolResultSchema.parse(toolResult), toolResult);
  assert.deepEqual(model.modelStreamEventSchema.parse({ type: "error", error: null }), {
    type: "error", error: null,
  });
  const { output: _output, ...missingOutput } = toolResult;
  assert.equal(model.modelToolResultSchema.safeParse(missingOutput).success, false);
  assert.equal(model.modelToolResultSchema.safeParse({ ...toolResult, output: undefined }).success, false);
  assert.equal(model.modelToolResultSchema.safeParse({ ...toolResult, providerOptions: toolOptions }).success, false);
  assert.equal(model.modelStreamEventSchema.safeParse({ type: "error" }).success, false);
  assert.equal(model.modelStreamEventSchema.safeParse({ type: "error", error: undefined }).success, false);
  assert.ok((branch(model.modelStreamEventJsonSchema, "error").required as string[]).includes("error"));
  assert.ok((record(property(model.modelTextResultJsonSchema, "toolResults").items).required as string[]).includes("output"));
});

test("新增 JSON Schema 从运行时 schema 同源生成，request 复用更新后的 input schema", () => {
  for (const [runtimeSchema, jsonSchema] of [
    [model.modelTextContentBlockSchema, model.modelTextContentBlockJsonSchema],
    [model.modelToolCallSchema, model.modelToolCallJsonSchema],
    [model.modelAssistantContentSchema, model.modelAssistantContentJsonSchema],
    [model.modelInputMessageSchema, model.modelInputMessageJsonSchema],
    [model.modelTextResultSchema, model.modelTextResultJsonSchema],
    [model.modelStreamEventSchema, model.modelStreamEventJsonSchema],
  ] as const) {
    assert.deepEqual(jsonSchema, toToolJsonSchema(runtimeSchema));
  }
  assert.deepEqual(
    record(property(model.modelTextRequestJsonSchema, "messages").items),
    model.modelInputMessageJsonSchema,
  );
  const resultContent = property(model.modelTextResultJsonSchema, "assistantContent");
  const { $schema: _dialect, ...assistantContentSchemaBody } =
    model.modelAssistantContentJsonSchema;
  assert.deepEqual(resultContent, assistantContentSchemaBody);
  for (const role of ["system", "user", "tool"]) {
    assert.equal(
      Object.hasOwn(
        record(branch(model.modelInputMessageJsonSchema, role, "role").properties),
        "assistantContent",
      ),
      false,
    );
  }
  for (const type of ["text_start", "text_delta", "text_end"]) {
    const eventSchema = branch(model.modelStreamEventJsonSchema, type);
    assert.equal(eventSchema.additionalProperties, false);
    assert.equal(property(eventSchema, "providerMetadata").type, "object");
  }
});

test("旧三种格式没有签名或有序扩展仍可使用原消息、结果和流事件", () => {
  for (const format of ["openai-responses", "openai-chat-completions", "anthropic-messages"]) {
    const legacyMessage: ModelInputMessage = {
      role: "assistant",
      content: "legacy",
      toolCalls: [{ id: "legacy-call", name: "tool", input: {} }],
    };
    const legacyResult: ModelTextResult = {
      text: "legacy",
      finishReason: "stop",
      usage: {},
      providerMetadata: { apiFormat: format },
    };
    assert.deepEqual(model.modelInputMessageSchema.parse(legacyMessage), legacyMessage);
    assert.deepEqual(model.modelTextResultSchema.parse(legacyResult), legacyResult);
    assert.equal(
      Object.hasOwn(model.modelTextResultSchema.parse(legacyResult), "assistantContent"),
      false,
    );
    for (const event of [
      { type: "start" },
      { type: "text_start", id: "legacy-text" },
      { type: "text_delta", text: "legacy" },
      { type: "text_end", id: "legacy-text" },
      { type: "tool_input_start", id: "legacy-call", toolName: "tool" },
      { type: "tool_input_delta", id: "legacy-call", delta: "{}" },
      { type: "tool_input_end", id: "legacy-call" },
      { type: "finish", finishReason: "stop", usage: {} },
      { type: "compact_stream_boundary", boundary: "provider_content_block_stop", index: null },
    ]) {
      assert.deepEqual(model.modelStreamEventSchema.parse(event), event);
    }
  }
});
