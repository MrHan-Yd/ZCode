import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { atomicWritePrivateTextFile, backupCorruptFile, withFileLock } from "@zcode/shared/node";
import {
  credentialKeySchema,
  credentialRecordSchema,
  credentialValueSchema,
  formatZodError,
} from "@zcode/shared";
import type { ICredentialService } from "./credential.js";
import {
  createCredentialCipherProvider,
  type CredentialCipherProvider,
} from "./providers/credentialCipherProvider.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";

/**
 * 凭据存储路径
 *
 * 当前持久化格式仍是 JSON，但 value 会在写入前加密，读取时自动解密。
 * 后续可切换到 Electron safeStorage（钥匙串）托管密钥，
 * 届时 host process 需要向 main 进程请求 encrypt/decrypt。
 */
const logger = createServiceLogger("credentialService");

function getCredentialsDir() {
  return getAppConfigDir();
}

function getCredentialsFile() {
  return join(getCredentialsDir(), "credentials.json");
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function readAll(credentialsFile = getCredentialsFile()): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(credentialsFile, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    throw new Error(`Unable to read ZCode credentials: ${credentialsFile}`, { cause: error });
  }

  try {
    const rawValue = JSON.parse(raw);
    const result = credentialRecordSchema.safeParse(rawValue);
    if (!result.success) {
      throw new Error(formatZodError(result.error));
    }
    return result.data;
  } catch (error) {
    // 把损坏 JSON/schema 当成空 store 后继续 save 会清空其他 OAuth 与登录凭据。
    // 保留损坏文件证据并向上传递错误，禁止自动覆盖。
    const backupPath = await backupCorruptFile(credentialsFile).catch(() => undefined);
    // 服务层日志必须统一经过分级 logger，确保生产环境的损坏凭据告警
    // 进入相同的落盘/采集策略，同时不记录凭据内容。
    logger.warn(undefined, "read failed; refusing to overwrite corrupt credential store", {
      backupPath,
      credentialsFile,
    });
    throw new Error(`ZCode credentials are corrupt: ${credentialsFile}`, { cause: error });
  }
}

async function writeAll(credentialsFile: string, data: Record<string, string>): Promise<void> {
  // 凭据路径之前在模块加载时就绑定到 homedir()，
  // Windows 测试里即使切换 HOME 也会继续写真实用户目录，导致隔离失效。
  await atomicWritePrivateTextFile(credentialsFile, `${JSON.stringify(data, null, 2)}\n`);
}

interface CredentialServiceDependencies {
  cipherProvider?: CredentialCipherProvider;
  /** Host 私有的持久化成功通知；不进入 Renderer/RPC 凭据接口。 */
  onDidMutate?: (event: { operation: "save" | "delete"; key: string }) => void;
}

/**
 * Host 内部凭据服务：在 RPC 契约之外额外提供 `deleteIf`。
 *
 * **不要**把它加进 `ICredentialService`：那会让 renderer 通过 RPC 获得条件删除能力。
 */
export interface ICredentialServiceHost extends ICredentialService {
  /**
   * compare-and-delete：在同一个 credentials 文件锁内读取 → 解密 → 执行 predicate →
   * 为真才删除并原子写回，返回是否真的删除。
   *
   * 存在的理由是并发安全：锁外「读旧值 → 别的 provider / Host 写入新值 → 直接 delete」
   * 会误删刚轮换出的新凭据（丢更新）。key 不存在时返回 false。
   */
  deleteIf(key: string, predicate: (plaintext: string) => boolean): Promise<boolean>;
}

export function createCredentialService(
  dependencies: CredentialServiceDependencies = {},
): ICredentialServiceHost {
  const cipherProvider = dependencies.cipherProvider ?? createCredentialCipherProvider();

  return {
    async load(key: string): Promise<string | null> {
      const validatedKey = credentialKeySchema.parse(key);
      const creds = await readAll();
      const rawValue = creds[validatedKey];
      if (rawValue === undefined) {
        return null;
      }

      return cipherProvider.decrypt(rawValue);
    },

    async save(key: string, value: string): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      const validatedValue = credentialValueSchema.parse(value);
      const encryptedValue = cipherProvider.encrypt(validatedValue);
      const credentialsFile = getCredentialsFile();
      // desktop host 与 CLI adapter 是独立进程，进程内排队不能阻止 whole-file
      // read-modify-write 丢更新；共享目录锁必须覆盖读取、变更和原子替换全过程。
      await withFileLock(credentialsFile, async () => {
        const creds = await readAll(credentialsFile);
        creds[validatedKey] = encryptedValue;
        await writeAll(credentialsFile, creds);
      });
      dependencies.onDidMutate?.({ operation: "save", key: validatedKey });
    },

    async delete(key: string): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      const credentialsFile = getCredentialsFile();
      await withFileLock(credentialsFile, async () => {
        const creds = await readAll(credentialsFile);
        delete creds[validatedKey];
        await writeAll(credentialsFile, creds);
      });
      dependencies.onDidMutate?.({ operation: "delete", key: validatedKey });
    },

    async deleteIf(key: string, predicate: (plaintext: string) => boolean): Promise<boolean> {
      const validatedKey = credentialKeySchema.parse(key);
      const credentialsFile = getCredentialsFile();
      let deleted = false;
      // 读取、解密、断言与写回必须同处一把文件锁内：跨进程 / 多 Host 共享同一文件，
      // 锁外断言后直接 delete 会把别人刚写入的新值删掉。
      await withFileLock(credentialsFile, async () => {
        const creds = await readAll(credentialsFile);
        const rawValue = creds[validatedKey];
        if (rawValue === undefined) {
          return;
        }
        const plaintext = cipherProvider.decrypt(rawValue);
        if (!predicate(plaintext)) {
          return;
        }
        delete creds[validatedKey];
        await writeAll(credentialsFile, creds);
        deleted = true;
      });
      if (deleted) {
        dependencies.onDidMutate?.({ operation: "delete", key: validatedKey });
      }
      return deleted;
    },
  };
}

/**
 * 收窄到 RPC 契约后再注册进 `ServiceCollection`。
 *
 * `ServiceCollection.exposeOnChannelServer` 用 `ProxyChannel.fromService` 包装实例，
 * 而它把对象上的**任意函数属性**都当成可调用方法。若直接注册带 `deleteIf` 的 host 对象，
 * 等于把条件删除能力暴露给 renderer。这里只透出 `ICredentialService` 的三个方法。
 */
export function toRpcCredentialService(service: ICredentialServiceHost): ICredentialService {
  return {
    load: (key) => service.load(key),
    save: (key, value) => service.save(key, value),
    delete: (key) => service.delete(key),
  };
}
