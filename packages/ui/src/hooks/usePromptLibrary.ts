import { useCallback, useEffect } from "react";
import type {
  PromptLibraryWarning,
  PromptTemplateInput,
  PromptTemplateSortMode,
  PromptTemplateSummary,
} from "@zcode/shared";
import type { IPromptLibraryService } from "@zcode/services";
import { sortPromptLibraryItems, usePromptLibraryStore } from "@/store/promptLibraryStore.js";
import { useOptionalBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

type PromptLibraryMutationResult = Awaited<ReturnType<IPromptLibraryService["create"]>>;
type PromptLibraryUpdateParams = Parameters<IPromptLibraryService["update"]>[0];
type PromptLibraryRemoveResult = Awaited<ReturnType<IPromptLibraryService["remove"]>>;

export interface UsePromptLibraryResult {
  /** 当前 base Host 的提示词库服务；旧 Host / 测试替身缺失时为 null。 */
  service: IPromptLibraryService | null;
  available: boolean;
  items: PromptTemplateSummary[];
  loading: boolean;
  loaded: boolean;
  error: string | null;
  warning: PromptLibraryWarning | null;
  readOnly: boolean;
  sort: (sortMode?: PromptTemplateSortMode) => PromptTemplateSummary[];
  load: (options?: { force?: boolean }) => Promise<boolean>;
  createPrompt: (input: PromptTemplateInput) => Promise<PromptLibraryMutationResult>;
  updatePrompt: (input: PromptLibraryUpdateParams) => Promise<PromptLibraryMutationResult>;
  removePrompt: (id: string) => Promise<PromptLibraryRemoveResult>;
  setPinned: (id: string, pinned: boolean) => Promise<PromptLibraryMutationResult>;
  recordUsage: (id: string) => Promise<void>;
  clearError: () => void;
}

const UNAVAILABLE_RESULT = { ok: false as const, reason: "io-error" as const };

/**
 * 提示词库固定走 base/local Host：激活远程 workspace 时，workspace 服务指向远端 Host，
 * 但用户级提示词库属于本机事实源。Composer 与设置页都通过这个 Hook 取服务。
 */
export function usePromptLibrary(): UsePromptLibraryResult {
  const services = useOptionalBaseWorkspaceServices();
  const service: IPromptLibraryService | null = services?.promptLibraryService ?? null;

  const items = usePromptLibraryStore((state) => state.items);
  const loading = usePromptLibraryStore((state) => state.loading);
  const loaded = usePromptLibraryStore((state) => state.loaded);
  const error = usePromptLibraryStore((state) => state.error);
  const warning = usePromptLibraryStore((state) => state.warning);
  const readOnly = usePromptLibraryStore((state) => state.readOnly);
  const reset = usePromptLibraryStore((state) => state.reset);
  const clearError = usePromptLibraryStore((state) => state.clearError);

  useEffect(() => {
    // 切换到不支持的旧 Host 时清掉旧投影，避免设置页继续展示上一台 Host 的提示词。
    if (!service) {
      reset();
    }
  }, [reset, service]);

  const load = useCallback(
    (options?: { force?: boolean }) => {
      if (!service) {
        return Promise.resolve(false);
      }
      return usePromptLibraryStore.getState().load(service, options);
    },
    [service],
  );

  const createPrompt = useCallback(
    (input: PromptTemplateInput): Promise<PromptLibraryMutationResult> => {
      if (!service) {
        return Promise.resolve(UNAVAILABLE_RESULT);
      }
      return usePromptLibraryStore.getState().createPrompt(service, input);
    },
    [service],
  );

  const updatePrompt = useCallback(
    (input: PromptLibraryUpdateParams): Promise<PromptLibraryMutationResult> => {
      if (!service) {
        return Promise.resolve(UNAVAILABLE_RESULT);
      }
      return usePromptLibraryStore.getState().updatePrompt(service, input);
    },
    [service],
  );

  const removePrompt = useCallback(
    (id: string): Promise<PromptLibraryRemoveResult> => {
      if (!service) {
        return Promise.resolve(UNAVAILABLE_RESULT);
      }
      return usePromptLibraryStore.getState().removePrompt(service, id);
    },
    [service],
  );

  const setPinned = useCallback(
    (id: string, pinned: boolean): Promise<PromptLibraryMutationResult> => {
      if (!service) {
        return Promise.resolve(UNAVAILABLE_RESULT);
      }
      return usePromptLibraryStore.getState().setPinned(service, id, pinned);
    },
    [service],
  );

  const recordUsage = useCallback(
    (id: string): Promise<void> => {
      if (!service) {
        return Promise.resolve();
      }
      return usePromptLibraryStore.getState().recordUsage(service, id);
    },
    [service],
  );

  const sort = useCallback(
    (sortMode?: PromptTemplateSortMode) => sortPromptLibraryItems(items, sortMode),
    [items],
  );

  return {
    service,
    available: service !== null,
    items,
    loading,
    loaded,
    error,
    warning,
    readOnly,
    sort,
    load,
    createPrompt,
    updatePrompt,
    removePrompt,
    setPinned,
    recordUsage,
    clearError,
  };
}
