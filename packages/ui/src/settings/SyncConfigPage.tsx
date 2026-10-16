import { GithubAccountSection } from "@/settings/GithubAccountSection.js";
import { ModelSmartConfigSection } from "@/settings/ModelSmartConfigSection.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 「同步配置」页外壳：上下堆叠两个分区。
 *
 * 分区块标题用 h3 + text-ui-base（DESIGN.md 的 section 标题角色），页面级 h2 仍由 SettingsPage 渲染。
 * 分区一的小标题复用既有的 `settings.modelSmartConfig.title`：那一段内容语义没变，
 * 只是从「页面标题」降级成了「分区标题」，所以不新增 key。
 */
export function SyncConfigPage() {
  const { intl } = useZCodeIntl();

  return (
    <div className="space-y-8" data-testid="sync-config-page">
      <section className="space-y-3">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.modelSmartConfig.title" })}
        </h3>
        <ModelSmartConfigSection />
      </section>

      <section className="space-y-3">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.syncConfig.githubSectionTitle" })}
        </h3>
        <GithubAccountSection />
      </section>
    </div>
  );
}
