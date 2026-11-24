import { createRoot } from "react-dom/client";
import { useState } from "react";
import type { IPlatformService, Locale } from "@zcode/shared";
import { DesktopCommandIds } from "@zcode/shared";
import { AboutDialogHost } from "@/AboutDialogHost.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import "@/styles.css";

export interface AboutFixtureControl {
  setStage(stage: "startup" | "workspace"): void;
  setWhiteCalibration(white: boolean): void;
}

declare global {
  interface Window {
    __aboutFixture: AboutFixtureControl;
  }
}

function AboutFixture({ platform }: { platform: IPlatformService }) {
  const [stage, setStage] = useState<"startup" | "workspace">("startup");
  const [white, setWhite] = useState(false);
  window.__aboutFixture = { setStage, setWhiteCalibration: setWhite };
  return (
    <>
      <AboutDialogHost key="desktop-about" platform={platform} />
      <main className="h-dvh bg-background p-6 text-foreground" data-testid="about-fixture-root">
        <div className="flex items-center justify-between">
          <h1 className="text-ui-lg">
            {stage === "startup" ? "Startup fixture" : "Workspace fixture"}
          </h1>
          <WorkspaceHelpMenuButton isDesktop />
        </div>
        <textarea
          aria-label="Synthetic conversation input"
          data-testid="about-fixture-input"
          className="mt-6 h-24 w-full rounded-lg border border-border bg-input p-3 text-ui-base"
          defaultValue="Synthetic content only. No Host or Agent is started."
        />
        <button
          data-testid="native-menu-about"
          className="mt-4 rounded-lg bg-secondary px-3 py-2 text-ui-base"
          onClick={() => void platform.executeDesktopCommand(DesktopCommandIds.ShowAbout)}
        >
          Native menu command fixture
        </button>
      </main>
      {white ? (
        <div
          data-testid="screen-calibration"
          style={{ position: "fixed", inset: 0, zIndex: 10000, background: "#ffffff" }}
        />
      ) : null}
    </>
  );
}

export function mountAboutFixture(platform: IPlatformService) {
  const parameters = new URLSearchParams(location.search);
  const locale: Locale = parameters.get("locale") === "en-US" ? "en-US" : "zh-CN";
  const theme = parameters.get("theme") === "light" ? "zai-light" : "zai-dark";
  localStorage.clear();
  document.documentElement.className =
    theme === "zai-dark" ? "dark theme-zai-dark" : "theme-zai-light";
  createRoot(document.getElementById("root")!).render(
    <ZCodeIntlProvider initialLocale={locale}>
      <PlatformProvider platform={platform}>
        <TooltipProvider>
          <AboutFixture platform={platform} />
        </TooltipProvider>
      </PlatformProvider>
    </ZCodeIntlProvider>,
  );
}
