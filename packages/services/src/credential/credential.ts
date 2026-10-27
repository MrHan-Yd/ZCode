import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 凭据管理服务
 *
 * 提供 key-value 形式的凭据读写。
 * 实现端（host process）负责加密存储细节，
 * 消费端（renderer）只通过 RPC 调用，不感知存储位置。
 */
export interface ICredentialService {
  load(key: string): Promise<string | null>;
  save(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Host 内部凭据端口：在 RPC 契约（load / save / delete）之外，额外暴露可选的
 * `deleteIf` compare-and-delete 原语。
 *
 * `deleteIf` 只在 host 进程内使用，**不进 RPC 接口**（renderer 不可见）。
 * 类型上保持可选：测试 fake 或不具备该能力的注入不必实现，调用方必须走保守路径（不删除）。
 */
export type CredentialServiceAccess = Pick<ICredentialService, "load" | "save" | "delete"> & {
  readonly deleteIf?: (key: string, predicate: (plaintext: string) => boolean) => Promise<boolean>;
};

export const ICredentialService = createServiceDescriptor<ICredentialService>(
  ServiceChannels.Credential,
);
