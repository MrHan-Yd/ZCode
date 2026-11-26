import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { ProviderConfigObject } from "@zcode/provider";
import type { ModelConnectivityResult } from "@zcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type {
  ProviderSettingsFormModel,
  ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";
import { InlineEditableProviderCard } from "@/settings/model-provider-section/InlineEditableProviderCard.js";
import "@/styles.css";

const PROVIDER_ID = "fixture-gemini-provider";
const MODEL_ID = "gemini-2.5-pro-fixture";
const BASE_URL = "https://gateway.example.test/proxy/google";
const API_KEY = "fixture-api-key";
const HEADER_NAME = "x-fixture-header";
const HEADER_VALUE = "keep-me";
const STORAGE_KEY = "fixture-gemini-provider-overlay";

export interface ModelProviderGeminiFormatSave {
  api: ProviderConfigObject["api"] | null;
}

export interface ModelProviderGeminiFormatProbe {
  providerId: string;
  modelId: string;
  apiFormat: string | null;
  baseUrl: string | null;
  apiKey: string | null;
  header: string | null;
}

export interface ModelProviderGeminiFormatFixtureControl {
  readonly constants: {
    providerId: string;
    modelId: string;
    baseUrl: string;
    apiKey: string;
    headerName: string;
    headerValue: string;
  };
  readonly saves: ModelProviderGeminiFormatSave[];
  readonly probes: ModelProviderGeminiFormatProbe[];
  readonly events: string[];
}

declare global {
  interface Window {
    __modelProviderGeminiFormatFixture: ModelProviderGeminiFormatFixtureControl;
  }
}

const MODEL: ProviderSettingsFormModel = {
  kind: "candidate",
  modelId: MODEL_ID,
  builtin: false,
  personalConfig: {},
  config: {
    properties: {
      contextWindow: 1_048_576,
      inputFormat: {
        supportsText: true,
        supportsImage: true,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
    },
  },
  hasPersonalConfig: true,
  executable: true,
  selectable: true,
};

function readPersonalConfig(): ProviderConfigObject {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ProviderConfigObject) : {};
  } catch {
    return {};
  }
}

function buildProvider(personalConfig: ProviderConfigObject): ProviderSettingsFormProvider {
  return {
    providerId: PROVIDER_ID,
    providerName: "Fixture Gemini",
    enabled: true,
    executable: true,
    hasPersonalConfig: Object.keys(personalConfig).length > 0,
    personalConfig,
    config: {
      access: { type: "api-key", apiKey: API_KEY },
      // 用户既有 URL/key/headers 只在个人覆盖存在时被覆盖；类型切换本身不得改写它们。
      api: {
        type: "anthropic-messages",
        baseUrl: BASE_URL,
        headers: { [HEADER_NAME]: HEADER_VALUE },
        ...personalConfig.api,
      },
    },
    models: [MODEL],
  };
}

export function mountModelProviderGeminiFormatFixture(): void {
  const query = new URLSearchParams(location.search);
  const locale = query.get("locale") === "en-US" ? "en-US" : "zh-CN";
  const theme = query.get("theme") === "light" ? "zai-light" : "zai-dark";
  document.documentElement.className =
    theme === "zai-dark" ? "dark theme-zai-dark" : "theme-zai-light";

  const saves: ModelProviderGeminiFormatSave[] = [];
  const probes: ModelProviderGeminiFormatProbe[] = [];
  const events: string[] = [];
  const services = {
    providerSettingsService: {
      async resolveModelConfig() {
        return { inheritedConfig: MODEL.config, personalConfig: {} };
      },
    },
  } as unknown as IServiceAccessor;

  function Harness() {
    const [personalConfig, setPersonalConfig] = useState<ProviderConfigObject>(readPersonalConfig);
    const provider = useMemo(() => buildProvider(personalConfig), [personalConfig]);

    const handleSave = async (next: ProviderSettingsFormProvider): Promise<void> => {
      const persisted = structuredClone(next.personalConfig);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
      saves.push({ api: structuredClone(persisted.api ?? null) });
      events.push(`save:${persisted.api?.type ?? "unchanged"}`);
      setPersonalConfig(persisted);
    };

    const handleTestModel = async (
      providerId: string,
      modelId: string,
    ): Promise<ModelConnectivityResult> => {
      const effective = buildProvider(readPersonalConfig()).config;
      probes.push({
        providerId,
        modelId,
        apiFormat: effective.api?.type ?? null,
        baseUrl: effective.api?.baseUrl ?? null,
        apiKey: effective.access?.type === "api-key" ? (effective.access.apiKey ?? null) : null,
        header: effective.api?.headers?.[HEADER_NAME] ?? null,
      });
      events.push(`probe:${providerId}:${modelId}`);
      return { success: true };
    };

    return (
      <InlineEditableProviderCard
        provider={provider}
        onSave={handleSave}
        onTestModel={handleTestModel}
        nameEditable={false}
      />
    );
  }

  window.__modelProviderGeminiFormatFixture = {
    constants: {
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      headerName: HEADER_NAME,
      headerValue: HEADER_VALUE,
    },
    saves,
    probes,
    events,
  };

  createRoot(document.getElementById("root")!).render(
    <ZCodeIntlProvider initialLocale={locale}>
      <ServiceProvider services={services}>
        <TooltipProvider>
          <main className="min-h-dvh bg-background p-4 text-foreground">
            <div className="mx-auto max-w-2xl">
              <Harness />
            </div>
          </main>
        </TooltipProvider>
      </ServiceProvider>
    </ZCodeIntlProvider>,
  );
}
