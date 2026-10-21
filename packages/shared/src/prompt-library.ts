/**
 * 提示词库数据模型（browser-safe）。
 *
 * 唯一数据所有者是 Host 侧 PromptLibrary 服务；UI 只消费这些类型与排序/摘要工具，
 * 不自行拼接文件路径或维护第二份状态。
 */

export interface PromptTemplate {
  /** Host 生成，格式 `pl_<uuid>`；客户端提交的 id 一律忽略。 */
  id: string;
  /** 1..60，去首尾空白。 */
  title: string;
  /** 1..8000，保留换行；CRLF 在写入前归一为 LF。 */
  content: string;
  /** 0..5 项，每项 1..20。 */
  tags: string[];
  /** 可选，`[a-z0-9_-]{1,24}`；大小写不敏感唯一。 */
  alias?: string;
  pinned: boolean;
  /** epoch ms。 */
  lastUsedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PromptTemplateSummary extends Omit<PromptTemplate, "content"> {
  /** 正文前 200 字，换行压成空格。 */
  contentPreview: string;
}

export interface PromptLibraryFileV1 {
  version: 1;
  updatedAt: number;
  items: PromptTemplate[];
}

export interface PromptTemplateInput {
  title: string;
  content: string;
  tags?: string[];
  alias?: string;
}

/**
 * 服务读取时的降级提示。
 *
 * 放在 shared 是因为设置页与输入框面板都直接消费它；服务契约原样复用同一类型，
 * 避免 Host 返回与 UI 展示各维护一份结构。
 */
export interface PromptLibraryWarning {
  code: "corrupt-recovered" | "corrupt-quarantined" | "unsupported-version";
  message: string;
  quarantinePath?: string;
  version?: number;
}

export const PROMPT_LIBRARY_LIMITS = {
  maxItems: 500,
  maxTitleLength: 60,
  maxContentLength: 8000,
  maxTags: 5,
  maxTagLength: 20,
  maxAliasLength: 24,
  maxFileBytes: 8 * 1024 * 1024,
} as const;

/** 排序偏好属于视图状态（localStorage），不写入记录。 */
export type PromptTemplateSortMode = "recentUsed" | "recentUpdated" | "name";

const CONTENT_PREVIEW_LENGTH = 200;

/** 正文摘要：先取前 200 字，再把换行折叠为空格。 */
export function createPromptTemplatePreview(content: string): string {
  return content.slice(0, CONTENT_PREVIEW_LENGTH).replace(/\r\n|\r|\n/g, " ");
}

export function toPromptTemplateSummary(template: PromptTemplate): PromptTemplateSummary {
  const { content, ...rest } = template;
  return {
    ...rest,
    contentPreview: createPromptTemplatePreview(content),
  };
}

function compareDescendingNullable(left: number | undefined, right: number | undefined): number {
  // 未使用（undefined）排在已使用之后；两者都未使用时交给 id 兜底，保证稳定。
  if (left === right) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right - left;
}

/**
 * 稳定排序比较函数：pinned 优先，其次按视图排序模式，最后用 id 兜底。
 *
 * 所有模式都以 id 作为最终 tie-breaker，确保同一毫秒内的多条记录在多次渲染中顺序一致。
 */
export function comparePromptTemplates(
  left: PromptTemplate | PromptTemplateSummary,
  right: PromptTemplate | PromptTemplateSummary,
  mode: PromptTemplateSortMode = "recentUsed",
): number {
  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1;
  }

  let result = 0;
  switch (mode) {
    case "recentUsed":
      result = compareDescendingNullable(left.lastUsedAt, right.lastUsedAt);
      break;
    case "recentUpdated":
      result = right.updatedAt - left.updatedAt;
      break;
    case "name":
      result = left.title.localeCompare(right.title);
      break;
  }

  if (result !== 0) return result;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}
