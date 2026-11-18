const DIRECTORY_GLOB_SUFFIX = "/**";
// 未定义的 glob 必须拒绝；用单次正则扫描代替逐个 token 的多次 includes。
const UNSUPPORTED_GLOB = /[*?[\]{}]/u;
const WORKSPACE_ROOT = "*";
const SEGMENT_SEPARATOR = "/";
const SEGMENT_SEPARATOR_CODE = SEGMENT_SEPARATOR.charCodeAt(0);
const SPACE_CODE = 0x20;
const DOT_CODE = 0x2e;
const PARENT_SEGMENT = "..";
const CURRENT_SEGMENT = ".";
const PRINTABLE_ASCII_MAX = 0x7e;

function stripTrailing(segment: string, code: number): string {
  let end = segment.length;
  while (end > 0 && segment.charCodeAt(end - 1) === code) end -= 1;
  return end === segment.length ? segment : segment.slice(0, end);
}

/** Win32 剥离的是尾随空格与点的混合连续串，不是分两遍各自剥离。 */
function stripTrailingDotsAndSpaces(segment: string): string {
  let end = segment.length;
  while (end > 0) {
    const code = segment.charCodeAt(end - 1);
    if (code !== SPACE_CODE && code !== DOT_CODE) break;
    end -= 1;
  }
  return end === segment.length ? segment : segment.slice(0, end);
}

/**
 * Win32 在解析路径时会剥离每个分量的尾随空格与尾随点，因此 `src.`、`src .`、`src ` 与 `src`
 * 指向同一位置；大小写敏感或不做归一化的系统只会因此多串行，不会漏检并发写。
 * 顺序必须是先剥尾随空格再识别 `.` / `..`：`a/.. /b` 在 Windows 上仍是父目录引用，
 * 而 `src .`、`a/. ./b` 这类混合串必须整体剥到空，否则别名会漏检。
 */
function normalizeSegment(segment: string): string | undefined {
  const withoutTrailingSpaces = stripTrailing(segment, SPACE_CODE);
  if (!withoutTrailingSpaces || withoutTrailingSpaces === CURRENT_SEGMENT) return undefined;
  if (withoutTrailingSpaces === PARENT_SEGMENT) return PARENT_SEGMENT;
  const withoutTrailingMarks = stripTrailingDotsAndSpaces(withoutTrailingSpaces);
  return withoutTrailingMarks || undefined;
}

export function normalizeWriteScope(scope: string): string {
  let normalized = scope.trim();
  if (normalized.includes("\\")) normalized = normalized.replaceAll("\\", SEGMENT_SEPARATOR);
  let end = normalized.length;
  while (end > 0 && normalized.charCodeAt(end - 1) === SEGMENT_SEPARATOR_CODE) end -= 1;
  if (end !== normalized.length) normalized = normalized.slice(0, end);
  if (normalized === WORKSPACE_ROOT || normalized === "**") return WORKSPACE_ROOT;
  if (
    !normalized ||
    normalized.startsWith(SEGMENT_SEPARATOR) ||
    normalized.includes(":") ||
    normalized.includes("\u0000")
  ) {
    throw new Error("writeScope must be a workspace-relative path.");
  }
  if (normalized.endsWith(DIRECTORY_GLOB_SUFFIX))
    normalized = normalized.slice(0, -DIRECTORY_GLOB_SUFFIX.length);
  if (UNSUPPORTED_GLOB.test(normalized)) {
    throw new Error(
      "writeScope only supports a directory suffix /** or the whole-workspace wildcard.",
    );
  }
  const segments: string[] = [];
  for (const rawSegment of normalized.split(SEGMENT_SEPARATOR)) {
    const segment = normalizeSegment(rawSegment);
    if (!segment) continue;
    if (segment === PARENT_SEGMENT) {
      // 字符串前缀不能识别 other/../src 的文件身份；折叠点段，并拒绝越过 workspace 根。
      if (!segments.length) throw new Error("writeScope cannot escape the workspace root.");
      segments.pop();
    } else segments.push(segment);
  }
  if (!segments.length) return WORKSPACE_ROOT;
  const key = segments.join(SEGMENT_SEPARATOR);
  // macOS 默认按 Unicode 归一化比较文件名；不归一化会让 NFC/NFD 同名目录各自通过冲突检测。
  return (hasNonAscii(key) ? key.normalize("NFC") : key).toLowerCase();
}

function hasNonAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) > PRINTABLE_ASCII_MAX) return true;
  }
  return false;
}

export function normalizeWriteScopes(scopes: readonly string[] | undefined): string[] {
  if (!scopes?.length) return [];
  const keys = scopes.map((scope) => `${normalizeWriteScope(scope)}${SEGMENT_SEPARATOR}`);
  if (keys.includes(`${WORKSPACE_ROOT}${SEGMENT_SEPARATOR}`)) return [WORKSPACE_ROOT];
  keys.sort();
  const minimal: string[] = [];
  let previous = "";
  for (const key of keys) {
    if (previous && key.startsWith(previous)) continue;
    minimal.push(key.slice(0, -SEGMENT_SEPARATOR.length));
    previous = key;
  }
  return minimal;
}

/** 两份输入必须来自 normalizeWriteScopes：以带终止分隔符的目录前缀排序。 */
export function normalizedWriteScopesOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (!left.length || !right.length) return false;
  if (left[0] === WORKSPACE_ROOT || right[0] === WORKSPACE_ROOT) return true;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftKey = `${left[leftIndex]}${SEGMENT_SEPARATOR}`;
    const rightKey = `${right[rightIndex]}${SEGMENT_SEPARATOR}`;
    if (leftKey.startsWith(rightKey) || rightKey.startsWith(leftKey)) return true;
    if (leftKey < rightKey) leftIndex += 1;
    else rightIndex += 1;
  }
  return false;
}

export function writeScopesOverlap(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return normalizedWriteScopesOverlap(normalizeWriteScopes(left), normalizeWriteScopes(right));
}
