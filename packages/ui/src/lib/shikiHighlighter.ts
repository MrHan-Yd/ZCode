import type { BundledLanguage, BundledTheme, HighlighterGeneric, ThemedToken } from "shiki";
import { bundledLanguages, bundledLanguagesInfo, createHighlighter } from "shiki";
import { logger } from "@/logger.js";
import { uiMemoryDiagnosticsRegistry } from "@/lib/memoryDiagnostics.js";

export interface TokenizedCode {
  tokens: ThemedToken[][];
  fg: string;
  bg: string;
}

const bundledLanguageIds = new Set(Object.keys(bundledLanguages));
const bundledLanguageAliases = new Map(
  bundledLanguagesInfo.flatMap((info) =>
    (info.aliases ?? []).map((alias) => [alias, info.id] as const),
  ),
);
const FALLBACK_CODE_LANGUAGE: BundledLanguage = "log";
const PLAIN_TEXT_CODE_LANGUAGES = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "log",
  "output",
]);

export function shouldUseSyntaxHighlighting(language: string): boolean {
  const candidate = language.trim().toLowerCase();
  if (PLAIN_TEXT_CODE_LANGUAGES.has(candidate)) {
    return false;
  }

  return bundledLanguageIds.has(candidate) || bundledLanguageAliases.has(candidate);
}

function normalizeCodeLanguage(language: string): BundledLanguage {
  const candidate = language.trim().toLowerCase();
  if (!candidate) {
    return FALLBACK_CODE_LANGUAGE;
  }

  const alias = bundledLanguageAliases.get(candidate);
  if (alias && bundledLanguageIds.has(alias)) {
    return alias as BundledLanguage;
  }

  if (bundledLanguageIds.has(candidate)) {
    return candidate as BundledLanguage;
  }

  return FALLBACK_CODE_LANGUAGE;
}

type ShikiHighlighter = HighlighterGeneric<BundledLanguage, BundledTheme>;

// tokensCache 上限：单条目持有整段代码的完整 token 数组，无界时流式代码块与历史恢复会持续累积
// （实测一个 20k 字符代码块按 200 次增量更新会写入 200 条 / 16 万个 token 对象）。
const TOKENS_CACHE_MAX_ENTRIES = 128;

// shiki 的 createHighlighter 每次调用都会新建一个 oniguruma WASM 引擎，按 (theme, language)
// 各建实例会让同一份语法随主题数重复加载，且库自身会打印
// "Shiki is supposed to be used as a singleton" 警告。这里只保留一个实例，
// 语言与主题改为按需 load 到它上面；load 结果只取决于 (语法, 主题, 文本)，与载入方式无关。
let sharedHighlighter: Promise<ShikiHighlighter> | undefined;
const pendingLanguageLoads = new Map<BundledLanguage, Promise<void>>();
const pendingThemeLoads = new Map<BundledTheme, Promise<void>>();

const tokensCache = new Map<string, TokenizedCode>();
const subscribers = new Map<string, Set<(result: TokenizedCode) => void>>();
// 内存诊断计数器：tokensCache 受 TOKENS_CACHE_MAX_ENTRIES 约束，highlighters 恒为 0 或 1。
uiMemoryDiagnosticsRegistry.register("shiki", () => ({
  tokensCache: tokensCache.size,
  highlighters: sharedHighlighter ? 1 : 0,
}));

const getResolvedCodeTheme = (theme?: BundledTheme): BundledTheme => {
  if (theme) {
    return theme;
  }

  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "github-dark";
  }

  return "github-light";
};

/**
 * 缓存 key 沿用改动前的形态（长度 + 前 100 + 后 100 字符），刻意不改成精确 key：
 * 精确 key 会让「长度相同、首尾相同、中段不同」的两段代码从「共用一份高亮」变成「各自高亮」，
 * 那是可观察的行为变化。本次只做内存与实例数的优化，不做行为变更。
 * 已知代价与理由记录在 specs/shiki-highlight-performance.md。
 */
const getCodeTokensCacheKey = (code: string, language: BundledLanguage, theme: BundledTheme) => {
  const start = code.slice(0, 100);
  const end = code.length > 100 ? code.slice(-100) : "";
  return `${theme}:${language}:${code.length}:${start}:${end}`;
};

/** Map 保持插入序：先删再插即可把条目提升为最近使用。 */
const cacheTokens = (cacheKey: string, tokenized: TokenizedCode): void => {
  tokensCache.delete(cacheKey);
  tokensCache.set(cacheKey, tokenized);
  while (tokensCache.size > TOKENS_CACHE_MAX_ENTRIES) {
    const oldestKey = tokensCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    tokensCache.delete(oldestKey);
  }
};

const getSharedHighlighter = (): Promise<ShikiHighlighter> => {
  if (!sharedHighlighter) {
    // 引擎创建失败时清掉缓存，让下一次请求可以重试。改动前每个 (theme, language) 各自缓存
    // reject 的 promise，一次瞬时失败会永久关掉那个组合的高亮；现在是共享实例，
    // 一旦失败影响面覆盖全部高亮，必须能恢复。
    sharedHighlighter = createHighlighter({ langs: [], themes: [] }).catch((error: unknown) => {
      sharedHighlighter = undefined;
      throw error;
    });
  }
  return sharedHighlighter;
};

/** 同一语言/主题可能被多个调用方同时请求，复用进行中的加载而不是重复 load。 */
const ensureLanguageLoaded = (
  highlighter: ShikiHighlighter,
  language: BundledLanguage,
): Promise<void> => {
  let pending = pendingLanguageLoads.get(language);
  if (!pending) {
    pending = highlighter.loadLanguage(language);
    pendingLanguageLoads.set(language, pending);
  }
  return pending;
};

const ensureThemeLoaded = (highlighter: ShikiHighlighter, theme: BundledTheme): Promise<void> => {
  let pending = pendingThemeLoads.get(theme);
  if (!pending) {
    pending = highlighter.loadTheme(theme);
    pendingThemeLoads.set(theme, pending);
  }
  return pending;
};

const getHighlighter = async (
  language: BundledLanguage,
  theme: BundledTheme,
): Promise<ShikiHighlighter> => {
  const highlighter = await getSharedHighlighter();
  await Promise.all([
    ensureLanguageLoaded(highlighter, language),
    ensureThemeLoaded(highlighter, theme),
  ]);
  return highlighter;
};

const createRawCodeTokens = (code: string): TokenizedCode => ({
  bg: "transparent",
  fg: "inherit",
  tokens: code.split("\n").map((line) =>
    line === ""
      ? []
      : [
          {
            color: "inherit",
            content: line,
          } as ThemedToken,
        ],
  ),
});

// 带缓存的异步高亮入口；React 组件只应在 effect 中调用。
export const highlightCode = (
  code: string,
  language: string,
  theme?: BundledTheme,
  // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-callbacks)
  callback?: (result: TokenizedCode) => void,
): TokenizedCode | null => {
  if (!shouldUseSyntaxHighlighting(language)) {
    // 文本/日志代码块没有语法高亮收益，却会在聊天流式渲染和历史恢复时进入
    // Shiki 的异步状态机。之前修掉了 render 阶段 setState，但这条纯文本路径仍可能把
    // CodeViewer 拖进 React #185；这里直接返回 raw tokens，避免启动高亮副作用。
    return createRawCodeTokens(code);
  }

  const resolvedTheme = getResolvedCodeTheme(theme);
  const resolvedLanguage = normalizeCodeLanguage(language);
  const tokensCacheKey = getCodeTokensCacheKey(code, resolvedLanguage, resolvedTheme);

  const cached = tokensCache.get(tokensCacheKey);
  if (cached) {
    // 命中即提升为最近使用，避免当前可见的工作集被后续请求挤掉。
    cacheTokens(tokensCacheKey, cached);
    // 缓存命中时也需要通知 effect，但不能同步触发 setState。
    // 历史消息恢复时大量代码块会在同一次提交后挂载；同步 callback 会把 cache-hit 变成嵌套更新，
    // 和 Streamdown 的重渲染叠在一起时容易触发 React #185。推迟到微任务后再交给幂等 setter。
    if (callback) {
      queueMicrotask(() => callback(cached));
    }
    return cached;
  }

  if (callback) {
    if (!subscribers.has(tokensCacheKey)) {
      subscribers.set(tokensCacheKey, new Set());
    }
    subscribers.get(tokensCacheKey)?.add(callback);
  }

  getHighlighter(resolvedLanguage, resolvedTheme)
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then)
    .then((highlighter) => {
      const availableLangs = highlighter.getLoadedLanguages();
      const langToUse = availableLangs.includes(resolvedLanguage)
        ? resolvedLanguage
        : FALLBACK_CODE_LANGUAGE;

      const result = highlighter.codeToTokens(code, {
        lang: langToUse,
        theme: resolvedTheme,
      });

      const tokenized: TokenizedCode = {
        bg: "transparent",
        fg: result.fg ?? "inherit",
        tokens: result.tokens,
      };

      cacheTokens(tokensCacheKey, tokenized);

      const subs = subscribers.get(tokensCacheKey);
      if (subs) {
        for (const sub of subs) {
          sub(tokenized);
        }
      }
      subscribers.delete(tokensCacheKey);
    })
    // oxlint-disable-next-line eslint-plugin-promise(prefer-await-to-then), eslint-plugin-promise(prefer-await-to-callbacks)
    .catch((error) => {
      // Shiki 加载或 tokenize 失败，组件会停留在无高亮的 rawTokens 状态。
      logger.error(
        `[ShikiHighlighter] 代码高亮失败: language=${resolvedLanguage}, theme=${resolvedTheme}`,
        error,
      );
      subscribers.delete(tokensCacheKey);
    });

  return null;
};
