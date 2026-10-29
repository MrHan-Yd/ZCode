import { spawn } from "node:child_process";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  DEFAULT_GIT_DISCOVERY_TIMEOUT_MS,
  getGitBinaryCandidates,
  getGitCommandEnv,
} from "../config.js";

const log = createServiceLogger("git-env");

export interface GitEnvironmentProvider {
  resolveGitBinary(): Promise<string | null>;
  /**
   * 异步是刻意的：网络环境（设置页代理）由 host 侧惰性解析后注入，
   * 同步签名会迫使调用方在构造期就固定代理值。
   */
  createCommandEnv(): Promise<NodeJS.ProcessEnv>;
}

async function canExecuteGitCandidate(candidate: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn(candidate, ["--version"], {
      env,
      stdio: "ignore",
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, DEFAULT_GIT_DISCOVERY_TIMEOUT_MS);

    child.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

export function createGitEnvironmentProvider(options?: {
  /** host 下发的网络环境（设置页代理）；缺省时 git 只继承已清洗的进程环境，即直连。 */
  networkEnv?: () => Promise<Record<string, string>>;
}): GitEnvironmentProvider {
  let cachedGitBinaryPromise: Promise<string | null> | null = null;

  return {
    async resolveGitBinary(): Promise<string | null> {
      if (cachedGitBinaryPromise) {
        return await cachedGitBinaryPromise;
      }

      const env = getGitCommandEnv();
      // Git binary 的探测在一次会话里不会频繁变化，
      // 这里缓存第一次探测结果，避免每个 Git RPC 都重复打一遍 `git --version`。
      cachedGitBinaryPromise = (async () => {
        const candidates = getGitBinaryCandidates();
        for (const candidate of candidates) {
          if (await canExecuteGitCandidate(candidate, env)) {
            return candidate;
          }
        }
        // Git 二进制解析失败会让整块 Git 工具从 UI 消失（isGitAvailable=false），
        // 过去这里静默返回 null，用户和日志都没有任何线索。
        log.warn(undefined, "未找到可用的 git 二进制，Git 工具将对该环境不可用", {
          candidates,
          gitBinaryOverride: env.ZCODE_GIT_BINARY ?? null,
        });
        return null;
      })();

      return await cachedGitBinaryPromise;
    },

    async createCommandEnv(): Promise<NodeJS.ProcessEnv> {
      return getGitCommandEnv(options?.networkEnv ? await options.networkEnv() : undefined);
    },
  };
}
