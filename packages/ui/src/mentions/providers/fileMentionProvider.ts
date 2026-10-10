import { useEffect, useMemo, useState } from "react";
import type { WorkspaceFileEntry } from "@zcode/shared";
import { useServices } from "@/hooks/useServices.js";
import { buildFileMentionMarkdown } from "@/mentions/mentionMarkdown.js";
import { WORKSPACE_FILE_SEARCH_DISPLAY_CAP } from "@zcode/shared/workspaceFileSearch";
import { getMentionGroupLimitForQuery } from "@/mentions/mentionSearch.js";
import type { MentionCategoryResult, MentionItem } from "@/mentions/mentionTypes.js";

function mapWorkspaceFileToMentionItem(entry: WorkspaceFileEntry): MentionItem {
  return {
    id: `file:${entry.relativePath}`,
    category: "files",
    label: entry.name,
    description: entry.relativePath,
    value: entry.relativePath,
    // 文件 mention 的标准转译格式需要保持 `[filename](path)`，
    // 之前这里误把整条 relativePath 当成链接文本，导致发送后回显和复制内容都退化成“长路径做标题”。
    // 这里恢复为只用 basename 做 label，路径只放在链接目标里，和输入框 node 样式保持一致。
    markdown: buildFileMentionMarkdown(entry.relativePath, entry.name, entry.type),
    keywords: [entry.relativePath, entry.path],
    data: {
      kind: entry.type,
      path: entry.path,
      relativePath: entry.relativePath,
    },
  };
}

function normalizeRefreshQuery(query: string): string {
  return query.trim().toLowerCase();
}

// `@` 每条键击都会触发一次文件搜索 RPC，即使有 useDeferredValue 也只是降渲染优先级。
// 150ms 防抖把连续键入合成一次搜索，避免大工作区逐键全量扫描候选。
const FILE_SEARCH_DEBOUNCE_MS = 150;
// 命中空结果的补扫会绕过 60s 索引缓存做整树目录遍历（按文件内注释，37 万文件仓可达秒级）。
// 冷却窗口防止连续输入多个落空 query 时反复整树重扫。
const FILE_SEARCH_REFRESH_COOLDOWN_MS = 5_000;

export function useFileMentionProvider(
  workspacePath: string,
  workspaceIdentity: string | undefined,
  query: string,
  enabled: boolean,
  emptyText: string,
  title: string,
  defaultPreviewLimit?: number,
): MentionCategoryResult {
  const { fileService } = useServices();
  // 面板打开时展示旧结果，键入期间不逐键闪 loading / 发 RPC。
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => setDebouncedQuery(query), FILE_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [enabled, query]);
  const limit =
    getMentionGroupLimitForQuery(debouncedQuery, defaultPreviewLimit) ??
    WORKSPACE_FILE_SEARCH_DISPLAY_CAP;
  // 连接实例也属于作用域：相同路径的远程重连不能接纳旧 Host 的查询结果。
  const scope = useMemo(
    () => ({
      error: null as Error | null,
      lastMissQuery: null as string | null,
      lastRefreshAt: null as number | null,
    }),
    [fileService, workspacePath, workspaceIdentity, enabled],
  );
  const [result, setResult] = useState<{
    scope: typeof scope;
    query: string;
    limit: number;
    entries: WorkspaceFileEntry[];
    loading: boolean;
    error: Error | null;
  } | null>(null);

  useEffect(() => {
    // 错误态等待面板/工作区/连接生命周期重置，避免 query 变化触发失败重试循环。
    if (!enabled || scope.error) return;
    let active = true;
    setResult({ scope, query: debouncedQuery, limit, entries: [], loading: true, error: null });
    const params = { rootPath: workspacePath, workspaceIdentity, query: debouncedQuery, limit };
    const search = async () => {
      try {
        let entries = await fileService.searchWorkspaceFiles(params);
        if (!active) return;
        const normalizedQuery = normalizeRefreshQuery(debouncedQuery);
        if (entries.length === 0 && normalizedQuery && scope.lastMissQuery !== normalizedQuery) {
          // 无命中补扫必须绕过 Host TTL，否则外部新文件在缓存有效期内永远不可见；
          // 但整树重扫很贵，连续输入多个落空 query 时用冷却窗口限频，避免反复全量遍历。
          const refreshAllowed =
            scope.lastRefreshAt === null ||
            Date.now() - scope.lastRefreshAt >= FILE_SEARCH_REFRESH_COOLDOWN_MS;
          if (refreshAllowed) {
            // 只有真正补扫过才记忆该 query。若在冷却期内被跳过也记下来，
            // 这个 query 就再也不会触发补扫，等于把"缓存期内看不到新文件"的旧问题又放回来了。
            scope.lastMissQuery = normalizedQuery;
            scope.lastRefreshAt = Date.now();
            entries = await fileService.searchWorkspaceFiles({ ...params, refresh: true });
            if (!active) return;
          }
        }
        setResult({ scope, query: debouncedQuery, limit, entries, loading: false, error: null });
      } catch (error) {
        if (!active) return;
        scope.error = error instanceof Error ? error : new Error(String(error));
        setResult({
          scope,
          query: debouncedQuery,
          limit,
          entries: [],
          loading: false,
          error: scope.error,
        });
      }
    };
    void search();
    // 查询、工作区、连接或面板生命周期变化都使已发出的异步响应失效。
    return () => {
      active = false;
    };
  }, [debouncedQuery, enabled, fileService, scope, workspaceIdentity, workspacePath, limit]);

  const current =
    enabled && result?.scope === scope && result.query === debouncedQuery && result.limit === limit;
  const items = useMemo(
    () => (current ? result.entries.map(mapWorkspaceFileToMentionItem) : []),
    [current, result],
  );
  return {
    items,
    loading: enabled && !scope.error && (!current || result.loading),
    error: enabled ? scope.error : null,
    emptyText,
    title,
  };
}
