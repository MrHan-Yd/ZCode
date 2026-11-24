import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor, ModelSelectionView } from "@zcode/services";
import { Event } from "@zcode/rpc";
import {
  type AppSettings,
  type GitGenerateCommitMessageRequest,
  type GitRefreshResult,
  type IPlatformService,
  type ModelSelection,
} from "@zcode/shared";
import { WorkspaceHeader } from "@/WorkspaceHeader.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ComposerModelSelectionProvider } from "@/hooks/useComposerModelSelection.js";
import { GitRepositoryRefreshProvider } from "@/hooks/useGitRepositoryRefresh.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { GitCommitMessageModelRow } from "@/settings/GitCommitMessageModelRow.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { useDraftConfigControl } from "@/v4/composer/useDraftConfigControl.js";
import { buildGitToolsModel } from "@/v4/gitToolsModel.js";
import "@/styles.css";

const PATH = "/synthetic/git-model";
const SETTINGS_KEY = "fixture-git-model-settings";
const choices = [
  {
    providerId: "fixture-channel-a",
    modelId: "session-model-a",
    options: { reasoningLevel: "high" },
  },
  {
    providerId: "fixture-channel-b",
    modelId: "session-model-b",
    options: { reasoningLevel: "high" },
  },
  {
    providerId: "fixture-channel-pinned",
    modelId: "fixed-model",
    options: { reasoningLevel: "high" },
  },
];
const host = { providerId: "fixture-host-default", modelId: "host-default-model" };

export interface GitModelFixtureControl {
  requests: GitGenerateCommitMessageRequest[];
  mutations: string[];
  patches: Partial<AppSettings>[];
  setScope(sessionId: string | null, workspaceIdentity?: string): void;
  setModel(providerId: string, modelId: string): void;
  clearModel(): void;
  setFailure(failed: boolean): void;
  holdGeneration(): void;
  releaseGeneration(): Promise<void>;
}

declare global {
  interface Window {
    __gitModelFixture: GitModelFixtureControl;
  }
}

export function mountGitCommitMessageModelFixture(): void {
  const query = new URLSearchParams(location.search);
  const locale = query.get("locale") === "en-US" ? "en-US" : "zh-CN";
  const theme = query.get("theme") === "light" ? "zai-light" : "zai-dark";
  document.documentElement.className =
    theme === "zai-dark" ? "dark theme-zai-dark" : "theme-zai-light";
  let settings: AppSettings = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  const requests: GitGenerateCommitMessageRequest[] = [];
  const mutations: string[] = [];
  const patches: Partial<AppSettings>[] = [];
  let failed = false;
  let generationBarrier: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  const view = {
    revision: 1,
    preferredSelection: host,
    providers: choices.map((choice) => ({
      providerId: choice.providerId,
      providerName: choice.providerId,
      config: { api: { type: "openai-compatible" }, access: { type: "api-key" } },
      models: [
        {
          modelId: choice.modelId,
          config: {
            properties: { inputFormat: { supportsImage: false } },
            optionSpecs: { reasoningLevel: { values: ["low", "high"] } },
          },
        },
      ],
    })),
  } as unknown as ModelSelectionView;
  const modelSelectionService = {
    onDidChange: Event.None,
    async getView(input?: { selection: ModelSelection | null }) {
      return { ...view, ...(input ? { effectiveSelection: input.selection } : {}) };
    },
  };
  const result: GitRefreshResult = {
    summary: {
      workspacePath: PATH,
      repoRoot: PATH,
      workspaceInRepoPath: ".",
      autoRefreshWatchPaths: [],
      branchName: "main",
      trackingBranchName: "origin/main",
      headRefType: "branch",
      ahead: 0,
      behind: 0,
      isDirty: true,
      isGitAvailable: true,
      isRepository: true,
    },
    identity: {
      userName: "Fixture",
      userEmail: "fixture@example.invalid",
      nameSource: "local",
      emailSource: "local",
    },
    stagedChanges: [],
    unstagedChanges: [
      {
        path: `${PATH}/src/sample.ts`,
        repoRelativePath: "src/sample.ts",
        workspaceRelativePath: "src/sample.ts",
        kind: "modified",
        section: "unstaged",
        added: 2,
        removed: 1,
        isStaged: false,
        isUntracked: false,
        isConflicted: false,
      },
    ],
    branchComparison: null,
  };
  const refresh = async () => structuredClone(result);
  const services = {
    modelSelectionService,
    settingService: {
      async get() {
        return structuredClone(settings);
      },
      async update(patch: Partial<AppSettings>) {
        const persisted = JSON.parse(JSON.stringify(patch)) as Partial<AppSettings>;
        patches.push(persisted);
        settings = { ...settings, ...persisted };
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      },
    },
    gitService: {
      refresh,
      async generateCommitMessage(params: GitGenerateCommitMessageRequest) {
        requests.push(JSON.parse(JSON.stringify(params)));
        const barrier = generationBarrier;
        if (barrier) await barrier.promise;
        if (failed) throw new Error("fixture provider request failed");
        const selection = params.selection ?? host;
        return {
          message: `chore: ${selection.modelId}`,
          providerId: selection.providerId,
          model: selection.modelId,
        };
      },
      async stagePaths() {
        mutations.push("stage");
      },
      async commit() {
        mutations.push("commit");
        return { commitHash: "fixture-hash", summary: result.summary };
      },
      async push() {
        mutations.push("push");
        throw new Error("fixture must not push");
      },
    },
  } as unknown as IServiceAccessor;
  const platform = {
    platform: "win32",
    onSettingsChanged: () => () => {},
    syncAppSettings: () => {},
  } as unknown as IPlatformService;
  const tools = buildGitToolsModel({
    isOfficeMode: false,
    gitSummary: result.summary,
    gitDirtyFileCount: 1,
    gitWorktreeChangeSummary: { added: 2, removed: 1 },
  });
  const groups = buildRegistryModelSelectGroups("glm", view);
  const noAction = () => {};

  function Harness() {
    const [scope, setScope] = useState<{ sessionId: string | null; workspaceIdentity?: string }>({
      sessionId: "fixture-session-a",
    });
    const [open, setOpen] = useState(false);
    const config = useDraftConfigControl({
      workspacePath: PATH,
      workspaceIdentity: scope.workspaceIdentity,
      sessionId: scope.sessionId,
      sessionConfig: {
        mode: "build",
        modelSelection: scope.sessionId === "fixture-session-b" ? choices[1] : choices[0],
      },
      agentStartupAllowed: false,
      modelSelectionService: services.modelSelectionService,
      registerModelSelection: true,
    });
    window.__gitModelFixture = {
      requests,
      mutations,
      patches,
      setScope: (sessionId, workspaceIdentity) => {
        setScope({ sessionId, workspaceIdentity });
        setOpen(false);
      },
      setModel: config.handleDraftSelectModel,
      clearModel: () => config.replaceComposerDraft({ text: "", mode: "build" }),
      setFailure: (next) => {
        failed = next;
      },
      holdGeneration: () => {
        generationBarrier = Promise.withResolvers<void>();
      },
      releaseGeneration: async () => {
        generationBarrier?.resolve();
        generationBarrier = null;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      },
    };
    const select = useCallback(
      (value: string) => {
        const selection = decodeCustomModelValue(value);
        if (selection?.providerId && selection.modelName)
          config.handleDraftSelectModel(selection.providerId, selection.modelName);
      },
      [config.handleDraftSelectModel],
    );
    const selection = config.draftConfig.modelSelection;
    return (
      <main className="min-h-dvh bg-background text-foreground">
        <WorkspaceHeader
          variant="draft"
          workspaceAbsPath={PATH}
          workspaceIdentity={scope.workspaceIdentity}
          projectName="Synthetic Git"
          activeTaskTitle="Synthetic session"
          hasUpdateReady={false}
          activeTaskId={scope.sessionId}
          activeSessionId={null}
          activeTraceId={null}
          activeTaskProvider="glm"
          sessionLogPath={null}
          nativeSessionLogProvider={null}
          nativeSessionLogPath={null}
          nativeSessionLogExists={false}
          nativeSessionLogLoading={false}
          workspaceHeaderState={{ selectedProvider: "glm" }}
          gitSummary={result.summary}
          gitDirtyFileCount={1}
          gitTools={tools}
          gitToolsPanelOpen={open}
          onGitToolsPanelOpenChange={setOpen}
          isDesktop={false}
          isSidebarVisible
          isTerminalOpen={false}
          isSidePaneOpen={false}
          onRefreshGit={noAction}
          onToggleTerminal={noAction}
          onToggleSidePane={noAction}
          onToggleBrowser={noAction}
          onReloadSession={noAction}
          onCreateTask={noAction}
          onOpenWorkspace={noAction}
        />
        <section className="mx-auto max-w-3xl space-y-4 p-4">
          <ModelConfigSelect
            modelGroups={groups}
            normalizedValue={
              selection ? encodeCustomModelValue(selection.providerId, selection.modelId) : ""
            }
            triggerLabel={selection?.modelId ?? "No model"}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={() => false}
            onValueChange={select}
            manageModelsLabel="Models"
            triggerTestId="fixture-composer-model"
            labelVisibilityClassName="inline-flex"
            triggerClassName="h-8 border px-3"
          />
          <GitCommitMessageModelRow />
        </section>
      </main>
    );
  }
  createRoot(document.getElementById("root")!).render(
    <ZCodeIntlProvider initialLocale={locale}>
      <PlatformProvider platform={platform}>
        <ServiceProvider services={services}>
          <TabStoreProvider>
            <TooltipProvider>
              <ComposerModelSelectionProvider>
                <GitRepositoryRefreshProvider refresh={refresh}>
                  <Harness />
                </GitRepositoryRefreshProvider>
              </ComposerModelSelectionProvider>
            </TooltipProvider>
          </TabStoreProvider>
        </ServiceProvider>
      </PlatformProvider>
    </ZCodeIntlProvider>,
  );
}
