import type { ConfigSyncItem, ConfigSyncProfile } from "../config-sync/types.js";

/**
 * 技能侧的同步语义：条目名 ↔ gist 文件名、文件内容的文本/二进制编码。
 * 通用部分（manifest / 指纹 / 计划 / 密钥扫描 / 回滚）在 `config-sync/` 里。
 *
 * 条目名 = `<技能相对目录>/<文件相对路径>`（统一 `/`）。只有包含 `SKILL.md` 的目录算技能。
 */

export const SKILL_CONFIG_GIST_DESCRIPTION = "zcode-skill-config-sync";
export const SKILL_SYNC_FILE_PREFIX = "skill.";
export const SKILL_SYNC_BINARY_MARKER = "$zcodeSkillSync";

// 技能目录名与文件名都可能含空格、中文；只转义会破坏文件名语义的字符。
// eslint-disable-next-line no-control-regex -- 控制字符正是要转义的对象
const UNSAFE_ITEM_CHARS = /[%\\/\u0000-\u001f\u007f]/gu;

export function encodeSkillSyncItemName(name: string): string {
  return name.replace(UNSAFE_ITEM_CHARS, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `%${code.toString(16).padStart(2, "0")}`;
  });
}

export function decodeSkillSyncItemName(encoded: string): string | null {
  if (!encoded.includes("%")) return encoded;
  try {
    const decoded = decodeURIComponent(encoded);
    // 只有「再编码后与原文完全一致」才算合法，避免把用户手写的 %xx 当成转义。
    return encodeSkillSyncItemName(decoded) === encoded ? decoded : null;
  } catch {
    return null;
  }
}

/** 条目名必须是 skills 根内的相对路径：非空、无空段、无 `.`/`..`、无绝对路径。 */
export function isValidSkillSyncItemName(name: string): boolean {
  if (!name || name.startsWith("/") || name.endsWith("/")) return false;
  if (name.includes("\\") || /^[a-zA-Z]:/u.test(name)) return false;
  const parts = name.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function skillSyncItemFileName(name: string): string | null {
  if (!isValidSkillSyncItemName(name)) return null;
  return `${SKILL_SYNC_FILE_PREFIX}${encodeSkillSyncItemName(name)}`;
}

export function skillSyncItemNameFromFileName(fileName: string): string | null {
  if (!fileName.startsWith(SKILL_SYNC_FILE_PREFIX)) return null;
  const decoded = decodeSkillSyncItemName(fileName.slice(SKILL_SYNC_FILE_PREFIX.length));
  return decoded && isValidSkillSyncItemName(decoded) ? decoded : null;
}

/**
 * 文本文件原样上传；无法按 UTF-8 无损往返（或含 NUL）的文件转成 base64 JSON 封装。
 * 用带魔数键的封装而不是裸 base64，下载侧才能区分「文本」与「二进制」。
 */
export function encodeSkillSyncItemContent(buffer: Buffer): string {
  const text = buffer.toString("utf8");
  const roundTrips = Buffer.from(text, "utf8").equals(buffer);
  if (roundTrips && !text.includes("\u0000")) {
    return text;
  }
  return JSON.stringify({ [SKILL_SYNC_BINARY_MARKER]: "base64", data: buffer.toString("base64") });
}

interface SkillSyncBinaryEnvelope {
  readonly data: string;
}

export function parseSkillSyncBinaryEnvelope(content: string): SkillSyncBinaryEnvelope | null {
  // 只接受恰好两个键的封装，降低「普通文本恰好长这样」被误判的概率。
  if (!content.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
      keys.length !== 2 ||
      !keys.includes(SKILL_SYNC_BINARY_MARKER) ||
      record[SKILL_SYNC_BINARY_MARKER] !== "base64" ||
      typeof record.data !== "string"
    ) {
      return null;
    }
    return { data: record.data };
  } catch {
    return null;
  }
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;

export function decodeSkillSyncItemContent(content: string): Buffer | null {
  const envelope = parseSkillSyncBinaryEnvelope(content);
  if (!envelope) {
    return Buffer.from(content, "utf8");
  }
  if (!BASE64_PATTERN.test(envelope.data)) return null;
  return Buffer.from(envelope.data, "base64");
}

export const SKILL_CONFIG_PROFILE: ConfigSyncProfile = {
  fileNameFor: skillSyncItemFileName,
  nameFromFileName: skillSyncItemNameFromFileName,
  // 文本内容不做额外语义校验；binary 封装必须能解码，避免把坏远端内容写到本地。
  isValidContent: (_fileName, content) =>
    parseSkillSyncBinaryEnvelope(content) === null || decodeSkillSyncItemContent(content) !== null,
  extraFileNames: [],
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
};

/**
 * 应用前校验远端条目：每个技能组都必须有 `SKILL.md`，否则下载会生成一批不被加载器识别的目录。
 * `items` 必须是远端全集（含内容未变的 `same`），不能只看本次变更集。
 */
export function validateSkillSyncGroups(items: readonly ConfigSyncItem[]): string | null {
  const groups = new Map<string, Set<string>>();
  for (const item of items) {
    if (!isValidSkillSyncItemName(item.name)) {
      return item.name;
    }
    const slashIndex = item.name.indexOf("/");
    if (slashIndex <= 0 || slashIndex === item.name.length - 1) {
      return item.name;
    }
    const skillDirectory = item.name.slice(0, slashIndex);
    const relativeFile = item.name.slice(slashIndex + 1);
    const files = groups.get(skillDirectory) ?? new Set<string>();
    files.add(relativeFile);
    groups.set(skillDirectory, files);
  }
  for (const [skillDirectory, files] of groups) {
    if (!files.has("SKILL.md")) {
      return skillDirectory;
    }
  }
  return null;
}
