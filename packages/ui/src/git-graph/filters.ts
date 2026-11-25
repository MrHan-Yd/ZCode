import { gitCommitGraphFiltersSchema, type GitCommitGraphFilters } from "@zcode/shared";

export type GitGraphDatePreset = "all" | "24h" | "7d" | "30d";
export interface GitGraphFilterDraft {
  text: string;
  regex: boolean;
  caseSensitive: boolean;
  branchRef: string;
  authorKey: string;
  datePreset: GitGraphDatePreset;
}
export const EMPTY_GIT_GRAPH_FILTER_DRAFT: GitGraphFilterDraft = {
  text: "",
  regex: false,
  caseSensitive: false,
  branchRef: "",
  authorKey: "",
  datePreset: "all",
};
export type GitGraphFilterValidation = "invalid-query" | "invalid-regex";

export function gitGraphAuthorKey(author: { name: string; email: string }): string {
  return JSON.stringify([author.name, author.email]);
}

export function readGitGraphAuthorKey(key: string): { name: string; email: string } | null {
  if (!key) return null;
  try {
    const value: unknown = JSON.parse(key);
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === "string" &&
      typeof value[1] === "string"
    ) {
      return { name: value[0], email: value[1] };
    }
  } catch {
    return null;
  }
  return null;
}

export function buildGitGraphFilters(
  draft: GitGraphFilterDraft,
  now: number,
): GitCommitGraphFilters {
  const result: GitCommitGraphFilters = {};
  if (draft.text !== "") {
    result.search = {
      value: draft.text,
      mode: draft.regex ? "regex" : "literal",
      caseSensitive: draft.caseSensitive,
    };
  }
  if (draft.branchRef !== "") result.branchRef = draft.branchRef;
  const author = readGitGraphAuthorKey(draft.authorKey);
  if (author) result.author = author;
  if (draft.datePreset !== "all") {
    const days = draft.datePreset === "24h" ? 1 : draft.datePreset === "7d" ? 7 : 30;
    result.date = { fromMs: now - days * 86_400_000, toMs: now };
  }
  return result;
}

export function validateGitGraphFilters(
  filters: GitCommitGraphFilters,
): GitGraphFilterValidation | null {
  if (!gitCommitGraphFiltersSchema.safeParse(filters).success) return "invalid-query";
  if (filters.search?.mode === "regex") {
    try {
      new RegExp(filters.search.value, filters.search.caseSensitive ? "u" : "iu");
    } catch {
      return "invalid-regex";
    }
  }
  return null;
}

export function hasGitGraphFilters(filters: GitCommitGraphFilters): boolean {
  return Boolean(filters.search || filters.branchRef || filters.author || filters.date);
}
