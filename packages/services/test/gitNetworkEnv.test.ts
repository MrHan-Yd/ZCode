import assert from "node:assert/strict";
import test from "node:test";
import { createGitEnvironmentProvider } from "../src/git/providers/gitEnvironmentProvider.js";
import { buildGitNetworkEnv } from "../src/runtime-tools/agentProxyEnv.js";

// 背景：host 启动时会把 HTTP(S)_PROXY 从 process.env 剥离，只有 Bash/tool 子进程恢复。
// git 是 host 自己 spawn 的子进程，必须显式拿到设置页代理，否则 push/pull 直连被重置。
// 规范见 specs/git-network-proxy.md。

test("设置页留空时不注入任何代理键", () => {
  assert.deepEqual(buildGitNetworkEnv({ httpProxy: undefined }), {});
  assert.deepEqual(buildGitNetworkEnv({ httpProxy: "   " }), {});
});

test("裸 host:port 补 http://，已带 scheme 的地址原样保留", () => {
  const bare = buildGitNetworkEnv({ httpProxy: " 127.0.0.1:7890 " });
  assert.equal(bare.HTTP_PROXY, "http://127.0.0.1:7890");
  assert.equal(bare.HTTPS_PROXY, "http://127.0.0.1:7890");
  assert.equal(bare.ALL_PROXY, "http://127.0.0.1:7890");

  const withScheme = buildGitNetworkEnv({ httpProxy: "socks5://127.0.0.1:1080" });
  assert.equal(withScheme.HTTPS_PROXY, "socks5://127.0.0.1:1080");
});

test("noProxy 按逗号归一化，代理证书下发为 GIT_SSL_CAINFO", () => {
  const env = buildGitNetworkEnv({
    httpProxy: "127.0.0.1:7890",
    noProxy: " localhost, .example.com ,",
    caCertPath: " C:/certs/proxy-ca.pem ",
  });
  assert.equal(env.NO_PROXY, "localhost,.example.com");
  assert.equal(env.GIT_SSL_CAINFO, "C:/certs/proxy-ca.pem");
});

test("设置页代理覆盖继承来的同名环境变量", async () => {
  const previous = process.env.HTTPS_PROXY;
  process.env.HTTPS_PROXY = "http://from-shell:1";
  try {
    const provider = createGitEnvironmentProvider({
      networkEnv: async () => ({ HTTPS_PROXY: "http://from-settings:7890" }),
    });
    const env = await provider.createCommandEnv();
    assert.equal(env.HTTPS_PROXY, "http://from-settings:7890");
  } finally {
    if (previous === undefined) {
      delete process.env.HTTPS_PROXY;
    } else {
      process.env.HTTPS_PROXY = previous;
    }
  }
});

test("没有网络环境注入时保持原样，且 local env 仍被清理", async () => {
  const previousGitDir = process.env.GIT_DIR;
  process.env.GIT_DIR = "C:/elsewhere/.git";
  try {
    const provider = createGitEnvironmentProvider();
    const env = await provider.createCommandEnv();
    assert.equal(env.GIT_DIR, undefined);
    assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  } finally {
    if (previousGitDir === undefined) {
      delete process.env.GIT_DIR;
    } else {
      process.env.GIT_DIR = previousGitDir;
    }
  }
});
