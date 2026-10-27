import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCredentialService, toRpcCredentialService } from "../src/credential/credentialService.js";
import { setDataBaseDir } from "../src/paths.js";

/**
 * `deleteIf` 是 host 内部的 compare-and-delete 原语（不进 RPC 接口）。
 *
 * 这里用真实凭据服务 + 临时数据目录验证契约：读取、解密、断言、删除都在同一把
 * credentials 文件锁内完成，且只有断言为真时才真正删除。
 * 临时目录隔离保证不会写进真实用户目录（credentials.json 位于 `{dataBaseDir}/.zcode/v2`）。
 */

async function withTempCredentialService<T>(
  run: (
    service: ReturnType<typeof createCredentialService>,
    mutations: Array<{ operation: "save" | "delete"; key: string }>,
  ) => Promise<T>,
): Promise<T> {
  const dataBaseDir = await mkdtemp(join(tmpdir(), "zcode-credential-delete-if-"));
  const mutations: Array<{ operation: "save" | "delete"; key: string }> = [];
  setDataBaseDir(dataBaseDir);
  try {
    const service = createCredentialService({
      onDidMutate: (event) => mutations.push(event),
    });
    return await run(service, mutations);
  } finally {
    setDataBaseDir(null);
    await rm(dataBaseDir, { recursive: true, force: true });
  }
}

const KEY = "github:oauth:token_set";

test("deleteIf：谓词为真时删除并返回 true", async () => {
  await withTempCredentialService(async (service, mutations) => {
    const value = JSON.stringify({ accessToken: "gho_old", refreshToken: "ghr_old" });
    await service.save(KEY, value);
    mutations.length = 0;

    const seen: string[] = [];
    const deleted = await service.deleteIf(KEY, (plaintext) => {
      seen.push(plaintext);
      return plaintext === value;
    });

    assert.equal(deleted, true);
    // 谓词收到的是解密后的明文，而不是 cipherProvider 的密文。
    assert.deepEqual(seen, [value]);
    assert.equal(await service.load(KEY), null);
    assert.deepEqual(mutations, [{ operation: "delete", key: KEY }]);
  });
});

test("deleteIf：谓词为假时不删除、返回 false，也不触发变更通知", async () => {
  await withTempCredentialService(async (service, mutations) => {
    const value = JSON.stringify({ accessToken: "gho_new", refreshToken: "ghr_new" });
    await service.save(KEY, value);
    mutations.length = 0;

    const deleted = await service.deleteIf(KEY, (plaintext) => plaintext.includes("gho_old"));

    assert.equal(deleted, false);
    assert.equal(await service.load(KEY), value);
    assert.deepEqual(mutations, []);
  });
});

test("deleteIf：key 不存在时返回 false，且不改动其它凭据", async () => {
  await withTempCredentialService(async (service, mutations) => {
    await service.save("github:oauth:access_token", "gho_legacy");
    mutations.length = 0;

    let predicateCalled = false;
    const deleted = await service.deleteIf(KEY, () => {
      predicateCalled = true;
      return true;
    });

    assert.equal(deleted, false);
    // key 不存在时不需要（也不应该）再解密 / 执行谓词。
    assert.equal(predicateCalled, false);
    assert.equal(await service.load("github:oauth:access_token"), "gho_legacy");
    assert.deepEqual(mutations, []);
  });
});

test("deleteIf：并发调用不会误删其它调用刚写入的新值", async () => {
  await withTempCredentialService(async (service) => {
    const oldValue = JSON.stringify({ accessToken: "gho_old" });
    const newValue = JSON.stringify({ accessToken: "gho_new" });
    await service.save(KEY, oldValue);

    // 一个 deleteIf 断言旧值，另一个并发 save 写入新值（模拟另一个 provider）。
    // 两者串行执行：无论顺序如何，最终结果都必须是「新值存活」。
    const [deleted] = await Promise.all([
      service.deleteIf(KEY, (plaintext) => plaintext === oldValue),
      service.save(KEY, newValue),
    ]);

    const stored = await service.load(KEY);
    // 断言发生在锁内：如果 deleteIf 先执行，会删掉旧值，随后 save 写入新值；
    // 如果 save 先执行，谓词不匹配，不会删除新值。
    assert.equal(stored, newValue);
    assert.equal(typeof deleted, "boolean");
  });
});

test("toRpcCredentialService：RPC 暴露面只有 load/save/delete，不含 deleteIf", async () => {
  await withTempCredentialService(async (service) => {
    const rpc = toRpcCredentialService(service);
    // ProxyChannel.fromService 会把任意函数属性变成可调用方法；注册进 ServiceCollection
    // 的必须是收窄对象，否则 renderer 能调到 host 内部的 compare-and-delete。
    assert.deepEqual(Object.keys(rpc).sort(), ["delete", "load", "save"]);
    assert.equal("deleteIf" in rpc, false);

    await rpc.save(KEY, "gho_value");
    assert.equal(await rpc.load(KEY), "gho_value");
    await rpc.delete(KEY);
    assert.equal(await rpc.load(KEY), null);
  });
});
