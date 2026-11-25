import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { type ZCodeContextUsageBreakdownItem, type Locale } from "@zcode/shared";
import { sessionUsageStateSchema } from "@zcode/shared/zcode-protocol-v4";
import { ChatContextUsage } from "@/chat-input-toolbar/contextUsage.js";
import { ZCodeIntlProvider, useZCodeIntl } from "@/i18n/IntlProvider.js";
import "@/styles.css";

interface ContextUsageFixtureBridge {
  setBreakdown(items: ZCodeContextUsageBreakdownItem[]): void;
}

declare global {
  interface Window {
    __contextUsageSubagentsTest?: ContextUsageFixtureBridge;
  }
}

export function mountContextUsageSubagentsFixture(): void {
  const params = new URLSearchParams(location.search);
  const locale: Locale = params.get("locale") === "en-US" ? "en-US" : "zh-CN";
  const theme = params.get("theme") === "light" ? "light" : "dark";
  document.documentElement.lang = locale;
  document.documentElement.classList.add(`theme-zai-${theme}`);
  document.documentElement.style.setProperty("--ui-font-size", params.get("fontSize") ?? "14px");
  const initial = sessionUsageStateSchema.parse({
    contextWindow: {
      usedTokens: 170000,
      maxTokens: 1050000,
      autoCompactThresholdTokens: null,
      cache: { inputTokens: 1000, cacheReadTokens: 982, cacheWriteTokens: 0, hitRate: 0.982 },
      breakdown: [
        { source: "messages", chars: 800 },
        { source: "system_tool_schemas", chars: 100 },
        { source: "skills", chars: 30 },
        { source: "system_prompt", chars: 50 },
        { source: "subagents", chars: 20 },
      ],
    },
    cumulative: { inputTokens: 170000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  const windowUsage = initial.contextWindow!;
  function Harness() {
    const { intl } = useZCodeIntl();
    const [breakdown, setBreakdown] = useState(windowUsage.breakdown ?? []);
    window.__contextUsageSubagentsTest = {
      setBreakdown(items) {
        flushSync(() => setBreakdown(items));
      },
    };
    return (
      <main className="flex h-dvh min-w-0 flex-col bg-background text-foreground">
        <div className="min-h-0 flex-1" />
        <footer className="flex min-w-0 justify-end p-4">
          <ChatContextUsage
            taskUsage={{
              used: windowUsage.usedTokens,
              size: windowUsage.maxTokens,
              cache: windowUsage.cache,
              breakdown,
            }}
            selectedProvider="glm"
            intl={intl}
            locale={locale}
          />
        </footer>
      </main>
    );
  }
  const element = document.getElementById("root");
  if (!element) throw new Error("Missing context usage fixture root");
  createRoot(element).render(
    <ZCodeIntlProvider initialLocale={locale}>
      <Harness />
    </ZCodeIntlProvider>,
  );
}
