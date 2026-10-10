import type { ModelSmartConfigEntry } from "@zcode/provider";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 设置页展示用的模型智能配置视图；默认来自本地文件，仅在手动同步时更新。 */
export interface ModelSmartConfigView {
  /** 本地规则文件绝对路径。 */
  readonly filePath: string;
  /** 固定的远端同步地址（只读展示）。 */
  readonly remoteUrl: string;
  /** 本地文件内容指纹；文件不存在时为 "absent"。 */
  readonly revision: string;
  readonly present: boolean;
  /** 本地文件读取或校验失败说明；缺失文件不算错误。 */
  readonly error: string | null;
  readonly entries: readonly ModelSmartConfigEntry[];
}

export interface IModelSmartConfigService {
  /** 只读本地文件，不发起任何网络请求。 */
  read(): Promise<ModelSmartConfigView>;
  /** 拉取远端并覆盖本地文件；失败时本地文件保持不变。 */
  syncFromRemote(): Promise<ModelSmartConfigView>;
}

export const IModelSmartConfigService = createServiceDescriptor<IModelSmartConfigService>(
  ServiceChannels.ModelSmartConfig,
);

export type { ModelSmartConfigEntry };
