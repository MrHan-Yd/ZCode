import { create } from "zustand";
import type {
  PromptLibraryWarning,
  PromptTemplateInput,
  PromptTemplateSortMode,
  PromptTemplateSummary,
} from "@zcode/shared";
import { comparePromptTemplates, toPromptTemplateSummary } from "@zcode/shared";
import type { IPromptLibraryService } from "@zcode/services";
import { logger } from "@/logger.js";

export const PROMPT_LIBRARY_STALE_MS = 30_000;

type PromptLibraryListResult = Awaited<ReturnType<IPromptLibraryService["list"]>>;
type PromptLibraryMutationResult = Awaited<ReturnType<IPromptLibraryService["create"]>>;
type PromptLibraryUpdateParams = Parameters<IPromptLibraryService["update"]>[0];
type PromptLibraryRemoveResult = Awaited<ReturnType<IPromptLibraryService["remove"]>>;

interface PromptLibraryStoreState {
  items: PromptTemplateSummary[];
  loading: boolean;
  loaded: boolean;
  loadedAt: number | null;
  error: string | null;
  warning: PromptLibraryWarning | null;
  readOnly: boolean;
  requestSeq: number;
  load: (service: IPromptLibraryService, options?: { force?: boolean }) => Promise<boolean>;
  createPrompt: (
    service: IPromptLibraryService,
    input: PromptTemplateInput,
  ) => Promise<PromptLibraryMutationResult>;
  updatePrompt: (
    service: IPromptLibraryService,
    input: PromptLibraryUpdateParams,
  ) => Promise<PromptLibraryMutationResult>;
  removePrompt: (service: IPromptLibraryService, id: string) => Promise<PromptLibraryRemoveResult>;
  setPinned: (
    service: IPromptLibraryService,
    id: string,
    pinned: boolean,
  ) => Promise<PromptLibraryMutationResult>;
  recordUsage: (service: IPromptLibraryService, id: string) => Promise<void>;
  clearError: () => void;
  reset: () => void;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sortPromptLibraryItems(
  items: readonly PromptTemplateSummary[],
  sortMode: PromptTemplateSortMode = "recentUsed",
): PromptTemplateSummary[] {
  return [...items].sort((left, right) => comparePromptTemplates(left, right, sortMode));
}

function upsertItem(
  items: readonly PromptTemplateSummary[],
  item: PromptTemplateSummary,
): PromptTemplateSummary[] {
  const next = items.filter((candidate) => candidate.id !== item.id);
  next.push(item);
  return sortPromptLibraryItems(next);
}

export const usePromptLibraryStore = create<PromptLibraryStoreState>((set, get) => ({
  items: [],
  loading: false,
  loaded: false,
  loadedAt: null,
  error: null,
  warning: null,
  readOnly: false,
  requestSeq: 0,

  load: async (service, options) => {
    const force = options?.force === true;
    const { loaded, loadedAt, requestSeq } = get();
    // 30 秒内重复打开面板/输入 query 直接复用摘要缓存，避免每次按键都打 Host。
    if (!force && loaded && loadedAt !== null && Date.now() - loadedAt < PROMPT_LIBRARY_STALE_MS) {
      return true;
    }

    const seq = requestSeq + 1;
    set({ requestSeq: seq, loading: true, error: null });
    try {
      const result: PromptLibraryListResult = await service.list();
      // 旧请求不回写：期间可能有更新的 list（切窗口、强制刷新）已经完成。
      if (get().requestSeq !== seq) {
        return false;
      }
      set({
        items: sortPromptLibraryItems(result.items),
        loading: false,
        loaded: true,
        loadedAt: Date.now(),
        warning: result.warning,
        readOnly: result.readOnly,
        error: null,
      });
      return true;
    } catch (error) {
      if (get().requestSeq !== seq) {
        return false;
      }
      const message = getErrorMessage(error);
      set({ loading: false, error: message });
      logger.warn("[promptLibraryStore] 加载提示词库失败", { error: message });
      return false;
    }
  },

  createPrompt: async (service, input) => {
    const result = await service.create(input);
    if (result.ok) {
      set({ items: upsertItem(get().items, toPromptTemplateSummary(result.item)) });
    }
    return result;
  },

  updatePrompt: async (service, input) => {
    const result = await service.update(input);
    if (result.ok) {
      set({ items: upsertItem(get().items, toPromptTemplateSummary(result.item)) });
    }
    return result;
  },

  removePrompt: async (service, id) => {
    const result = await service.remove({ id });
    if (result.ok) {
      // remove 是幂等的：未知 id 也视为成功，本地直接剔除。
      set({ items: get().items.filter((item) => item.id !== id) });
    }
    return result;
  },

  setPinned: async (service, id, pinned) => {
    const result = await service.setPinned({ id, pinned });
    if (result.ok) {
      set({ items: upsertItem(get().items, toPromptTemplateSummary(result.item)) });
    }
    return result;
  },

  recordUsage: async (service, id) => {
    // 先做本地乐观更新，让面板/设置页排序立即反映；服务写入是 best-effort。
    set({
      items: sortPromptLibraryItems(
        get().items.map((item) => (item.id === id ? { ...item, lastUsedAt: Date.now() } : item)),
      ),
    });
    try {
      await service.recordUsage({ id });
    } catch (error) {
      logger.warn("[promptLibraryStore] 记录提示词使用失败", {
        error: getErrorMessage(error),
      });
    }
  },

  clearError: () => set({ error: null }),

  reset: () =>
    set({
      items: [],
      loading: false,
      loaded: false,
      loadedAt: null,
      error: null,
      warning: null,
      readOnly: false,
      requestSeq: get().requestSeq + 1,
    }),
}));
