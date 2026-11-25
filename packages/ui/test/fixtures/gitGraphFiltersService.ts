import type { IGitService } from "@zcode/services";
import type {
  GitCommitGraphFilterOptions,
  GitCommitGraphFilterOptionsRequest,
  GitCommitGraphRequest,
  GitCommitGraphResult,
  GitRefreshResult,
} from "@zcode/shared";
import { GRAPH_HISTORY, GRAPH_OPTIONS, graphSummary } from "./gitGraphFiltersData.js";

export interface GraphRequestRecord {
  id: number;
  request: GitCommitGraphRequest;
  at: number;
  status: "pending" | "completed" | "failed";
}
interface OptionsRecord {
  id: number;
  request: GitCommitGraphFilterOptionsRequest;
  status: "pending" | "completed";
}
export interface GitGraphFiltersControl {
  requests: GraphRequestRecord[];
  optionRequests: OptionsRecord[];
  forbidden: string[];
  holdNext: (kind?: "graph" | "options") => void;
  release: (id: number, result?: GitCommitGraphResult) => void;
  reject: (id: number, message: string) => void;
  releaseOptions: (id: number) => void;
  setOptions: (options: GitCommitGraphFilterOptions) => void;
  setScope: (identity?: string, replaceService?: boolean) => void;
  closeTools: () => void;
}
declare global {
  interface Window {
    __gitGraphFiltersTest: GitGraphFiltersControl;
  }
}
interface HeldGraph {
  result: GitCommitGraphResult;
  resolve: (result: GitCommitGraphResult) => void;
  reject: (error: Error) => void;
}

export function createGitGraphFiltersService(detached: boolean, legacy: boolean, empty: boolean) {
  const requests: GraphRequestRecord[] = [];
  const optionRequests: OptionsRecord[] = [];
  const forbidden: string[] = [];
  const held = new Map<number, HeldGraph>();
  const heldOptions = new Map<number, () => void>();
  const cursors = new Map<string, { fingerprint: string; offset: number }>();
  let nextId = 1;
  let graphHolds = 0;
  let optionsHolds = 0;
  let currentOptions = structuredClone(GRAPH_OPTIONS);
  const summary = graphSummary(detached);
  const deny = (name: string) => () => {
    forbidden.push(name);
    throw new Error(`fixture.readOnly.${name}`);
  };
  const refresh = async (): Promise<GitRefreshResult> => ({
    summary,
    identity: null,
    stagedChanges: [],
    unstagedChanges: [],
    branchComparison: null,
  });
  const query = (input: GitCommitGraphRequest): GitCommitGraphResult => {
    const filters = input.filters ?? {};
    const search = filters.search;
    const regex =
      search?.mode === "regex" ? new RegExp(search.value, search.caseSensitive ? "u" : "iu") : null;
    const matchesText = (value: string) => {
      if (!search?.value) return true;
      if (regex) return regex.test(value);
      return search.caseSensitive
        ? value.includes(search.value)
        : value.toLocaleLowerCase().includes(search.value.toLocaleLowerCase());
    };
    const matching = (empty ? [] : GRAPH_HISTORY).filter((commit) => {
      if (filters.branchRef && !commit.branchRefs.includes(filters.branchRef)) return false;
      if (
        filters.author &&
        (commit.authorName !== filters.author.name || commit.authorEmail !== filters.author.email)
      )
        return false;
      if (filters.date?.fromMs !== undefined && commit.authoredAtMs! < filters.date.fromMs)
        return false;
      if (filters.date?.toMs !== undefined && commit.authoredAtMs! >= filters.date.toMs)
        return false;
      return !search?.value || [commit.subject, commit.body, commit.hash].some(matchesText);
    });
    const fingerprint = JSON.stringify([input.workspacePath, input.workspaceIdentity, filters]);
    const cursor = input.cursor ? cursors.get(input.cursor) : undefined;
    if (input.cursor && (!cursor || cursor.fingerprint !== fingerprint))
      throw new Error("fixture.invalidCursor");
    const offset = cursor?.offset ?? input.skip ?? 0;
    const pageSize = input.maxCount ?? 50;
    const commits = matching
      .slice(offset, offset + pageSize)
      .map(({ body: _body, branchRefs: _branches, ...commit }) => commit);
    const hasMore = offset + commits.length < matching.length;
    let nextCursor: string | undefined;
    if (hasMore && !legacy) {
      nextCursor = `fixture-cursor-${cursors.size + 1}`;
      cursors.set(nextCursor, { fingerprint, offset: offset + commits.length });
    }
    return { commits, hasMore, ...(nextCursor ? { cursor: nextCursor } : {}) };
  };

  const makeGitService = () =>
    ({
      async getCommitGraph(input: GitCommitGraphRequest) {
        const record: GraphRequestRecord = {
          id: nextId++,
          request: structuredClone(input),
          at: Date.now(),
          status: "pending",
        };
        requests.push(record);
        const shouldHold = graphHolds > 0;
        if (shouldHold) graphHolds -= 1;
        try {
          const result = query(input);
          const response = shouldHold
            ? await new Promise<GitCommitGraphResult>((resolve, reject) =>
                held.set(record.id, { result, resolve, reject }),
              )
            : result;
          record.status = "completed";
          return response;
        } catch (error) {
          record.status = "failed";
          throw error;
        }
      },
      async getCommitGraphFilterOptions(
        input: GitCommitGraphFilterOptionsRequest,
      ): Promise<GitCommitGraphFilterOptions> {
        const record: OptionsRecord = {
          id: nextId++,
          request: structuredClone(input),
          status: "pending",
        };
        optionRequests.push(record);
        if (optionsHolds > 0) {
          optionsHolds -= 1;
          await new Promise<void>((resolve) => heldOptions.set(record.id, resolve));
        }
        record.status = "completed";
        return structuredClone(currentOptions);
      },
      async getLocalBranches() {
        return {
          headRefType: summary.headRefType,
          currentBranchName: summary.branchName,
          branches: GRAPH_OPTIONS.branches
            .filter((branch) => branch.kind === "branch")
            .map((branch) => ({
              name: branch.name,
              isCurrent: branch.name === summary.branchName,
              upstreamName: null,
              commitHash: GRAPH_HISTORY[0]!.hash,
              commitTimestampMs: GRAPH_HISTORY[0]!.authoredAtMs,
            })),
        };
      },
      async getRepositorySummary() {
        return summary;
      },
      async getChanges() {
        return [];
      },
      refresh,
      switchBranch: deny("switchBranch"),
      createBranchAndSwitch: deny("createBranchAndSwitch"),
      stagePaths: deny("stagePaths"),
      unstagePaths: deny("unstagePaths"),
      discardPaths: deny("discardPaths"),
      generateCommitMessage: deny("generateCommitMessage"),
      commit: deny("commit"),
      push: deny("push"),
      pull: deny("pull"),
    }) satisfies Partial<IGitService> & {
      getCommitGraphFilterOptions: (
        input: GitCommitGraphFilterOptionsRequest,
      ) => Promise<GitCommitGraphFilterOptions>;
    };

  return {
    summary,
    refresh,
    makeGitService,
    deny,
    control: {
      requests,
      optionRequests,
      forbidden,
      holdNext(kind: "graph" | "options" = "graph") {
        if (kind === "options") optionsHolds += 1;
        else graphHolds += 1;
      },
      release(id: number, result?: GitCommitGraphResult) {
        const request = held.get(id);
        if (!request) throw new Error(`No held graph request ${id}`);
        held.delete(id);
        request.resolve(result ?? request.result);
      },
      reject(id: number, message: string) {
        const request = held.get(id);
        if (!request) throw new Error(`No held graph request ${id}`);
        held.delete(id);
        request.reject(new Error(message));
      },
      setOptions(options: GitCommitGraphFilterOptions) {
        currentOptions = structuredClone(options);
      },
      releaseOptions(id: number) {
        const resolve = heldOptions.get(id);
        if (!resolve) throw new Error(`No held options request ${id}`);
        heldOptions.delete(id);
        resolve();
      },
    },
  };
}
