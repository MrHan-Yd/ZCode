/**
 * `MEMORY.md` 索引行的清理规则。
 *
 * 索引每轮注入上下文，指向已删除文件的残留行会直接误导模型，所以删除一条记忆时必须一并清掉。
 * 匹配刻意保守：只认「Markdown 链接目标就是该文件名」的行，其余内容逐字保留。
 * 本模块不含任何运行时依赖，便于单测直接加载。
 */

/** 形如 `[Title](file.md)` 或 `[Title](./file.md)`，允许标题内出现括号以外的内容。 */
const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)\)/u;

export function stripMemoryIndexEntries(content: string, fileName: string): string {
  const lines = content.split("\n");
  const kept = lines.filter((line) => !isIndexEntryForFile(line, fileName));
  if (kept.length === lines.length) {
    return content;
  }

  return kept.join("\n");
}

function isIndexEntryForFile(line: string, fileName: string): boolean {
  const match = MARKDOWN_LINK_PATTERN.exec(line);
  if (!match?.[1]) {
    return false;
  }

  // 索引里既有 `file.md` 也有 `./file.md` 两种写法，都视为同一条目。
  const target = match[1].replace(/^\.\//u, "");
  return target === fileName;
}
