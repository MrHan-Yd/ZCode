import { useCallback, useEffect, useRef, useState } from "react";
import type {
  GitCommitGraphCommit,
  GitCommitGraphFilterOptions,
  GitCommitGraphFilters,
} from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import {
  buildGitGraphFilters,
  EMPTY_GIT_GRAPH_FILTER_DRAFT,
  hasGitGraphFilters,
  validateGitGraphFilters,
  type GitGraphFilterDraft,
} from "@/git-graph/filters.js";

const PAGE_SIZE = 50;
const INPUT_DELAY_MS = 200;
const EMPTY_OPTIONS: GitCommitGraphFilterOptions = { branches: [], authors: [] };
interface GraphQueryState {
  generation: number;
  commits: GitCommitGraphCommit[];
  hasMore: boolean;
  cursor?: string;
  loading: boolean;
  loadingMore: boolean;
  error: unknown;
  validation: "invalid-query" | "invalid-regex" | null;
  selectedHash: string | null;
  filters: GitCommitGraphFilters;
}
const EMPTY_STATE: GraphQueryState = {
  generation: 0,
  commits: [],
  hasMore: false,
  loading: false,
  loadingMore: false,
  error: null,
  validation: null,
  selectedHash: null,
  filters: {},
};

export function useGitGraphQuery(input: {
  open: boolean;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { gitService } = useServices();
  const { open, workspacePath, workspaceIdentity } = input;
  const scopeKey = JSON.stringify([workspaceIdentity?.trim() || workspacePath, workspacePath]);
  const [draft, setDraft] = useState(EMPTY_GIT_GRAPH_FILTER_DRAFT);
  const draftRef = useRef(EMPTY_GIT_GRAPH_FILTER_DRAFT);
  const [state, setState] = useState<GraphQueryState>(EMPTY_STATE);
  const stateRef = useRef<GraphQueryState>(EMPTY_STATE);
  const [options, setOptions] = useState(EMPTY_OPTIONS);
  const [optionsError, setOptionsError] = useState<unknown>(null);
  const generationRef = useRef(0);
  const optionsGenerationRef = useRef(0);
  const pendingMoreRef = useRef<number | null>(null);
  const inputTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ownerRef = useRef({ open, scopeKey, service: gitService });
  ownerRef.current = { open, scopeKey, service: gitService };

  // 游标先在唯一 owner 推进再通知 React；快速响应后的下一次滚动不能读到旧页。
  const publishState = useCallback((next: GraphQueryState) => {
    stateRef.current = next;
    setState(next);
  }, []);
  const cancelInputTimer = useCallback(() => {
    if (inputTimerRef.current !== null) clearTimeout(inputTimerRef.current);
    inputTimerRef.current = null;
  }, []);
  const isCurrent = useCallback(
    (generation: number) => {
      const owner = ownerRef.current;
      return (
        generationRef.current === generation &&
        owner.open &&
        owner.scopeKey === scopeKey &&
        owner.service === gitService
      );
    },
    [gitService, scopeKey],
  );

  const applyFilters = useCallback(
    async (next = draftRef.current) => {
      cancelInputTimer();
      const generation = ++generationRef.current;
      pendingMoreRef.current = null;
      const filters = buildGitGraphFilters(next, Date.now());
      const validation = validateGitGraphFilters(filters);
      publishState({
        ...EMPTY_STATE,
        generation,
        loading: validation === null,
        validation,
        filters,
      });
      if (validation || !isCurrent(generation)) return;
      try {
        const result = await gitService.getCommitGraph({
          workspacePath,
          workspaceIdentity,
          maxCount: PAGE_SIZE,
          skip: 0,
          filters,
        });
        if (!isCurrent(generation)) return;
        publishState({
          ...stateRef.current,
          commits: result.commits,
          hasMore: result.hasMore,
          cursor: result.cursor,
          selectedHash: result.commits[0]?.hash ?? null,
          loading: false,
        });
      } catch (error) {
        if (!isCurrent(generation)) return;
        publishState({ ...stateRef.current, loading: false, error });
      }
    },
    [cancelInputTimer, gitService, isCurrent, publishState, workspaceIdentity, workspacePath],
  );

  const readOptions = useCallback(
    async (ownerGeneration: number) => {
      setOptionsError(null);
      const isOwned = () => {
        const owner = ownerRef.current;
        return (
          optionsGenerationRef.current === ownerGeneration &&
          owner.open &&
          owner.scopeKey === scopeKey &&
          owner.service === gitService
        );
      };
      try {
        const result = await gitService.getCommitGraphFilterOptions({
          workspacePath,
          workspaceIdentity,
        });
        if (isOwned()) setOptions(result);
      } catch (error) {
        if (isOwned()) setOptionsError(error);
      }
    },
    [gitService, scopeKey, workspaceIdentity, workspacePath],
  );

  useEffect(() => {
    cancelInputTimer();
    const generation = ++generationRef.current;
    pendingMoreRef.current = null;
    draftRef.current = EMPTY_GIT_GRAPH_FILTER_DRAFT;
    setDraft(EMPTY_GIT_GRAPH_FILTER_DRAFT);
    publishState({ ...EMPTY_STATE, generation });
    setOptions(EMPTY_OPTIONS);
    setOptionsError(null);
    const optionsGeneration = ++optionsGenerationRef.current;
    if (open) {
      void applyFilters(EMPTY_GIT_GRAPH_FILTER_DRAFT);
      void readOptions(optionsGeneration);
    }
    return () => {
      cancelInputTimer();
      generationRef.current += 1;
      optionsGenerationRef.current += 1;
      pendingMoreRef.current = null;
    };
  }, [applyFilters, cancelInputTimer, open, publishState, readOptions, scopeKey]);

  const updateDraft = useCallback(
    (patch: Partial<GitGraphFilterDraft>) => {
      const next = { ...draftRef.current, ...patch };
      draftRef.current = next;
      setDraft(next);
      cancelInputTimer();
      const generation = ++generationRef.current;
      pendingMoreRef.current = null;
      // 输入事件当场替换旧投影；已排队的旧响应也不能在合并查询的等待期重新显示。
      publishState({ ...EMPTY_STATE, generation, loading: true });
      if ("text" in patch) {
        inputTimerRef.current = setTimeout(() => {
          inputTimerRef.current = null;
          void applyFilters(next);
        }, INPUT_DELAY_MS);
      } else void applyFilters(next);
    },
    [applyFilters, cancelInputTimer, publishState],
  );

  const loadMore = useCallback(async () => {
    const current = stateRef.current;
    if (
      current.loading ||
      current.loadingMore ||
      !current.hasMore ||
      pendingMoreRef.current !== null ||
      !isCurrent(current.generation)
    )
      return;
    const generation = current.generation;
    pendingMoreRef.current = generation;
    publishState({ ...current, loadingMore: true, error: null });
    try {
      const result = await gitService.getCommitGraph({
        workspacePath,
        workspaceIdentity,
        maxCount: PAGE_SIZE,
        filters: current.filters,
        ...(current.cursor ? { cursor: current.cursor } : { skip: current.commits.length }),
      });
      if (!isCurrent(generation)) return;
      const latest = stateRef.current;
      publishState({
        ...latest,
        commits: [...latest.commits, ...result.commits],
        hasMore: result.hasMore,
        cursor: result.cursor,
        loadingMore: false,
      });
    } catch (error) {
      if (!isCurrent(generation)) return;
      publishState({ ...stateRef.current, loadingMore: false, error });
    } finally {
      if (pendingMoreRef.current === generation) pendingMoreRef.current = null;
    }
  }, [gitService, isCurrent, publishState, workspaceIdentity, workspacePath]);

  const selectCommit = useCallback(
    (selectedHash: string) => publishState({ ...stateRef.current, selectedHash }),
    [publishState],
  );
  const refresh = useCallback(() => {
    void applyFilters();
    void readOptions(++optionsGenerationRef.current);
  }, [applyFilters, readOptions]);
  const applyNow = useCallback(() => {
    void applyFilters();
  }, [applyFilters]);
  return {
    draft,
    updateDraft,
    applyNow,
    refresh,
    loadMore,
    selectCommit,
    options,
    optionsError,
    ...state,
    filtered: hasGitGraphFilters(state.filters),
  };
}
