import assert from "node:assert/strict";
import test from "node:test";
import { generateText, streamText } from "ai";
import type { JsonSchema, ModelAssistantContent, ModelToolContract } from "@zcode/contracts";
import { AiSdkModelAdapterError } from "../src/model/errors.js";
import {
  classifyModelFailure,
  findProviderBusinessError,
} from "../src/model/failure-classifier.js";
import { AiSdkModelExecution, isProviderBusinessError } from "../src/model/model-execution.js";
import { detectProviderBusinessFinishError } from "../src/model/provider-finish-business-error.js";
import { createGenerateTextOptions, createStreamTextOptions } from "../src/model/runner-options.js";
import { normalizeUsage } from "../src/model/runner-normalization.js";
import type { AiSdkModelTextRequest } from "../src/model/runner-runtime.js";
import { toAiSdkMessages } from "../src/model/transform.js";
import {
  createGeminiExecution,
  createMockTransport,
  createStatusContext,
  GEMINI_PROPERTIES,
  geminiJsonResponse,
  jsonResponse,
} from "./geminiTestSupport.js";

const TEXT_CONTENT = {
  parts: [{ text: "pong" }],
  role: "model",
};

function okResponse(usageMetadata?: Record<string, unknown>): Response {
  return geminiJsonResponse({
    content: TEXT_CONTENT,
    finishReason: "STOP",
    ...(usageMetadata ? { usageMetadata } : {}),
  });
}

async function runGenerate(
  execution: ReturnType<typeof createGeminiExecution>,
  request: Partial<AiSdkModelTextRequest> = {},
): Promise<Awaited<ReturnType<typeof generateText>>> {
  const resolved = execution.resolveRequest();
  return generateText(
    createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ content: "hi", role: "user" }],
        ...request,
      } as AiSdkModelTextRequest,
      resolved,
      statusContext: createStatusContext({}),
    }),
  );
}

async function runStream(
  execution: ReturnType<typeof createGeminiExecution>,
  request: Partial<AiSdkModelTextRequest> = {},
): Promise<{
  body: Record<string, unknown> | undefined;
  options: ReturnType<typeof createStreamTextOptions>;
  text: string;
}> {
  const resolved = execution.resolveRequest();
  const options = createStreamTextOptions({
    includeModelIO: false,
    request: {
      messages: [{ content: "hi", role: "user" }],
      ...request,
    } as AiSdkModelTextRequest,
    resolved,
    statusContext: createStatusContext({ transport: "sse" }),
  });
  const result = streamText(options);
  const text = await result.text;
  return { body: execution.requests.at(-1)?.body, options, text };
}

test("Gemini Base URL 规范化保留显式版本与 gateway 前缀", async () => {
  const cases: Array<{ baseURL: string; expected: string }> = [
    {
      baseURL: "https://generativelanguage.googleapis.com/",
      expected: "https://generativelanguage.googleapis.com/v1beta",
    },
    {
      baseURL: "https://generativelanguage.googleapis.com/v1/",
      expected: "https://generativelanguage.googleapis.com/v1",
    },
    {
      baseURL: "https://generativelanguage.googleapis.com/v1beta/",
      expected: "https://generativelanguage.googleapis.com/v1beta",
    },
    {
      baseURL: "https://gateway.example.test/proxy/google/",
      expected: "https://gateway.example.test/proxy/google/v1beta",
    },
    {
      baseURL: "https://gateway.example.test/proxy/google/v1/",
      expected: "https://gateway.example.test/proxy/google/v1",
    },
  ];

  for (const entry of cases) {
    const execution = createGeminiExecution({
      baseURL: entry.baseURL,
      respond: () => okResponse(),
    });
    await runGenerate(execution);
    assert.equal(
      execution.requests.at(-1)?.url,
      `${entry.expected}/models/gemini-2.5-flash:generateContent`,
      entry.baseURL,
    );
  }
});

test("native generate 请求使用 generateContent 与 contents/systemInstruction/generationConfig", async () => {
  const execution = createGeminiExecution({ respond: () => okResponse() });
  const tools: ModelToolContract[] = [
    {
      description: "Look up the weather",
      inputSchema: {
        properties: { city: { type: "string" } },
        required: ["city"],
        type: "object",
      } as JsonSchema,
      name: "get_weather",
    },
  ];

  await runGenerate(execution, {
    messages: [
      { content: "You are terse.", role: "system" },
      { content: "weather in Paris?", role: "user" },
    ],
    tools,
  });

  const request = execution.requests.at(-1);
  assert.ok(request);
  assert.ok(request.url.endsWith("/models/gemini-2.5-flash:generateContent"));
  const body = request.body ?? {};
  assert.equal(body.systemInstruction !== undefined, true);
  assert.deepEqual((body.systemInstruction as { parts: unknown[] }).parts, [
    { text: "You are terse." },
  ]);
  const contents = body.contents as Array<{ parts: Array<Record<string, unknown>>; role: string }>;
  assert.deepEqual(contents[0], { parts: [{ text: "weather in Paris?" }], role: "user" });
  const generationConfig = body.generationConfig as Record<string, unknown>;
  assert.equal(generationConfig.maxOutputTokens, 2048);
  assert.deepEqual(generationConfig.thinkingConfig, { thinkingBudget: 1024 });
  const toolDeclarations = (body.tools as Array<{ functionDeclarations: unknown[] }>)[0];
  assert.equal(
    (toolDeclarations?.functionDeclarations[0] as { name?: string } | undefined)?.name,
    "get_weather",
  );
  // 不能退回 OpenAI Chat Completions 字段。
  for (const chatField of ["messages", "max_tokens", "functions", "function_call"]) {
    assert.equal(Object.hasOwn(body, chatField), false, chatField);
  }
});

test("requiresMfjsToolSchema 把 MCP 本地引用提升为 Google 接受的 $defs", async () => {
  const execution = createGeminiExecution({ respond: () => okResponse() });
  const resolved = {
    ...execution.resolveRequest(),
    properties: { ...GEMINI_PROPERTIES, requiresMfjsToolSchema: true },
  };
  const tools: ModelToolContract[] = [
    {
      description: "Convert a measurement",
      inputSchema: {
        properties: {
          unit: { enum: ["c", "f"], type: "string" },
          target: { $ref: "#/properties/unit" },
        },
        required: ["target"],
        type: "object",
      } as JsonSchema,
      name: "convert_unit",
    },
  ];

  // Google 原生转换器只接受 #/$defs 直接子级引用；若仍发送 #/properties 会被 SDK 拒绝。
  await generateText(
    createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ content: "convert", role: "user" }],
        tools,
      } as AiSdkModelTextRequest,
      resolved,
      statusContext: createStatusContext({}),
    }),
  );

  const body = execution.requests.at(-1)?.body ?? {};
  const declarations = (body.tools as Array<{ functionDeclarations: unknown[] }>)[0]
    ?.functionDeclarations as Array<{ parameters?: Record<string, unknown> }> | undefined;
  const parameters = declarations?.[0]?.parameters;
  assert.ok(parameters);
  // Google SDK 会把 $defs 引用内联到 wire；能走到这里即证明本地引用已被解析，
  // 否则 SDK 会抛 AI_UnsupportedFunctionalityError（仅支持 root $defs/definitions 直接子级）。
  const serialized = JSON.stringify(parameters);
  assert.equal(serialized.includes("#/properties/"), false);
  assert.deepEqual((parameters.properties as Record<string, unknown> | undefined)?.target, {
    enum: ["c", "f"],
    type: "string",
  });
});

test("Gemini 3/4 并行 functionCall 与续轮 functionResponse 形状", async () => {
  for (const modelId of ["gemini-3.5-flash", "gemini-4-argon"]) {
    const execution = createGeminiExecution({ modelId, respond: () => okResponse() });
    const assistantContent: ModelAssistantContent = [
      {
        type: "tool_call",
        id: "call-a",
        name: "lookup",
        input: { q: "x" },
        providerOptions: { google: { thoughtSignature: "sig-a" } },
      },
      // 同一并行响应里第二个调用合法地没有签名。
      { type: "tool_call", id: "call-b", name: "lookup", input: { q: "y" } },
    ];
    const result = await runGenerate(execution, {
      messages: [
        { content: "hi", role: "user" },
        { assistantContent, content: "", role: "assistant" },
        {
          content: [
            { dataUrl: "data:image/png;base64,aGVsbG8=", mediaType: "image/png", type: "image" },
            { text: "ok", type: "text" },
          ],
          role: "tool",
          toolCallId: "call-a",
          toolName: "lookup",
        },
        { content: "ok", role: "tool", toolCallId: "call-b", toolName: "lookup" },
      ],
    });

    const body = execution.requests.at(-1)?.body ?? {};
    const contents = body.contents as Array<{
      parts: Array<Record<string, unknown>>;
      role: string;
    }>;
    const modelParts = contents[1]?.parts ?? [];
    assert.deepEqual(
      modelParts.map((part) => part.functionCall),
      [
        { args: { q: "x" }, id: "call-a", name: "lookup" },
        { args: { q: "y" }, id: "call-b", name: "lookup" },
      ],
      modelId,
    );
    assert.equal(modelParts[0]?.thoughtSignature, "sig-a", modelId);
    // 已签名调用之后的无签名调用不注入 sentinel。
    assert.equal(Object.hasOwn(modelParts[1]!, "thoughtSignature"), false, modelId);
    assert.equal(
      JSON.stringify(body).includes("skip_thought_signature_validator"),
      false,
      `${modelId} 正常 signed 历史不应触发 sentinel`,
    );
    assert.equal(
      JSON.stringify(result.warnings ?? []).includes("skip_thought_signature_validator"),
      false,
      `${modelId} 不应产生 sentinel warning`,
    );

    // Gemini 3+ 的 functionResponse 支持内嵌 parts（图片结果不再被降级成纯文本）。
    const functionResponse = contents.find(
      (content) => content.role === "user" && content.parts[0]?.functionResponse,
    )?.parts[0]?.functionResponse as
      | { id?: string; name?: string; parts?: Array<Record<string, unknown>>; response?: unknown }
      | undefined;
    assert.equal(functionResponse?.id, "call-a", modelId);
    assert.equal(functionResponse?.name, "lookup", modelId);
    assert.deepEqual(
      functionResponse?.parts,
      [{ inlineData: { data: "aGVsbG8=", mimeType: "image/png" } }],
      modelId,
    );
    assert.deepEqual(functionResponse?.response, { content: "ok", name: "lookup" }, modelId);
  }
});

test("Gemini 3 SSE 路径同样保留 signed/unsigned parallel functionCall", async () => {
  const execution = createGeminiExecution({
    modelId: "gemini-3.5-flash",
    respond: () =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 1, totalTokenCount: 2 },
        })}\r\n\r\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const assistantContent: ModelAssistantContent = [
    {
      type: "tool_call",
      id: "call-a",
      name: "lookup",
      input: { q: "x" },
      providerOptions: { google: { thoughtSignature: "sig-a" } },
    },
    { type: "tool_call", id: "call-b", name: "lookup", input: { q: "y" } },
  ];
  const { body, options } = await runStream(execution, {
    messages: [
      { content: "hi", role: "user" },
      { assistantContent, content: "", role: "assistant" },
      { content: "ok", role: "tool", toolCallId: "call-a", toolName: "lookup" },
      { content: "ok", role: "tool", toolCallId: "call-b", toolName: "lookup" },
      { content: "next", role: "user" },
    ],
  });
  assert.equal(execution.requests.at(-1)?.url.includes(":streamGenerateContent?alt=sse"), true);
  assert.equal(options.messages?.length, 5);
  const contents = body?.contents as Array<{ parts: Array<Record<string, unknown>>; role: string }>;
  assert.equal(contents[1]?.parts[0]?.thoughtSignature, "sig-a");
  assert.equal(Object.hasOwn(contents[1]!.parts[1]!, "thoughtSignature"), false);
  assert.equal(JSON.stringify(body).includes("skip_thought_signature_validator"), false);
});

test("Gemini 3/4 无签名首调用注入 sentinel 并经 onWarning 报告", async () => {
  for (const modelId of ["gemini-3.5-flash", "gemini-4-argon"]) {
    const execution = createGeminiExecution({ modelId, respond: () => okResponse() });
    const assistantContent: ModelAssistantContent = [
      { type: "tool_call", id: "call-a", name: "lookup", input: { q: "x" } },
    ];
    const result = await runGenerate(execution, {
      messages: [
        { content: "hi", role: "user" },
        { assistantContent, content: "", role: "assistant" },
        { content: "ok", role: "tool", toolCallId: "call-a", toolName: "lookup" },
      ],
    });

    const body = execution.requests.at(-1)?.body ?? {};
    const contents = body.contents as Array<{
      parts: Array<Record<string, unknown>>;
      role: string;
    }>;
    assert.equal(
      contents[1]?.parts[0]?.thoughtSignature,
      "skip_thought_signature_validator",
      modelId,
    );
    const warnings = JSON.stringify(result.warnings ?? []);
    assert.equal(warnings.includes("skip_thought_signature_validator"), true, modelId);
    assert.equal(warnings.includes("lookup"), true, modelId);
  }
});

test("Google SDK wire 边界丢弃空 text part，ZCode 只保证不主动丢弃", async () => {
  const execution = createGeminiExecution({ respond: () => okResponse() });
  const assistantContent: ModelAssistantContent = [
    { providerOptions: { google: { thoughtSignature: "sig-hello" } }, text: "Hello", type: "text" },
    { providerOptions: { google: { thoughtSignature: "sig-empty" } }, text: "", type: "text" },
  ];
  // ZCode 投影边界保留空 signed text；SDK 会在转 wire 时丢弃 text:""。
  const projected = toAiSdkMessages([{ assistantContent, content: "", role: "assistant" }], {
    providerKind: "google",
  });
  assert.deepEqual(projected[0]?.content, [
    { providerOptions: { google: { thoughtSignature: "sig-hello" } }, text: "Hello", type: "text" },
    { providerOptions: { google: { thoughtSignature: "sig-empty" } }, text: "", type: "text" },
  ]);

  await runGenerate(execution, {
    messages: [
      { content: "hi", role: "user" },
      { assistantContent, content: "", role: "assistant" },
      { content: "next", role: "user" },
    ],
  });
  const contents = execution.requests.at(-1)?.body?.contents as Array<{
    parts: Array<Record<string, unknown>>;
    role: string;
  }>;
  assert.deepEqual(contents[1]?.parts, [{ text: "Hello", thoughtSignature: "sig-hello" }]);
  assert.equal(JSON.stringify(contents).includes("sig-empty"), false);
});

test("tool 结果投影为 functionResponse，模型名只补一次 models/ 前缀", async () => {
  const execution = createGeminiExecution({ respond: () => okResponse() });
  await runGenerate(execution, {
    messages: [
      { content: "weather?", role: "user" },
      {
        content: "",
        role: "assistant",
        toolCalls: [{ id: "call-1", input: { city: "Paris" }, name: "get_weather" }],
      },
      {
        content: "sunny",
        role: "tool",
        toolCallId: "call-1",
        toolName: "get_weather",
      },
    ],
  });

  const request = execution.requests.at(-1);
  assert.ok(request);
  assert.ok(request.url.includes("/models/gemini-2.5-flash:generateContent"));
  assert.equal(request.url.includes("/models/models/"), false);
  const contents = request.body?.contents as Array<{
    parts: Array<Record<string, unknown>>;
    role: string;
  }>;
  const functionCall = contents[1]?.parts[0]?.functionCall as
    | { args?: unknown; name?: string }
    | undefined;
  assert.equal(functionCall?.name, "get_weather");
  assert.deepEqual(functionCall?.args, { city: "Paris" });
  const functionResponse = contents[2]?.parts[0]?.functionResponse as
    | { name?: string; response?: { name?: string; content?: string } }
    | undefined;
  assert.equal(contents[2]?.role, "user");
  assert.equal(functionResponse?.name, "get_weather");
  assert.equal(functionResponse?.response?.content, "sunny");
});

test("stream 路径使用 streamGenerateContent?alt=sse", async () => {
  const execution = createGeminiExecution({
    respond: () =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: "pong" }] }, finishReason: "STOP" }],
          usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 1, totalTokenCount: 2 },
        })}\r\n\r\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  });

  const { text } = await runStream(execution);
  assert.equal(text, "pong");
  assert.equal(
    execution.requests.at(-1)?.url,
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse",
  );
});

test("显式 x-goog-api-key 大小写不敏感且优先，不追加 Bearer", async () => {
  const execution = createGeminiExecution({
    defaultHeaders: { "x-zcode-attribution": "trace" },
    headers: { "X-Goog-Api-Key": "explicit-key", "x-gateway": "gw" },
    respond: () => okResponse(),
  });

  await runGenerate(execution);
  const request = execution.requests.at(-1);
  assert.ok(request);
  assert.equal(request.headers["x-goog-api-key"], "explicit-key");
  assert.equal(request.headers["x-gateway"], "gw");
  assert.equal(request.headers["x-zcode-attribution"], "trace");
  assert.equal(request.headers.authorization, undefined);
  assert.equal(Object.keys(request.headers).filter((name) => name === "x-goog-api-key").length, 1);
});

test("请求期 Key 覆盖冻结 Key，且不生成 Authorization", async () => {
  const execution = createGeminiExecution({ respond: () => okResponse() });
  const resolved = execution.resolveRequest({
    requestAuth: { apiKey: "request-key", headers: { "x-request-scope": "yes" } },
  });
  const options = createGenerateTextOptions({
    includeModelIO: false,
    request: {
      messages: [{ content: "hi", role: "user" }],
    } as AiSdkModelTextRequest,
    resolved,
    statusContext: createStatusContext({}),
  });
  await generateText(options);

  const request = execution.requests.at(-1);
  assert.ok(request);
  assert.equal(request.headers["x-goog-api-key"], "request-key");
  assert.equal(request.headers["x-request-scope"], "yes");
  assert.equal(request.headers.authorization, undefined);
});

test("frozen binding 不被绑定后的配置变更影响", async () => {
  const providerApi = {
    baseUrl: "https://generativelanguage.googleapis.com/",
    headers: { "x-frozen": "before" },
    type: "gemini-generate-content",
  };
  const access = { apiKey: "frozen-key", type: "api-key" };
  const transport = createMockTransport(() => okResponse());
  const execution = new AiSdkModelExecution({ env: {} }, { transport: transport.fetch });
  const binding = execution.bindModel({
    modelId: "models/gemini-2.5-flash",
    optionSpecs: {
      maxOutputTokens: { map: "{'generationConfig': {'maxOutputTokens': maxOutputTokens}}" },
      reasoningLevel: { map: "{}" },
    },
    providerConfig: { access, api: providerApi } as never,
    providerId: "google-personal",
    supportsJsonSchemaOutput: true,
  });

  providerApi.baseUrl = "https://changed.example.test/";
  providerApi.headers = { "x-frozen": "after" };
  access.apiKey = "changed-key";

  const resolved = {
    ...binding.resolveRequest({ options: { maxOutputTokens: 1024, reasoningLevel: "low" } }),
    properties: GEMINI_PROPERTIES,
  };
  assert.equal(resolved.modelId, "models/gemini-2.5-flash");

  await generateText(
    createGenerateTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ content: "hi", role: "user" }],
      } as AiSdkModelTextRequest,
      resolved,
      statusContext: createStatusContext({}),
    }),
  );

  const request = transport.requests.at(-1);
  assert.ok(request);
  assert.ok(request.url.startsWith("https://generativelanguage.googleapis.com/v1beta/"));
  assert.equal(request.headers["x-frozen"], "before");
  assert.equal(request.headers["x-goog-api-key"], "frozen-key");
});

test("拒绝 query/fragment/model action Base URL，不降级协议", () => {
  for (const baseURL of [
    "https://generativelanguage.googleapis.com/v1beta?key=1",
    "https://generativelanguage.googleapis.com/v1beta#fragment",
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
  ]) {
    assert.throws(
      () => createGeminiExecution({ baseURL, respond: () => okResponse() }),
      (error: unknown) =>
        error instanceof AiSdkModelAdapterError &&
        error.code === "invalid_model_request" &&
        (error.context?.reason === "query-or-fragment" || error.context?.reason === "model-action"),
      baseURL,
    );
  }
});

test("JSON output 在 generate 与 stream 请求中生成同一 responseSchema", async () => {
  const responseJsonSchema = {
    additionalProperties: false,
    properties: { answer: { type: "string" } },
    required: ["answer"],
    type: "object",
  } satisfies JsonSchema;
  const jsonText = '{"answer":"ok"}';

  const generateExecution = createGeminiExecution({
    respond: () =>
      geminiJsonResponse({
        content: { parts: [{ text: jsonText }], role: "model" },
        finishReason: "STOP",
      }),
  });
  const result = await runGenerate(generateExecution, { responseJsonSchema });
  assert.deepEqual(result.output, { answer: "ok" });
  const generateBody = generateExecution.requests.at(-1)?.body ?? {};
  const generateConfig = generateBody.generationConfig as Record<string, unknown>;
  assert.equal(generateConfig.responseMimeType, "application/json");
  assert.deepEqual(generateConfig.responseSchema, {
    properties: { answer: { type: "string" } },
    required: ["answer"],
    type: "object",
  });

  const streamExecution = createGeminiExecution({
    respond: () =>
      new Response(
        `data: ${JSON.stringify({
          candidates: [{ content: { parts: [{ text: jsonText }] }, finishReason: "STOP" }],
        })}\r\n\r\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  const streamed = await runStream(streamExecution, { responseJsonSchema });
  assert.notEqual(streamed.options.output, undefined);
  assert.equal(streamed.text, jsonText);
  const streamBody = streamExecution.requests.at(-1)?.body ?? {};
  const streamConfig = streamBody.generationConfig as Record<string, unknown>;
  assert.equal(streamConfig.responseMimeType, "application/json");
  // SDK 会把 JSON Schema 转成 OpenAPI schema（丢弃 additionalProperties），
  // generate 与 stream 必须得到完全相同的请求字段。
  assert.deepEqual(streamConfig.responseSchema, generateConfig.responseSchema);
});

test("Google JSON 错误保持 HTTP 状态、code 与 message 归因", async () => {
  const cases = [
    {
      body: {
        error: { code: 401, message: "API key not valid.", status: "UNAUTHENTICATED" },
      },
      expectReason: "auth_failed",
      expectRetryable: false,
      status: 401,
    },
    {
      body: {
        error: { code: 429, message: "Quota exceeded.", status: "RESOURCE_EXHAUSTED" },
      },
      expectReason: "rate_limited",
      expectRetryable: true,
      status: 429,
    },
    {
      body: { error: { code: 503, message: "Service unavailable.", status: "UNAVAILABLE" } },
      expectReason: "server_error",
      expectRetryable: true,
      status: 503,
    },
  ];

  for (const entry of cases) {
    const execution = createGeminiExecution({
      respond: () => jsonResponse(entry.body, entry.status),
    });
    let failure: unknown;
    try {
      await runGenerate(execution);
      assert.fail(`expected ${entry.status} to fail`);
    } catch (error) {
      failure = error;
    }

    assert.equal(isProviderBusinessError(failure), true);
    const businessError = failure as {
      providerMessage?: string;
      providerKind: string;
      responseStatus?: number;
      statusCode?: number;
    };
    assert.equal(businessError.providerKind, "google");
    assert.equal(businessError.responseStatus, entry.status);
    assert.equal(businessError.statusCode, entry.status);
    assert.match(businessError.providerMessage ?? "", /API key not valid|Quota|unavailable/);

    const classified = classifyModelFailure(failure);
    assert.equal(classified.reason, entry.expectReason, String(entry.status));
    assert.equal(classified.retryable, entry.expectRetryable, String(entry.status));
    assert.equal(classified.statusCode, entry.status);
  }
});

test("Google SSE error frame 以 ProviderBusinessError 终止且保留业务码", async () => {
  const execution = createGeminiExecution({
    respond: () =>
      new Response(
        `data: ${JSON.stringify({
          error: { code: 429, message: "Quota exceeded.", status: "RESOURCE_EXHAUSTED" },
        })}\r\n\r\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  });

  const resolved = execution.resolveRequest();
  const result = streamText(
    createStreamTextOptions({
      includeModelIO: false,
      request: {
        messages: [{ content: "hi", role: "user" }],
      } as AiSdkModelTextRequest,
      resolved,
      statusContext: createStatusContext({ transport: "sse" }),
    }),
  );
  const errors: unknown[] = [];
  let thrown: unknown;
  try {
    for await (const part of result.fullStream) {
      if (part.type === "error") errors.push(part.error);
    }
  } catch (error) {
    // AI SDK 会把 SSE body 错误包成 APICallError；原始 ProviderBusinessError 在 cause 中。
    thrown = error;
  }
  const failure = errors[0] ?? thrown;
  const businessError = findProviderBusinessError(failure);
  assert.ok(businessError, "expected ProviderBusinessError from SSE frame");
  assert.equal(businessError.providerKind, "google");
  assert.equal(businessError.providerCode, 429);
  const classified = classifyModelFailure(failure);
  assert.equal(classified.reason, "rate_limited");
  assert.equal(classified.retryable, true);
});

test("请求取消归为 cancelled 且不可重试", async () => {
  const controller = new AbortController();
  const execution = createGeminiExecution({
    respond: (request) =>
      new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (request.signal?.aborted) {
          abort();
          return;
        }
        request.signal?.addEventListener("abort", abort, { once: true });
      }),
  });

  const pending = runGenerate(execution, { abortSignal: controller.signal });
  controller.abort();
  let failure: unknown;
  try {
    await pending;
    assert.fail("expected cancellation");
  } catch (error) {
    failure = error;
  }
  const classified = classifyModelFailure(failure, controller.signal);
  assert.equal(classified.reason, "cancelled");
  assert.equal(classified.retryable, false);
});

test("Google usage 的 cache/thought 不重复累计", async () => {
  const execution = createGeminiExecution({
    respond: () =>
      okResponse({
        cachedContentTokenCount: 30,
        candidatesTokenCount: 40,
        thoughtsTokenCount: 10,
        promptTokenCount: 100,
        totalTokenCount: 150,
      }),
  });

  const result = await runGenerate(execution);
  const usage = normalizeUsage(result.totalUsage ?? result.usage);
  assert.equal(usage.inputTokens, 100);
  assert.equal(usage.outputTokens, 50);
  assert.equal(usage.totalTokens, 150);
  assert.equal(usage.cacheReadTokens, 30);
  assert.equal(usage.reasoningTokens, 10);
});

test("Gemini 不通过 OpenAI Chat 或 Google Search 工具降级", async () => {
  const execution = createGeminiExecution({ respond: () => okResponse() });
  await runGenerate(execution, {
    tools: [
      {
        description: "native search",
        inputSchema: { type: "object" } as JsonSchema,
        name: "web_search",
        providerNative: {
          args: { maxUses: 3 },
          fallback: "disabled",
          kind: "provider_native",
          logicalName: "WebSearch",
          providerToolName: "web_search",
        },
      },
    ],
  }).then(
    () => assert.fail("expected provider-native WebSearch to be rejected"),
    (error: unknown) =>
      assert.ok(
        error instanceof AiSdkModelAdapterError &&
          error.code === "invalid_model_request" &&
          !String(error.message).includes("chat/completions"),
      ),
  );
});

test("finish 业务错误归因保留 google kind，不降级为 openai-compatible", () => {
  const error = detectProviderBusinessFinishError({
    providerId: "google-personal",
    providerKind: "google",
    source: {
      finishReason: "error",
      providerCode: 429,
      providerMessage: "Quota exceeded.",
      type: "error",
    },
  });
  assert.ok(error);
  assert.equal(error.providerKind, "google");
  // 未知 kind 的既有兜底仍是 openai-compatible。
  const unknownKind = detectProviderBusinessFinishError({
    providerId: "unknown-provider",
    providerKind: "custom",
    source: {
      finishReason: "error",
      providerCode: 429,
      providerMessage: "Quota exceeded.",
      type: "error",
    },
  });
  assert.equal(unknownKind?.providerKind, "openai-compatible");
});
