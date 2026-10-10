import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  mergeModelSmartConfigFiles,
  modelSmartConfigFileSchema,
  modelSmartConfigManifestSchema,
  type ModelSmartConfigFile,
} from "@zcode/provider";
import {
  MODEL_SMART_CONFIG_FILE_NAME,
  readModelSmartConfigFileState,
} from "@zcode/provider-node";
import { getAppConfigDir } from "../paths.js";
import { atomicWriteText } from "../fs/atomicFileUtils.js";
import type { IModelSmartConfigService, ModelSmartConfigView } from "./modelSmartConfig.js";

/** 公开 gist 的 raw 根与入口清单：分片文件名相对根解析，始终取最新 revision。 */
const MODEL_SMART_CONFIG_RAW_BASE =
  "https://gist.githubusercontent.com/MrHan-Yd/23347ceed833b414bd96e507facce432/raw/";
const MODEL_SMART_CONFIG_INDEX_URL = `${MODEL_SMART_CONFIG_RAW_BASE}index.json`;

const SYNC_TIMEOUT_MS = 20_000;
const MAX_PART_BYTES = 1_000_000;
const MAX_TOTAL_BYTES = 4_000_000;

/**
 * 模型智能配置的本地事实源 + 手动远端同步。默认只读本地，`syncFromRemote` 才会联网：
 * 先取入口清单，再按清单逐个拉取厂商分片，合并成单份本地文件。任一步失败都保持本地文件不变。
 */
export function createModelSmartConfigService(
  options: {
    readonly filePath?: string;
    readonly indexUrl?: string;
    readonly fetchImpl?: typeof fetch;
  } = {},
): IModelSmartConfigService {
  const filePath =
    options.filePath?.trim() || join(getAppConfigDir(), MODEL_SMART_CONFIG_FILE_NAME);
  const indexUrl = options.indexUrl?.trim() || MODEL_SMART_CONFIG_INDEX_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const read = async (): Promise<ModelSmartConfigView> => {
    const state = await readModelSmartConfigFileState(filePath);
    return {
      filePath,
      remoteUrl: indexUrl,
      revision: state.revision,
      present: state.present,
      error: state.error,
      entries: state.file?.models ?? [],
    };
  };

  const syncFromRemote = async (): Promise<ModelSmartConfigView> => {
    const merged = await fetchRemoteConfig(fetchImpl, indexUrl);
    await mkdir(dirname(filePath), { recursive: true });
    await atomicWriteText(filePath, `${JSON.stringify(merged, null, 2)}\n`);
    return read();
  };

  return { read, syncFromRemote };
}

async function fetchRemoteConfig(
  fetchImpl: typeof fetch,
  indexUrl: string,
): Promise<ModelSmartConfigFile> {
  const manifest = parseJson(
    await fetchText(fetchImpl, indexUrl, MAX_PART_BYTES),
    modelSmartConfigManifestSchema,
    "index.json",
  );
  let totalBytes = 0;
  const parts: ModelSmartConfigFile[] = [];
  for (const name of manifest.files) {
    const url = new URL(name, indexUrl).toString();
    const text = await fetchText(fetchImpl, url, MAX_PART_BYTES);
    totalBytes += text.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("远端同步失败：合并内容超过大小上限");
    parts.push(parseJson(text, modelSmartConfigFileSchema, name));
  }
  return mergeModelSmartConfigFiles(parts);
}

async function fetchText(fetchImpl: typeof fetch, url: string, maxBytes: number): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`远端同步失败：${describeError(error)}`);
  }
  if (!response.ok) throw new Error(`远端同步失败：HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > maxBytes) throw new Error("远端同步失败：内容超过大小上限");
  return text;
}

function parseJson<T>(text: string, schema: { parse: (value: unknown) => T }, source: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`远端同步失败：${source} 不是合法 JSON`);
  }
  try {
    return schema.parse(parsed);
  } catch (error) {
    const message = error instanceof Error ? error.message : "格式不符";
    throw new Error(`远端同步失败：${source} 格式不符（${firstLine(message)}）`);
  }
}

function firstLine(message: string): string {
  const line = message.split("\n")[0] ?? message;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "TimeoutError" ? "请求超时" : error.message;
  }
  return String(error);
}
