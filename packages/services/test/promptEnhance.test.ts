import assert from "node:assert/strict";
import test from "node:test";
import { ZCODE_AGENT_PROVIDER_NOT_READY_CODE } from "@zcode/shared";
import {
  createPromptEnhanceService,
  type PromptEnhanceParams,
} from "../src/prompt/promptEnhance.js";

interface CapturedGenerateTextParams {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  selection: { providerId: string; modelId: string; options?: { reasoningLevel?: string } };
  messages: Array<{ role: string; content: string }>;
  querySource: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

function createHarness(respond: (params: CapturedGenerateTextParams) => Promise<{ text: string }>) {
  const calls: CapturedGenerateTextParams[] = [];
  const service = createPromptEnhanceService({
    textGenerator: {
      async generateText(params) {
        calls.push(params as CapturedGenerateTextParams);
        return await respond(params as CapturedGenerateTextParams);
      },
    },
  });
  return { calls, service };
}

const baseParams: PromptEnhanceParams = {
  workspacePath: "/tmp/workspace",
  selection: { providerId: "provider-a", modelId: "model-a" },
  text: "修复登录页的报错",
  requestId: "req-base",
};

/** 生成器里「一直挂起直到 signal 被 abort」的响应，用来验证取消真的传到了底层。 */
function pendingUntilAborted(params: CapturedGenerateTextParams): Promise<{ text: string }> {
  return new Promise<{ text: string }>((_resolve, reject) => {
    params.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

test("提示词增强：空草稿不发起模型请求", async () => {
  const { calls, service } = createHarness(async () => ({ text: "unused" }));

  const result = await service.enhance({ ...baseParams, text: "   \n  " });

  assert.deepEqual(result, { ok: false, reason: "empty-draft" });
  assert.equal(calls.length, 0);
});

test("提示词增强：选择缺 provider 或 model 时不发起请求", async () => {
  const { calls, service } = createHarness(async () => ({ text: "unused" }));

  const result = await service.enhance({
    ...baseParams,
    selection: { providerId: "", modelId: "model-a" },
  });

  assert.deepEqual(result, { ok: false, reason: "model-unavailable" });
  assert.equal(calls.length, 0);
});

test("提示词增强：请求带上 prompt_enhance querySource、system 约束与草稿原文", async () => {
  const { calls, service } = createHarness(async () => ({ text: "更清晰的提示词" }));

  const result = await service.enhance(baseParams);
  const call = calls[0];

  assert.deepEqual(result, { ok: true, text: "更清晰的提示词" });
  assert.equal(calls.length, 1);
  assert.equal(call?.querySource, "prompt_enhance");
  assert.equal(call?.workspacePath, "/tmp/workspace");
  assert.equal(call?.maxOutputTokens, 4096);
  assert.equal(call?.messages[0]?.role, "system");
  assert.equal(call?.messages[1]?.role, "user");
  assert.match(call?.messages[1]?.content ?? "", /修复登录页的报错/);
});

test("提示词增强：剥掉模型误加的代码围栏与包裹引号", async () => {
  const { service } = createHarness(async () => ({ text: '```\n"润色后的提示词"\n```' }));

  const result = await service.enhance(baseParams);

  assert.deepEqual(result, { ok: true, text: "润色后的提示词" });
});

test("提示词增强：模型返回空内容时按 invalid-output 处理，不返回空串", async () => {
  const { service } = createHarness(async () => ({ text: "   " }));

  const result = await service.enhance(baseParams);

  assert.deepEqual(result, { ok: false, reason: "invalid-output" });
});

test("提示词增强：provider 未就绪归为 model-unavailable", async () => {
  const { service } = createHarness(async () => {
    const error = new Error("当前没有可用的模型供应商和模型，请先登录或配置 API Key。") as Error & {
      code?: string;
    };
    error.code = ZCODE_AGENT_PROVIDER_NOT_READY_CODE;
    throw error;
  });

  const result = await service.enhance(baseParams);

  assert.equal(result.ok, false);
  assert.equal(result.ok === false ? result.reason : "", "model-unavailable");
});

test("提示词增强：传给生成器的 signal 是真实 AbortSignal", async () => {
  const { calls, service } = createHarness(async () => ({ text: "ok" }));

  await service.enhance(baseParams);

  // 回归护栏：一旦有人把经 RPC 反序列化过的 signal（{}）重新塞回参数，
  // 这里就会失去 addEventListener，host 侧随即抛 TypeError。
  const signal = calls[0]?.signal;
  assert.equal(typeof signal?.addEventListener, "function");
  assert.equal(signal?.aborted, false);
});

test("提示词增强：cancel(requestId) 中断在途生成并归为 aborted", async () => {
  let seenSignal: AbortSignal | undefined;
  const { service } = createHarness(async (params) => {
    seenSignal = params.signal;
    return await pendingUntilAborted(params);
  });

  const pendingResult = service.enhance({ ...baseParams, requestId: "req-cancel" });
  await Promise.resolve();
  await service.cancel("req-cancel");

  assert.deepEqual(await pendingResult, { ok: false, reason: "aborted" });
  assert.equal(seenSignal?.aborted, true);
});

test("提示词增强：cancel 对未知或已结束的 requestId 是幂等空操作", async () => {
  const { service } = createHarness(async () => ({ text: "ok" }));

  await service.cancel("never-started");
  await service.cancel("never-started");

  await service.enhance({ ...baseParams, requestId: "req-done" });
  // 已结束：在途表已清理，再取消不应抛错也不影响后续请求。
  await service.cancel("req-done");
  assert.deepEqual(await service.enhance({ ...baseParams, requestId: "req-done" }), {
    ok: true,
    text: "ok",
  });
});

test("提示词增强：同一 requestId 再次 enhance 会中止上一次在途请求", async () => {
  const signals: Array<AbortSignal | undefined> = [];
  const { service } = createHarness(async (params) => {
    signals.push(params.signal);
    if (signals.length === 1) {
      return await pendingUntilAborted(params);
    }
    return { text: "第二次" };
  });

  const first = service.enhance({ ...baseParams, requestId: "req-same" });
  await Promise.resolve();
  const second = await service.enhance({ ...baseParams, requestId: "req-same" });

  assert.deepEqual(second, { ok: true, text: "第二次" });
  assert.deepEqual(await first, { ok: false, reason: "aborted" });
  assert.equal(signals[0]?.aborted, true);
});

test("提示词增强：其他失败保留 detail 供 UI 展示", async () => {
  const { service } = createHarness(async () => {
    throw new Error("socket hang up");
  });

  const result = await service.enhance(baseParams);

  assert.deepEqual(result, { ok: false, reason: "request-failed", detail: "socket hang up" });
});

test("提示词增强：超长草稿被截断后再发送", async () => {
  const { calls, service } = createHarness(async () => ({ text: "ok" }));

  await service.enhance({ ...baseParams, text: "x".repeat(20_000) });

  const sent = calls[0]?.messages[1]?.content ?? "";
  assert.match(sent, /draft truncated/);
  assert.ok(sent.length < 20_000);
});
