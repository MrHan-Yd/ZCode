import { z } from "zod";

export const GIT_GRAPH_SEARCH_MAX_LENGTH = 512;
export const GIT_GRAPH_CURSOR_MAX_LENGTH = 65_536;

const safeText = z.string().refine((value) => !value.includes("\0"), "NUL is not allowed");
export const gitCommitGraphFiltersSchema = z
  .object({
    search: z
      .object({
        value: safeText.max(GIT_GRAPH_SEARCH_MAX_LENGTH),
        mode: z.enum(["literal", "regex"]),
        caseSensitive: z.boolean().optional(),
      })
      .strict()
      .optional(),
    branchRef: safeText
      .max(1024)
      .regex(/^refs\/(?:heads|remotes)\/.+/u)
      .optional(),
    author: z
      .object({
        name: safeText.max(1024),
        email: safeText.max(1024),
      })
      .strict()
      .optional(),
    date: z
      .object({
        fromMs: z.number().finite().int().optional(),
        toMs: z.number().finite().int().optional(),
      })
      .strict()
      .refine(
        (value) =>
          value.fromMs === undefined || value.toMs === undefined || value.fromMs < value.toMs,
        "Invalid date range",
      )
      .optional(),
  })
  .strict();

export type GitCommitGraphFilters = z.infer<typeof gitCommitGraphFiltersSchema>;

export const gitCommitGraphQuerySchema = z
  .object({
    workspacePath: safeText.min(1),
    workspaceIdentity: safeText.optional(),
    maxCount: z.number().finite().optional(),
    skip: z.number().finite().optional(),
    filters: gitCommitGraphFiltersSchema.optional(),
    cursor: safeText.min(1).max(GIT_GRAPH_CURSOR_MAX_LENGTH).optional(),
  })
  .strict();

export interface GitCommitGraphFilterBranch {
  ref: string;
  name: string;
  kind: "branch" | "remote";
}
export interface GitCommitGraphAuthor {
  name: string;
  email: string;
}
export interface GitCommitGraphFilterOptions {
  branches: GitCommitGraphFilterBranch[];
  authors: GitCommitGraphAuthor[];
}
export interface GitCommitGraphFilterOptionsRequest {
  workspacePath: string;
  workspaceIdentity?: string;
}

export type GitGraphIssueCode =
  | "invalid-query"
  | "invalid-regex"
  | "invalid-cursor"
  | "branch-not-found"
  | "query-timeout";
