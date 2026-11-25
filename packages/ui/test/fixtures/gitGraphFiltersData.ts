import {
  buildRemoteWorkspaceIdentity,
  type GitCommitGraphCommit,
  type GitCommitGraphFilterOptions,
  type GitRepositorySummary,
} from "@zcode/shared";

export const GRAPH_PATH = "/synthetic/git-graph-filters";
export const GRAPH_NOW = Date.UTC(2026, 10, 25, 12);
export const GRAPH_DAY = 86_400_000;
export const GRAPH_IDENTITIES = ["first", "second"].map((host) =>
  buildRemoteWorkspaceIdentity(GRAPH_PATH, {
    kind: "ssh",
    host: `${host}.fixture.invalid`,
    username: "fixture",
  }),
);
export const GRAPH_OPTIONS: GitCommitGraphFilterOptions = {
  branches: [
    { ref: "refs/heads/main", name: "main", kind: "branch" },
    { ref: "refs/heads/feature/one", name: "feature/one", kind: "branch" },
    { ref: "refs/remotes/origin/main", name: "origin/main", kind: "remote" },
  ],
  authors: [
    { name: "Alex", email: "alex.one@example.test" },
    { name: "Alex", email: "alex.two@example.test" },
    { name: "Mina", email: "mina@example.test" },
  ],
};

interface SyntheticCommit extends GitCommitGraphCommit {
  body: string;
  branchRefs: string[];
}
const hashAt = (index: number) =>
  index === 2
    ? "abcdef1234567890abcdef1234567890abcdef1234"
    : (4_096 + index).toString(16).padEnd(40, "0");
const boundaryTimes = [
  GRAPH_NOW,
  GRAPH_NOW - GRAPH_DAY,
  GRAPH_NOW - GRAPH_DAY - 1,
  GRAPH_NOW - 7 * GRAPH_DAY,
  GRAPH_NOW - 7 * GRAPH_DAY - 1,
  GRAPH_NOW - 30 * GRAPH_DAY,
  GRAPH_NOW - 30 * GRAPH_DAY - 1,
];

export const GRAPH_HISTORY: SyntheticCommit[] = Array.from({ length: 260 }, (_, index) => {
  const author = GRAPH_OPTIONS.authors[index % GRAPH_OPTIONS.authors.length]!;
  return {
    hash: hashAt(index),
    parents: index < 259 ? [hashAt(index + 1)] : [],
    refs: index === 0 ? [{ name: "main", kind: "branch" }] : [],
    subject:
      index === 0
        ? "Literal a.b [keep]"
        : index === 1
          ? "literal axb [KEEP]"
          : index >= 60
            ? `Deep Needle commit ${index}`
            : `History commit ${index}`,
    authorName: author.name,
    authorEmail: author.email,
    authoredAtMs: boundaryTimes[index] ?? GRAPH_NOW - (index % 40) * GRAPH_DAY - 3_600_000,
    body: index === 3 ? "Hidden paragraph body-only-token" : "Synthetic commit body",
    branchRefs: [
      "refs/heads/main",
      "refs/remotes/origin/main",
      ...(index >= 60 ? ["refs/heads/feature/one"] : []),
    ],
  };
});

export function graphSummary(detached = false): GitRepositorySummary {
  return {
    workspacePath: GRAPH_PATH,
    repoRoot: GRAPH_PATH,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: detached ? null : "main",
    trackingBranchName: null,
    headRefType: detached ? "detached" : "branch",
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: true,
    isRepository: true,
  };
}

export function graphCommit(subject: string): GitCommitGraphCommit {
  return { ...GRAPH_HISTORY[0]!, subject, refs: [], parents: [] };
}
