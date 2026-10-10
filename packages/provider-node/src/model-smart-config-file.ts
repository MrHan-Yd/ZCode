import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  ModelConfigRules,
  modelSmartConfigFileSchema,
  parseModelSmartConfigRules,
  type ModelSmartConfigFile,
} from "@zcode/provider";

export interface ModelSmartConfigFileState {
  /** 内容指纹；文件不存在时固定为 "absent"，用于让上层 revision 随内容变化。 */
  readonly revision: string;
  readonly present: boolean;
  readonly file: ModelSmartConfigFile | null;
  readonly rules: ModelConfigRules;
  /** 读取或校验失败的说明；缺失文件不算错误。 */
  readonly error: string | null;
}

const ABSENT_STATE: ModelSmartConfigFileState = Object.freeze({
  revision: "absent",
  present: false,
  file: null,
  rules: ModelConfigRules.empty(),
  error: null,
});

/**
 * 每次调用都重新读盘：默认读本地，写入方（同步服务）覆盖文件后下一次读取即可生效。
 * 文件缺失或损坏都不抛错——坏数据只等于「没有同步规则」，不能阻断 Host 启动。
 */
export async function readModelSmartConfigFileState(
  filePath: string,
): Promise<ModelSmartConfigFileState> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return ABSENT_STATE;
    return Object.freeze({
      ...ABSENT_STATE,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const revision = createHash("sha256").update(raw).digest("hex");
  try {
    const file = modelSmartConfigFileSchema.parse(JSON.parse(raw));
    return Object.freeze({
      revision,
      present: true,
      file,
      rules: parseModelSmartConfigRules(file),
      error: null,
    });
  } catch (error) {
    return Object.freeze({
      revision,
      present: true,
      file: null,
      rules: ModelConfigRules.empty(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
