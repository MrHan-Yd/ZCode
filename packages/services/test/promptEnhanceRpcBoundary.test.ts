import assert from "node:assert/strict";
import test from "node:test";
import {
  BufferReader,
  BufferWriter,
  ProxyChannel,
  deserialize,
  serialize,
  type IChannel,
  type IServerChannel,
} from "@zcode/rpc";
import {
  createPromptEnhanceService,
  type IPromptEnhanceService,
  type PromptEnhanceParams,
} from "../src/prompt/promptEnhance.js";

/**
 * 提示词增强的 RPC 边界回归护栏。
 *
 * renderer 只能通过 @zcode/rpc 的 ProxyChannel 调用这个服务，参数会经 serialize 过线，
 * 非原始对象走 JSON fallback。历史上 enhance 参数里带了 AbortSignal，过线后退化成 {}，
 * host 侧再调 addEventListener 就抛 `m.signal?.addEventListener is not a function`——
 * 表现为「提示词增强失败」。这些用例把「参数必须可序列化、取消走 requestId」钉住。
 */

interface CapturedGenerateTextParams {
  signal?: AbortSignal;
}

/** 走一次真实的 RPC 序列化往返，得到 host 侧实际会收到的那份参数。 */
function roundTrip(args: unknown[]): unknown[] {
  const writer = new BufferWriter();
  serialize(writer, args);
  return deserialize(new BufferReader(writer.buffer)) as unknown[];
}

/** 把服务端 IServerChannel 接成客户端 IChannel，等价于 renderer 侧 ProxyChannel 代理的传输层。 */
function toClientChannel(server: IServerChannel<undefined>): IChannel {
  return {
    call: (command, arg) => server.call(undefined, command, arg),
    listen: () => {
      throw new Error("prompt-enhance 没有事件通道");
    },
  };
}

function createHarness(
  respond: (params: CapturedGenerateTextParams) => Promise<{ text: string }>,
): { calls: CapturedGenerateTextParams[]; service: IPromptEnhanceService } {
  const calls: CapturedGenerateTextParams[] = [];
  const service = createPromptEnhanceService({
    textGenerator: {
      async generateText(params) {
        calls.push(params);
        return await respond(params);
      },
    },
  });
  return { calls, service };
}

const baseParams: PromptEnhanceParams = {
  workspacePath: "/tmp/workspace",
  selection: { providerId: "provider-a", modelId: "model-a" },
  text: "修复登录页的报错",
  requestId: "req-rpc",
};

test("提示词增强：enhance 参数经 rpc 序列化往返后仍可用", async () => {
  const { calls, service } = createHarness(async () => ({ text: "更清晰的提示词" }));

  const received = roundTrip([baseParams])[0] as PromptEnhanceParams;

  // requestId 是取消的唯一关联键，必须原样过线。
  assert.equal(received.requestId, "req-rpc");
  assert.equal("signal" in received, false, "RPC 参数不允许携带 AbortSignal");

  assert.deepEqual(await service.enhance(received), { ok: true, text: "更清晰的提示词" });
  assert.equal(
    typeof calls[0]?.signal?.addEventListener,
    "function",
    "host 侧必须自己创建真实 AbortSignal，而不是复用反序列化后的假对象",
  );
});

test("提示词增强：renderer 经 ProxyChannel 能 enhance 并能用 requestId 取消", async () => {
  let seenSignal: AbortSignal | undefined;
  const { service } = createHarness(async (params) => {
    seenSignal = params.signal;
    return await new Promise<{ text: string }>((_resolve, reject) => {
      params.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });

  const serverChannel = ProxyChannel.fromService<undefined>(service);
  const proxy = ProxyChannel.toService<IPromptEnhanceService>(toClientChannel(serverChannel));

  const pendingResult = proxy.enhance(baseParams);
  await Promise.resolve();
  await proxy.cancel(baseParams.requestId);

  assert.deepEqual(await pendingResult, { ok: false, reason: "aborted" });
  assert.equal(seenSignal?.aborted, true);
});
