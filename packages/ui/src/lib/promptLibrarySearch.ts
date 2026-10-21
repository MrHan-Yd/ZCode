import type { PromptTemplateSummary } from "@zcode/shared";

export function normalizePromptLibrarySearchText(value: string): string {
  // NFKC 让全角字母/数字与半角输入可以互相匹配，大小写不敏感。
  return value.normalize("NFKC").toLowerCase();
}

/**
 * 相关性：别名精确匹配 > 名称前缀 > 名称子串 > 标签子串 > 内容子串。
 * 返回 null 表示不匹配。
 */
export function scorePromptTemplate(item: PromptTemplateSummary, query: string): number | null {
  const normalizedQuery = normalizePromptLibrarySearchText(query.trim());
  if (!normalizedQuery) {
    return 0;
  }

  const alias = item.alias ? normalizePromptLibrarySearchText(item.alias) : "";
  if (alias === normalizedQuery) {
    return 0;
  }

  const title = normalizePromptLibrarySearchText(item.title);
  if (title.startsWith(normalizedQuery)) {
    return 100 + title.length - normalizedQuery.length;
  }
  const titleIndex = title.indexOf(normalizedQuery);
  if (titleIndex >= 0) {
    return 200 + titleIndex;
  }

  const tagIndex = item.tags
    .map((tag) => normalizePromptLibrarySearchText(tag).indexOf(normalizedQuery))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (tagIndex !== undefined) {
    return 300 + tagIndex;
  }

  const contentIndex = normalizePromptLibrarySearchText(item.contentPreview).indexOf(
    normalizedQuery,
  );
  if (contentIndex >= 0) {
    return 400 + contentIndex;
  }

  return null;
}

function compareSearchMatches(
  left: PromptTemplateSummary,
  right: PromptTemplateSummary,
  scoreById: ReadonlyMap<string, number>,
): number {
  const leftScore = scoreById.get(left.id) ?? Number.POSITIVE_INFINITY;
  const rightScore = scoreById.get(right.id) ?? Number.POSITIVE_INFINITY;
  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }
  // 同分时置顶优先，再按最近使用时间。
  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1;
  }
  return (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0);
}

/** 过滤名称/内容/标签/别名；有 query 时按相关性排序。 */
export function filterPromptTemplates(
  items: readonly PromptTemplateSummary[],
  query: string,
): PromptTemplateSummary[] {
  if (!query.trim()) {
    return [...items];
  }

  const scoreById = new Map<string, number>();
  for (const item of items) {
    const score = scorePromptTemplate(item, query);
    if (score !== null) {
      scoreById.set(item.id, score);
    }
  }

  return items
    .filter((item) => scoreById.has(item.id))
    .sort((left, right) => compareSearchMatches(left, right, scoreById));
}
