/* eslint-disable max-lines -- trigger 状态机、分组派生与键盘协议同属一个面板生命周期，拆分会增加跨状态跳转成本。 */
/**
 * PromptLibraryPlugin — composer 的 `;` / `；` 提示词选择面板。
 *
 * 与 SlashCommandPlugin / MentionPlugin 同构：只监听 editor update，读取当前文本节点的
 * `;query` token，通过 MentionPanel 渲染候选，选中后用纯文本替换 token。
 * 提示词库服务固定取自 base/local Host，服务缺失时完全不挂面板、不拦截输入。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { createPortal } from "react-dom";
import {
  $getSelection,
  $isRangeSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  COMMAND_PRIORITY_LOW,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from "lexical";
import { TID_PROMPT_LIBRARY_ANNOUNCEMENT } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { toast } from "@/components/ui/toast.js";
import { usePromptLibrary } from "@/hooks/usePromptLibrary.js";
import { shouldFreezeMentionRecalcWhileComposing } from "@/lib/imeComposition.js";
import {
  HISTORY_NAVIGATION_UPDATE_TAG,
  PROGRAMMATIC_UPDATE_TAG,
  PROMPT_LIBRARY_INSERT_UPDATE_TAG,
} from "@/lib/editorUpdateTags.js";
import { getPromptInputTriggerSignature } from "@/lib/promptInputTriggers.js";
import {
  reconcileActivePromptInputTokenSnapshot,
  type ActivePromptInputTokenSnapshot,
} from "@/mentions/activePromptInputToken.js";
import {
  MentionPanel,
  type MentionPanelOption,
  type MentionPanelSection,
} from "@/mentions/components/MentionPanel.js";
import { getCurrentTextNodeSelection } from "@/mentions/mentionHelpers.js";
import { insertPromptLibraryAtToken } from "@/mentions/promptLibraryInsert.js";
import { filterPromptTemplates } from "@/lib/promptLibrarySearch.js";
import {
  PROMPT_LIBRARY_STALE_MS,
  sortPromptLibraryItems,
  usePromptLibraryStore,
} from "@/store/promptLibraryStore.js";
import type { PromptTemplateSortMode, PromptTemplateSummary } from "@zcode/shared";

interface PromptLibraryPluginProps {
  container?: HTMLElement | null;
  disabled?: boolean;
}

const PANEL_SORT_MODE: PromptTemplateSortMode = "recentUsed";
const RECENT_GROUP_LIMIT = 5;
const MAX_RESULTS = 100;
const LOADING_DELAY_MS = 150;

interface PromptGroup {
  id: string;
  title: string;
  items: PromptTemplateSummary[];
}

export function PromptLibraryPlugin({ container, disabled = false }: PromptLibraryPluginProps) {
  const [editor] = useLexicalComposerContext();
  const { intl } = useZCodeIntl();
  const library = usePromptLibrary();
  const service = library.service;
  const items = library.items;
  const loadLibrary = library.load;
  const recordUsage = library.recordUsage;

  const [activeTrigger, setActiveTrigger] = useState<{ trigger: ";"; query: string } | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [showLoading, setShowLoading] = useState(false);
  const activeTokenRef = useRef<ActivePromptInputTokenSnapshot | null>(null);
  const dismissedTokenStartRef = useRef<number | null>(null);
  const selectingRef = useRef(false);
  const activeSignatureRef = useRef<string | null>(null);

  const activeQuery = activeTrigger?.query ?? "";
  const hasActiveQuery = activeQuery.trim().length > 0;
  const isOpen = !disabled && service !== null && activeTrigger !== null;
  const activeSignature = useMemo(
    () => getPromptInputTriggerSignature(activeTrigger),
    [activeTrigger],
  );

  useEffect(() => {
    activeSignatureRef.current = activeSignature;
  }, [activeSignature]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [activeSignature]);

  // 延迟 150ms 才显示加载态，避免本机库的快速返回让面板闪一下。
  useEffect(() => {
    if (!isOpen || !library.loading) {
      setShowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoading(true), LOADING_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen, library.loading]);

  useEffect(() => {
    if (!isOpen) {
      activeTokenRef.current = null;
      return;
    }
    // 读取 store 快照而不是订阅 items：这里只用于判断失败时是否有旧缓存可展示，
    // 不应因列表变化重新触发加载。
    const hadCachedItems = usePromptLibraryStore.getState().items.length > 0;
    let cancelled = false;
    void loadLibrary().then((ok) => {
      if (cancelled || ok || !hadCachedItems) {
        return;
      }
      // 有旧快照时保留列表，只在 composer 级提示一次；不阻塞输入。
      toast(intl.formatMessage({ id: "composer.promptLibrary.error" }));
    });
    return () => {
      cancelled = true;
    };
  }, [intl, isOpen, loadLibrary]);

  // 面板持续打开超过缓存 TTL 时刷新一次，避免另一端删除/新增后长时间看到旧列表。
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const timer = window.setTimeout(() => {
      void loadLibrary({ force: true });
    }, PROMPT_LIBRARY_STALE_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen, loadLibrary]);

  useEffect(() => {
    return editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, editorState, tags }) => {
      // 历史导航、草稿恢复/外部预填、提示词库自身插入都不是用户正在输入 `;query`。
      // 提示词正文可能以 `;` 结尾，必须在 listener 开头跳过，否则会和自己的 update 互相唤醒。
      if (
        tags.has(HISTORY_NAVIGATION_UPDATE_TAG) ||
        tags.has(PROGRAMMATIC_UPDATE_TAG) ||
        tags.has(PROMPT_LIBRARY_INSERT_UPDATE_TAG)
      ) {
        activeTokenRef.current = null;
        setActiveTrigger(null);
        return;
      }

      if (
        shouldFreezeMentionRecalcWhileComposing(
          editor.isComposing(),
          typeof navigator === "undefined" ? "" : navigator.userAgent,
        )
      ) {
        return;
      }

      editorState.read(() => {
        if (disabled || !service) {
          activeTokenRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const selectionState = getCurrentTextNodeSelection();
        if (!selectionState) {
          activeTokenRef.current = null;
          dismissedTokenStartRef.current = null;
          setActiveTrigger(null);
          return;
        }

        const nextToken = reconcileActivePromptInputTokenSnapshot(
          activeTokenRef.current,
          selectionState,
          dirtyElements.size === 0 && dirtyLeaves.size === 0,
        );
        if (!nextToken || nextToken.trigger !== ";") {
          activeTokenRef.current = null;
          dismissedTokenStartRef.current = null;
          setActiveTrigger(null);
          return;
        }
        activeTokenRef.current = nextToken;

        // Esc 只抑制当前 token（同一 `;` 位置）；光标离开后自动解除抑制。
        if (
          dismissedTokenStartRef.current !== null &&
          dismissedTokenStartRef.current !== nextToken.tokenStart
        ) {
          dismissedTokenStartRef.current = null;
        }
        if (dismissedTokenStartRef.current === nextToken.tokenStart) {
          setActiveTrigger(null);
          return;
        }

        setActiveTrigger((current) =>
          current?.query === nextToken.query ? current : { trigger: ";", query: nextToken.query },
        );
      });
    });
  }, [disabled, editor, service]);

  const sortedItems = useMemo(() => sortPromptLibraryItems(items, PANEL_SORT_MODE), [items]);

  const groups = useMemo<PromptGroup[]>(() => {
    if (!hasActiveQuery) {
      const pinned = sortedItems.filter((item) => item.pinned);
      const recent = sortedItems
        .filter((item) => !item.pinned && typeof item.lastUsedAt === "number")
        .slice(0, RECENT_GROUP_LIMIT);
      const reservedIds = new Set([
        ...pinned.map((item) => item.id),
        ...recent.map((item) => item.id),
      ]);
      const remaining = sortedItems.filter((item) => !reservedIds.has(item.id));

      return [
        {
          id: "pinned",
          title: intl.formatMessage({ id: "composer.promptLibrary.section.pinned" }),
          items: pinned,
        },
        {
          id: "recent",
          title: intl.formatMessage({ id: "composer.promptLibrary.section.recent" }),
          items: recent,
        },
        {
          id: "all",
          title: intl.formatMessage({ id: "composer.promptLibrary.section.all" }),
          items: remaining,
        },
      ].filter((group) => group.items.length > 0);
    }

    // 搜索结果最多 100 条；空查询分组交给虚拟列表处理全量。
    const matches = filterPromptTemplates(sortedItems, activeQuery).slice(0, MAX_RESULTS);

    return [
      {
        id: "results",
        title: intl.formatMessage({ id: "composer.promptLibrary.section.results" }),
        items: matches,
      },
    ];
  }, [activeQuery, hasActiveQuery, intl, sortedItems]);

  const flatItems = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => {
    setSelectedIndex((current) => {
      if (flatItems.length === 0) {
        return 0;
      }
      return Math.min(current, flatItems.length - 1);
    });
  }, [flatItems.length]);

  const panelSections = useMemo<MentionPanelSection[]>(() => {
    const makeOptions = (groupItems: PromptTemplateSummary[]): MentionPanelOption[] =>
      groupItems.map((item) => ({
        id: item.id,
        label: item.title,
        description: item.contentPreview,
        content: (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="shrink-0 max-w-[40%] truncate text-ui-base font-medium text-foreground">
              {item.title}
            </span>
            <span className="min-w-0 flex-1 truncate text-ui-sm text-foreground-subtle">
              {item.contentPreview}
            </span>
            {item.tags.slice(0, 2).map((tag) => (
              <span key={tag} className="shrink-0 truncate text-ui-xs text-foreground-subtlest">
                #{tag}
              </span>
            ))}
            {item.alias ? (
              <span className="ml-auto shrink-0 font-mono text-ui-xs text-foreground-subtlest">
                ;{item.alias}
              </span>
            ) : null}
          </span>
        ),
      }));

    if (service === null) {
      return [];
    }

    if (items.length === 0) {
      if (showLoading) {
        return [
          {
            id: "prompt-library",
            title: intl.formatMessage({ id: "composer.promptLibrary.title" }),
            options: [],
            loading: true,
            loadingText: intl.formatMessage({ id: "composer.promptLibrary.loading" }),
            emptyText: "",
          },
        ];
      }
      if (library.error) {
        return [
          {
            id: "prompt-library",
            title: intl.formatMessage({ id: "composer.promptLibrary.title" }),
            options: [],
            errorText: intl.formatMessage({ id: "composer.promptLibrary.error" }),
            emptyText: "",
          },
        ];
      }
      return [
        {
          id: "prompt-library",
          title: intl.formatMessage({ id: "composer.promptLibrary.title" }),
          options: [],
          emptyText: hasActiveQuery
            ? intl.formatMessage({ id: "composer.promptLibrary.emptyResults" })
            : [
                intl.formatMessage({ id: "composer.promptLibrary.emptyLibrary" }),
                intl.formatMessage({ id: "composer.promptLibrary.emptyLibraryHint" }),
              ].join(" "),
        },
      ];
    }

    return groups.map((group) => ({
      id: group.id,
      title: group.title,
      options: makeOptions(group.items),
      emptyText: intl.formatMessage({ id: "composer.promptLibrary.emptyResults" }),
    }));
  }, [groups, hasActiveQuery, intl, items.length, library.error, service, showLoading]);

  const selectOption = useCallback(
    (index: number): boolean => {
      const item = flatItems[index];
      const token = activeTokenRef.current;
      if (!item || selectingRef.current || !service || !token || token.trigger !== ";") {
        return false;
      }

      // 先关闭面板并冻结 token 快照，再异步取全文；get 期间用户的改动由插入 helper 复核。
      selectingRef.current = true;
      activeTokenRef.current = null;
      dismissedTokenStartRef.current = token.tokenStart;
      setActiveTrigger(null);
      setSelectedIndex(0);

      void (async () => {
        try {
          const result = await service.get({ id: item.id });
          if (!result.ok) {
            toast(
              intl.formatMessage({
                id:
                  result.reason === "not-found"
                    ? "composer.promptLibrary.deletedWhileOpen"
                    : "composer.promptLibrary.error",
              }),
            );
            void loadLibrary({ force: true });
            return;
          }

          const inserted = insertPromptLibraryAtToken(editor, {
            token,
            content: result.item.content,
          });
          if (inserted) {
            setAnnouncement(
              intl.formatMessage(
                { id: "composer.promptLibrary.insertedAnnouncement" },
                { name: result.item.title },
              ),
            );
            // best-effort：不 await，失败只记 warn，不阻塞插入。
            void recordUsage(item.id);
          }
        } catch (error) {
          logger.warn("[PromptLibraryPlugin] 插入提示词失败", {
            error: error instanceof Error ? error.message : String(error),
          });
          toast(intl.formatMessage({ id: "composer.promptLibrary.error" }));
        } finally {
          selectingRef.current = false;
          requestAnimationFrame(() => {
            editor.focus();
          });
        }
      })();

      return true;
    },
    [editor, flatItems, intl, loadLibrary, recordUsage, service],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const unregisterDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => {
        if (flatItems.length === 0) {
          return false;
        }
        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => Math.min(prev + 1, flatItems.length - 1));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => {
        if (flatItems.length === 0) {
          return false;
        }
        event?.preventDefault();
        event?.stopPropagation();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const closeWithoutSelection = () => {
      dismissedTokenStartRef.current = activeTokenRef.current?.tokenStart ?? null;
      setActiveTrigger(null);
      setSelectedIndex(0);
    };

    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) => {
        // 无候选（空库/加载中/无匹配）时不能把 Enter 交回发送链路：
        // `;query` 仍然非空，会被当成普通消息发出去。这里关闭面板并显式换行。
        if (flatItems.length === 0) {
          event?.preventDefault();
          event?.stopPropagation();
          closeWithoutSelection();
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.insertLineBreak();
            }
          });
          return true;
        }
        if (selectingRef.current) {
          event?.preventDefault();
          return true;
        }
        if (!selectOption(selectedIndex)) {
          return false;
        }
        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => {
        if (flatItems.length === 0) {
          return false;
        }
        if (selectingRef.current) {
          event?.preventDefault();
          return true;
        }
        if (!selectOption(selectedIndex)) {
          return false;
        }
        event?.preventDefault();
        event?.stopPropagation();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterEscape = editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event) => {
        event?.preventDefault();
        event?.stopPropagation();
        closeWithoutSelection();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );

    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => {
        dismissedTokenStartRef.current = null;
        activeTokenRef.current = null;
        setActiveTrigger(null);
        setSelectedIndex(0);
        return false;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unregisterDown();
      unregisterUp();
      unregisterEnter();
      unregisterTab();
      unregisterEscape();
      unregisterBlur();
    };
  }, [editor, flatItems.length, isOpen, selectOption, selectedIndex]);

  if (!service || !container) {
    return null;
  }

  const footer = (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-ui-xs text-foreground-subtlest">
      <span className="font-mono">
        ; {intl.formatMessage({ id: "composer.promptLibrary.footer.trigger" })}
      </span>
      <span className="flex flex-wrap items-center gap-3">
        <span>↑↓ {intl.formatMessage({ id: "composer.promptLibrary.footer.navigate" })}</span>
        <span>Enter/Tab {intl.formatMessage({ id: "composer.promptLibrary.footer.insert" })}</span>
        <span>Esc {intl.formatMessage({ id: "composer.promptLibrary.footer.close" })}</span>
      </span>
    </div>
  );

  return createPortal(
    <>
      {isOpen ? (
        <MentionPanel
          title={intl.formatMessage({ id: "composer.promptLibrary.title" })}
          description=""
          trigger=";"
          sections={panelSections}
          emptyText={intl.formatMessage({ id: "composer.promptLibrary.emptyResults" })}
          selectedIndex={selectedIndex}
          hasActiveQuery={hasActiveQuery}
          onSelect={selectOption}
          footer={footer}
        />
      ) : null}
      <span
        className="sr-only"
        role="status"
        aria-live="polite"
        data-testid={TID_PROMPT_LIBRARY_ANNOUNCEMENT}
      >
        {announcement}
      </span>
    </>,
    container,
  );
}
