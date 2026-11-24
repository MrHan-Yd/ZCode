import { useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import {
  ESTIMATED_TOKEN_CHAR_DIVISOR,
  sessionPerformanceBatchResultSchema,
  sessionPerformanceSnapshotSchema,
  type IPlatformService,
  type Locale,
  type ZCodeSessionRunningSubagent,
} from "@zcode/shared";
import { conversationSnapshotSchema, type SessionPhase } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";
import { ComposerSessionStats } from "@/v4/composer/ComposerSessionStats.js";
import {
  createLiveOutputTokenReader,
  type LiveOutputTokenReading,
} from "@/v4/composer/liveOutputTokens.js";
import "@/styles.css";

interface Bootstrap {
  parentId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  locale: Locale;
  theme: "zai-light" | "zai-dark";
  children: ZCodeSessionRunningSubagent[];
}

export interface SessionStatsBrowserBridge {
  readings: Array<LiveOutputTokenReading & { at: number }>;
  forbidden: string[];
  publish(input: { tokens: number; turnId: string; firstRowId: number }): void;
  stop(): void;
}

declare global {
  interface Window {
    __sessionPerformanceStatsTest?: SessionStatsBrowserBridge;
  }
}

export async function mountSessionPerformanceStatsFixture(element: HTMLElement): Promise<void> {
  const query = location.search;
  async function read(operation: string, params: unknown = {}): Promise<unknown> {
    const response = await fetch(`/__fixture/read${query}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation, params }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
  const bootstrap = (await read("bootstrap")) as Bootstrap;
  const { parentId, workspacePath, workspaceIdentity, locale, theme, children } = bootstrap;
  const reader = createLiveOutputTokenReader();
  const readings: SessionStatsBrowserBridge["readings"] = [];
  const forbidden: string[] = [];
  const agent: Pick<
    IServiceAccessor["zcodeAgentService"],
    "readSessionPerformance" | "readSessionPerformanceBatch"
  > = {
    async readSessionPerformance(params) {
      return sessionPerformanceSnapshotSchema.parse(await read("single", params));
    },
    async readSessionPerformanceBatch(params) {
      return sessionPerformanceBatchResultSchema.parse(await read("batch", params));
    },
  };
  // fixture 只实现真实组件消费的只读契约，不构造生产 Service、Host 或配置读写路径。
  const services = { zcodeAgentService: agent } as unknown as IServiceAccessor;
  const platform = { onSettingsChanged: () => () => {} } as unknown as IPlatformService;
  const denyMutation = () => {
    forbidden.push("mutation");
    throw new Error("fixture.readOnly");
  };
  const readOutputTokens = (): LiveOutputTokenReading => {
    const reading = reader.read();
    readings.push({ ...reading, at: Date.now() });
    return reading;
  };
  document.documentElement.lang = locale;
  document.documentElement.classList.add(`theme-${theme}`);

  function Harness() {
    const [phase, setPhase] = useState<SessionPhase>("running");
    window.__sessionPerformanceStatsTest = {
      readings,
      forbidden,
      publish({ tokens, turnId, firstRowId }) {
        const allowed = { allowed: true };
        const snapshot = conversationSnapshotSchema.parse({
          protocolVersion: 1,
          sessionId: parentId,
          logEpoch: "fixture-epoch",
          seq: readings.length + 1,
          revision: 1,
          meta: { title: "Synthetic performance regression", titleSource: "custom" },
          control: {
            phase: "running",
            sessionEnded: false,
            canStop: true,
            stopState: "idle",
            stopTargetKind: "unknown",
            activeWorks: [],
            lastError: null,
            apiRetry: null,
          },
          availability: {
            fork: allowed,
            compact: allowed,
            switchModelConfig: allowed,
            setFollowupMode: allowed,
            queueEdit: allowed,
            sendQueuedNow: allowed,
            pauseGoal: allowed,
            resumeGoal: allowed,
          },
          inputRouting: { mode: "startNow" },
          config: {
            provider: "fixture",
            model: "fixture",
            thought: "",
            followupMode: "queue",
            mode: "build",
          },
          usage: {
            contextWindow: null,
            cumulative: {
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
          queue: { items: [], autoDrain: true },
          pendingInteractions: [],
          pendingCommands: [],
          backgroundWorks: [],
          subagents: { revision: 1, childSessionIds: [], running: [], endedTotal: 0 },
          goal: null,
          plan: null,
          rows: {
            window: [
              {
                rowId: firstRowId,
                turnId,
                createdAt: Date.now(),
                createdAtSeq: 1,
                kind: "assistantText",
                state: "streaming",
                text: "a".repeat(tokens * ESTIMATED_TOKEN_CHAR_DIVISOR),
              },
            ],
            totalCount: 1,
            firstRowId,
          },
        });
        reader.setSnapshot(snapshot, true);
        flushSync(() => setPhase("running"));
      },
      stop() {
        reader.setSnapshot(null, false);
        flushSync(() => setPhase("completedInterrupted"));
      },
    };
    return (
      <main className="relative flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
        <div className="relative min-h-0 min-w-0 flex-1">
          <ConversationStatusPanel
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            parentSessionId={parentId}
            runningSubagents={children}
            open
            onCancelBackgroundWork={denyMutation}
          />
        </div>
        <footer className="flex min-w-0 shrink-0 items-center justify-end p-4">
          <ComposerSessionStats
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            sessionId={parentId}
            phase={phase}
            readOutputTokens={readOutputTokens}
          />
        </footer>
      </main>
    );
  }
  createRoot(element).render(
    <ServiceProvider services={services}>
      <PlatformProvider platform={platform}>
        <ZCodeIntlProvider initialLocale={locale}>
          <TooltipProvider>
            <Harness />
          </TooltipProvider>
        </ZCodeIntlProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
}
