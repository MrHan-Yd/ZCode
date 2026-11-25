import { StrictMode, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, ModelSelectionView } from "@zcode/services";
import { buildRemoteWorkspaceIdentity, type IPlatformService } from "@zcode/shared";
import { WorkspaceStatusEntry } from "@/WorkspaceStatusEntry.js";
import { Button } from "@/components/ui/button.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { CodingPlanUpgradeDialogProvider } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import {
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  bindRemoteWorkspaceIdentity,
} from "@/store/remoteWorkspaceSessionStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import { SessionPane } from "@/v4/SessionPane.js";
import {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "@/v4/V4ConversationContext.js";
import {
  resetStatusPanelOverlay,
  subscribeStatusPanelOpened,
} from "@/v4/statusPanelOverlayStore.js";
import {
  createStatusPanelFixtureTransport,
  statusFixtureNoEvent,
} from "./statusPanelSendAutoOpenTransport.js";
import {
  STATUS_WORKSPACE_PATH as PATH,
  STATUS_SESSION_ID as SESSION,
  STATUS_CREATED_ID as CREATED,
  STATUS_MODEL_SELECTION as selection,
  type StatusContent,
  type StatusScope,
  type StatusPanelSendAudit,
} from "./statusPanelSendAutoOpenData.js";
import "@/styles.css";

export function mountStatusPanelSendAutoOpenFixture(element: HTMLElement): void {
  const query = new URLSearchParams(location.search);
  const mobile = query.get("mode") === "web-remote-replayable";
  const draft = query.get("draft") === "true";
  const locale = query.get("locale") === "zh-CN" ? "zh-CN" : "en-US";
  const theme = mobile ? "zai-dark" : "zai-light";
  localStorage.clear();
  localStorage.setItem("zcode-theme", theme);
  document.documentElement.className = mobile ? `dark theme-${theme}` : `theme-${theme}`;
  const remoteIdentity = (host: string) =>
    buildRemoteWorkspaceIdentity(PATH, { kind: "ssh", host, username: "fixture" });
  const initialScope: StatusScope = {
    sessionId: draft ? null : SESSION,
    ...(mobile
      ? {
          workspaceIdentity: remoteIdentity("fixture-a.invalid"),
          remoteSessionId: "fixture-attachment-a",
        }
      : {}),
  };
  const audit: StatusPanelSendAudit = {
    commands: [],
    acks: [],
    opened: [],
    recovery: [],
    navigation: [],
    forbidden: [],
    delivery: [],
    ready: false,
  };
  const backend = createStatusPanelFixtureTransport({
    mobile,
    fallback: query.get("fallback") === "true",
    initialContent: (query.get("content") ?? "empty") as StatusContent,
    audit,
  });
  const view = {
    revision: 1,
    preferredSelection: selection,
    effectiveSelection: selection,
    providers: [
      {
        providerId: selection.providerId,
        providerName: "Synthetic API",
        config: { api: { type: "openai-compatible" }, access: { type: "api-key" } },
        models: [
          {
            modelId: selection.modelId,
            config: {
              properties: { inputFormat: { supportsImage: false } },
              optionSpecs: { reasoningLevel: { values: ["off"], defaultValue: "off" } },
            },
          },
        ],
      },
    ],
  } as unknown as ModelSelectionView;
  const services = {
    zcodeAgentService: backend.agent,
    broadcastService: {
      onMessage: statusFixtureNoEvent,
      async send() {
        return backend.deny("broadcast.write");
      },
    },
    clientConfigService: {
      async getSnapshot() {
        return { pluginStoreOrder: null };
      },
    },
    subagentsService: {
      async list() {
        return { agents: [], capability: null };
      },
    },
    modelSelectionService: {
      onDidChange: statusFixtureNoEvent,
      async getView() {
        return view;
      },
    },
    settingService: {
      async get() {
        return {
          locale,
          followupMode: "queue",
          messageStreamShowTodos: false,
          toolGroupingExploreEnabled: false,
          toolGroupingTerminalEnabled: false,
          toolGroupingChangesEnabled: false,
        };
      },
      async update() {
        return backend.deny("settings.write");
      },
    },
  } as unknown as IServiceAccessor;
  registerBaseWorkspaceServices(services);
  for (const [host, attachment] of [
    ["fixture-a.invalid", "fixture-attachment-a"],
    ["fixture-b.invalid", "fixture-attachment-b"],
  ] as const) {
    registerRemoteWorkspaceSession({ sessionId: attachment, services });
    bindRemoteWorkspaceIdentity(remoteIdentity(host), attachment);
  }
  const seed = (identity?: string) => {
    const store = useZCodeSessionStore.getState();
    store.setConfigOptions(
      PATH,
      [
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: "build",
          options: [],
        },
      ],
      identity,
    );
    store.setConfigOptionsStatus(PATH, "ready", identity);
    store.setSlashCommands(PATH, [{ name: "fixture", description: "Synthetic command" }], identity);
  };
  seed(initialScope.workspaceIdentity);
  const transport = createAgentConversationTransport(services.zcodeAgentService, {
    workspacePath: PATH,
    workspaceIdentity: initialScope.workspaceIdentity,
  });
  const layer = new SessionDataLayer({ transport });
  const context = {
    layer,
    sendCommand: transport.sendCommand.bind(transport),
    tailPreview: transport.tailPreview.bind(transport),
    workflowRuns: transport.workflowRuns.bind(transport),
    orchestrationState: transport.orchestrationState.bind(transport),
    onRuntimeRestart: transport.onRuntimeRestart.bind(transport),
    attachmentPut: transport.attachmentPut.bind(transport),
    attachmentRead: transport.attachmentRead.bind(transport),
    attachmentReadRange: transport.attachmentReadRange.bind(transport),
    fileChanges: () => Promise.reject(new Error("fixture.unexpectedFileRead")),
    fileRewindPreview: () => Promise.reject(new Error("fixture.unexpectedRewind")),
  } as unknown as V4ConversationContextValue;
  resetStatusPanelOverlay();
  const offOpened = subscribeStatusPanelOpened((id) => audit.opened.push(id));
  const root = createRoot(element);

  function Harness() {
    const [scope, setScope] = useState(initialScope);
    const [visibility, setVisibility] = useState({ focused: true, visible: true });
    const [git, setGit] = useState(false);
    useEffect(() => subscribeStatusPanelOpened(() => setGit(false)), []);
    window.__statusPanelSendTest = {
      audit,
      publish: backend.publish,
      holdAck: backend.holdAck,
      releaseAck: backend.releaseAck,
      rejectNext: backend.rejectNext,
      allowDraftCreate: backend.allowDraftCreate,
      setRouting: (mode) => backend.setRouting(mode, scope.sessionId ?? CREATED),
      setScope(next) {
        seed(next.workspaceIdentity);
        flushSync(() => setScope(next));
      },
      setVisibility(focused, visible) {
        flushSync(() => setVisibility({ focused, visible }));
      },
      dispose() {
        backend.releaseAck();
        root.unmount();
        offOpened();
        layer.dispose();
        resetStatusPanelOverlay();
        localStorage.clear();
      },
    };
    useEffect(() => {
      audit.ready = true;
    }, []);
    return (
      <main className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
        <header className="flex shrink-0 items-center gap-2 p-2">
          {scope.sessionId ? (
            <WorkspaceStatusEntry
              sessionId={scope.sessionId}
              workspacePath={PATH}
              workspaceIdentity={scope.workspaceIdentity}
              remoteSessionId={scope.remoteSessionId}
            />
          ) : null}
          <Button
            data-testid="fixture-git-open"
            onClick={() => {
              resetStatusPanelOverlay();
              setGit(true);
            }}
          >
            Git
          </Button>
          {git ? <span data-testid="fixture-git-panel">Synthetic Git overlay</span> : null}
        </header>
        <div className={visibility.visible ? "min-h-0 flex-1" : "hidden"}>
          <SessionPane
            paneId="fixture-send-pane"
            sessionId={scope.sessionId}
            workspacePath={PATH}
            workspaceIdentity={scope.workspaceIdentity}
            remoteSessionId={scope.remoteSessionId}
            focused={visibility.focused}
            telemetryVisible={visibility.visible}
            isDesktop={!mobile}
            onSessionCreated={(id) => setScope((current) => ({ ...current, sessionId: id }))}
            onOpenSubagentDirectory={() => backend.deny("directory-navigation")}
            onOpenWorkflowRun={(request) => audit.navigation.push(request.runId)}
          />
        </div>
      </main>
    );
  }
  const content =
    query.get("strict") === "true" ? (
      <StrictMode>
        <Harness />
      </StrictMode>
    ) : (
      <Harness />
    );
  root.render(
    <ServiceProvider services={services}>
      <PlatformProvider
        platform={{ onSettingsChanged: () => () => {} } as unknown as IPlatformService}
      >
        <StoreProvider broadcastService={services.broadcastService}>
          <TabStoreProvider>
            <ZCodeIntlProvider initialLocale={locale}>
              <TooltipProvider>
                <CodingPlanUpgradeDialogProvider>
                  <V4ConversationContext.Provider value={context}>
                    {content}
                  </V4ConversationContext.Provider>
                </CodingPlanUpgradeDialogProvider>
              </TooltipProvider>
            </ZCodeIntlProvider>
          </TabStoreProvider>
        </StoreProvider>
      </PlatformProvider>
    </ServiceProvider>,
  );
}
