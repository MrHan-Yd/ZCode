import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { GitRepositorySummary, IPlatformService } from "@zcode/shared";
import { WorkspaceHeader } from "@/WorkspaceHeader.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { GitRepositoryRefreshProvider } from "@/hooks/useGitRepositoryRefresh.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";
import { buildGitToolsModel } from "@/v4/gitToolsModel.js";
import {
  closeStatusPanelOverlay,
  resetStatusPanelOverlay,
  subscribeStatusPanelOpened,
  useStatusPanelOverlayOpen,
} from "@/v4/statusPanelOverlayStore.js";
import "@/styles.css";

const PATH = "/synthetic/git-alignment";
const SESSION = "fixture-git-alignment-session";
const noAction = () => {};
const summary: GitRepositorySummary = {
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
};
const tools = buildGitToolsModel({
  gitSummary: summary,
  gitDirtyFileCount: 18,
  gitWorktreeChangeSummary: { added: 2_500, removed: 34 },
});
const refresh = async () => ({
  summary,
  identity: null,
  stagedChanges: [],
  unstagedChanges: [],
  branchComparison: null,
});

export function mountGitToolsPanelAlignmentFixture(): void {
  const query = new URLSearchParams(location.search);
  const locale = query.get("locale") === "en-US" ? "en-US" : "zh-CN";
  const dark = query.get("theme") !== "light";
  const platformName = query.get("platform") ?? "win32";
  const mobile = platformName === "mobile";
  const desktop = platformName !== "web" && !mobile;
  const sidePaneOpen = query.get("sidePane") === "open";
  document.documentElement.className = dark ? "dark theme-zai-dark" : "theme-zai-light";
  document.documentElement.lang = locale;
  document.documentElement.style.setProperty("--ui-font-size", query.get("fontSize") ?? "14px");
  const forbidden: string[] = [];
  const denyMutation = () => {
    forbidden.push("mutation");
    throw new Error("fixture.readOnly");
  };
  const services = {
    settingService: {
      async get() {
        return {};
      },
      update: denyMutation,
    },
    gitService: { refresh },
  } as unknown as IServiceAccessor;
  const platform = {
    platform: desktop ? platformName : "win32",
    onSettingsChanged: () => noAction,
    executeDesktopCommand: denyMutation,
  } as unknown as IPlatformService;
  resetStatusPanelOverlay();

  function Harness() {
    const [gitOpen, setGitOpen] = useState(false);
    const statusOpen = useStatusPanelOverlayOpen(SESSION);
    useEffect(() => subscribeStatusPanelOpened(() => setGitOpen(false)), []);
    const setOpen = (open: boolean) => {
      if (open) resetStatusPanelOverlay();
      setGitOpen(open);
    };
    return (
      <main className="flex h-dvh min-w-0 flex-col bg-background text-foreground p-1">
        <div
          data-testid="fixture-conversation-frame"
          className="relative flex min-h-0 flex-1 flex-col"
        >
          <WorkspaceHeader
            variant="draft"
            workspaceAbsPath={PATH}
            projectName="Synthetic Git"
            activeTaskTitle="Synthetic alignment"
            hasUpdateReady={false}
            activeTaskId={SESSION}
            activeSessionId={SESSION}
            activeTraceId={null}
            activeTaskProvider="glm"
            sessionLogPath={null}
            nativeSessionLogProvider={null}
            nativeSessionLogPath={null}
            nativeSessionLogExists={false}
            nativeSessionLogLoading={false}
            workspaceHeaderState={{ selectedProvider: "glm" }}
            gitSummary={summary}
            gitDirtyFileCount={18}
            gitTools={tools}
            gitToolsPanelOpen={gitOpen}
            onGitToolsPanelOpenChange={setOpen}
            isDesktop={desktop}
            isWindowsDesktop={platformName === "win32"}
            isMacDesktop={platformName === "darwin"}
            simplifyForNarrowRemote={mobile}
            isSidebarVisible={query.get("sidebar") !== "hidden"}
            isTerminalOpen={false}
            isSidePaneOpen={sidePaneOpen}
            onRefreshGit={noAction}
            onOpenGitReview={noAction}
            onToggleTerminal={noAction}
            onToggleSidePane={noAction}
            onToggleBrowser={noAction}
            onReloadSession={noAction}
            onCreateTask={noAction}
            onOpenWorkspace={noAction}
          />
          <section data-testid="fixture-conversation-body" className="relative min-h-0 flex-1">
            <ConversationStatusPanel
              workspacePath={PATH}
              open={statusOpen}
              onClose={() => closeStatusPanelOverlay(SESSION)}
            />
            <p data-testid="fixture-conversation-message" className="m-8 text-ui-base">
              {locale === "zh-CN" ? "对，你的建议很好，就这么做" : "Use the same right margin."}
            </p>
          </section>
        </div>
        <output data-testid="fixture-forbidden" className="hidden">
          {forbidden.join(",")}
        </output>
      </main>
    );
  }

  createRoot(document.getElementById("root")!).render(
    <ZCodeIntlProvider initialLocale={locale}>
      <PlatformProvider platform={platform}>
        <ServiceProvider services={services}>
          <TooltipProvider>
            <GitRepositoryRefreshProvider refresh={refresh}>
              <Harness />
            </GitRepositoryRefreshProvider>
          </TooltipProvider>
        </ServiceProvider>
      </PlatformProvider>
    </ZCodeIntlProvider>,
  );
}
