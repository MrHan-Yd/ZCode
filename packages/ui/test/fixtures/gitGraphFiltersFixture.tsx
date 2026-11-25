import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { WorkspaceGitToolsEntry } from "@/WorkspaceGitToolsEntry.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { GitRepositoryRefreshProvider } from "@/hooks/useGitRepositoryRefresh.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { buildGitToolsModel } from "@/v4/gitToolsModel.js";
import { GRAPH_IDENTITIES, GRAPH_PATH } from "./gitGraphFiltersData.js";
import { createGitGraphFiltersService } from "./gitGraphFiltersService.js";
import "@/styles.css";

type FixtureService = ReturnType<typeof createGitGraphFiltersService>;
const noAction = () => {};

function GitGraphFiltersHarness({
  fixture,
  services,
  initialIdentity,
}: {
  fixture: FixtureService;
  services: IServiceAccessor;
  initialIdentity?: string;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState({ identity: initialIdentity, services });
  const tools = buildGitToolsModel({ gitSummary: fixture.summary });
  useEffect(() => {
    window.__gitGraphFiltersTest.setScope = (identity, replaceService = false) => {
      setScope((current) => ({
        identity,
        services: replaceService
          ? ({
              ...current.services,
              gitService: fixture.makeGitService(),
            } as unknown as IServiceAccessor)
          : current.services,
      }));
    };
    window.__gitGraphFiltersTest.closeTools = () => setOpen(false);
  }, [fixture]);
  return (
    <ServiceProvider services={scope.services}>
      <GitRepositoryRefreshProvider refresh={fixture.refresh}>
        <main className="flex h-dvh min-w-0 flex-col bg-background p-1 text-foreground">
          <header className="relative flex h-12 shrink-0 items-center justify-end px-4">
            {tools ? (
              <WorkspaceGitToolsEntry
                workspacePath={GRAPH_PATH}
                workspaceIdentity={scope.identity}
                gitTools={tools}
                open={open}
                onOpenChange={setOpen}
                onRefreshGit={() => {
                  void fixture.refresh();
                }}
              />
            ) : null}
          </header>
          <p className="m-8 text-ui-base">Synthetic Git graph workspace</p>
        </main>
      </GitRepositoryRefreshProvider>
    </ServiceProvider>
  );
}

export function mountGitGraphFiltersFixture(): void {
  const query = new URLSearchParams(location.search);
  const locale = query.get("locale") === "zh-CN" ? "zh-CN" : "en-US";
  const dark = query.get("theme") === "dark";
  document.documentElement.className = dark ? "dark theme-zai-dark" : "theme-zai-light";
  document.documentElement.lang = locale;
  const fixture = createGitGraphFiltersService(
    query.get("detached") === "true",
    query.get("legacy") === "true",
    query.get("empty") === "true",
  );
  window.__gitGraphFiltersTest = {
    ...fixture.control,
    setScope: noAction,
    closeTools: noAction,
  };
  const platform = {
    platform: "win32",
    onSettingsChanged: () => noAction,
    executeDesktopCommand: fixture.deny("executeDesktopCommand"),
    selectDirectory: fixture.deny("selectDirectory"),
    openExternal: fixture.deny("openExternal"),
  } as unknown as IPlatformService;
  const services = {
    gitService: fixture.makeGitService(),
    settingService: {
      async get() {
        return {};
      },
      update: fixture.deny("settings.update"),
    },
  } as unknown as IServiceAccessor;
  createRoot(document.getElementById("root")!).render(
    <ZCodeIntlProvider initialLocale={locale}>
      <PlatformProvider platform={platform}>
        <TooltipProvider>
          <GitGraphFiltersHarness
            fixture={fixture}
            services={services}
            initialIdentity={query.get("local") === "true" ? undefined : GRAPH_IDENTITIES[0]}
          />
        </TooltipProvider>
      </PlatformProvider>
    </ZCodeIntlProvider>,
  );
}
